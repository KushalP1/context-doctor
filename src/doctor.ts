/**
 * `context-doctor doctor` — self-check for a local installation.
 *
 * Verifies every integration point end to end and prints one ✓/✗/– line per
 * check, so "it doesn't work" becomes a single pasteable diagnosis. Exits 1
 * when any check fails (✗), so a script can tell; an app that is absent, or
 * that nothing was installed into, is a note (–), not a failure.
 */

import { autopilotPaths, DEFAULT_AUTOPILOT_PORT, health, installedVersion, portOccupant, proxyUrl, recentSurfaces } from "./autopilot.js";
import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ledgerPath, readLedger } from "./ledger.js";
import { loadConfig } from "./config.js";
import { codexRouting } from "./codexroute.js";
import { CURSOR_HOOK_EVENTS } from "./install.js";
import { binOnPath, claudeCodeInstallsFromEnv, claudeInstalledCopies, codexMcpEntry, copilotPresent, geminiCliPresent, geminiSettingsPath, isEmptyStub, isOurPluginKey, launcherNamesMissingPackage } from "./install.js";
import { COPILOT_HOOK_EVENT, copilotHookFilePath, copilotLegacyConfigPath, copilotMcpConfigPath, copilotSettingsPath, isOurCopilotEntry, vsCodeUserDirs } from "./copilot.js";
import { describeDesktopUsage, desktopUsage } from "./desktopusage.js";
import { withInvocation } from "./invocation.js";
import { describeInstalls, modelSwitchReadiness, PRE_MODEL_SWITCH_SINCE } from "./modelswitch.js";
import { describeCosts, subagentCostsPath, type SubagentCosts } from "./fanout.js";

function claudeDesktopConfigPath(): string {
  switch (platform()) {
    case "darwin": return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32": return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    default: return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
  }
}

interface Check {
  label: string;
  status: "ok" | "warn" | "fail" | "skip";
  detail: string;
}

/**
 * The verdict on a pre-0.31.2 launcher, `npx -y context-doctor-mcp`. No npm
 * package has that name; npx only falls back to a command of that name on
 * PATH. With a global install that keeps it working (until that install
 * goes); without one npm answers 404 and the app shows no tools, no error.
 */
function missingPackageCheck(label: string): Check {
  return binOnPath("context-doctor-mcp")
    ? { label, status: "warn", detail: "MCP entry runs `npx context-doctor-mcp`, which starts only through your global install (no npm package has that name) — re-run: context-doctor install" }
    : { label, status: "fail", detail: "MCP entry runs `npx context-doctor-mcp`, a package that does not exist on npm, so the server never starts — re-run: context-doctor install" };
}

/** The "not installed" note shared by every app whose config has nothing in it. */
const NOT_INSTALLED = "not installed (no config, or an empty one)";

/**
 * Read a JSON config for a check: undefined when it is absent or an empty
 * stub (`{}`, `{"mcpServers":{}}`, `{"hooks":{}}`), which configure nothing
 * and are what install leaves behind once our entries are removed. Both
 * mean "not installed" for every app alike. Throws on invalid JSON.
 */
function readConfig(path: string, extraKeys: string[] = []): Record<string, any> | undefined {
  if (!existsSync(path)) return undefined;
  const config = JSON.parse(readFileSync(path, "utf8"));
  return isEmptyStub(config, extraKeys) ? undefined : config;
}

function checkMcpEntry(appName: string, configPath: string, plugin = false): Check {
  const viaPlugin: Check = { label: appName, status: "ok", detail: "MCP server provided by the context-doctor plugin" };
  try {
    const config = readConfig(configPath);
    if (!config) {
      return plugin ? viaPlugin : { label: appName, status: "skip", detail: existsSync(configPath) ? NOT_INSTALLED : "app not detected (config file absent)" };
    }
    const entry = config.mcpServers?.["context-doctor"];
    if (!entry && plugin) return viaPlugin;
    if (!entry) return { label: appName, status: "fail", detail: `no context-doctor entry in ${configPath} — run: context-doctor install` };
    if (launcherNamesMissingPackage(entry)) return missingPackageCheck(appName);
    // Absolute-path entries must point at a file that still exists. Launcher
    // forms (npx, and Windows' cmd /c npx) resolve at spawn time, not now.
    const launcher = entry.command === "npx" || entry.command === "cmd";
    const target = launcher ? null : entry.args?.[0];
    if (target && !existsSync(target)) {
      return { label: appName, status: "fail", detail: `MCP entry points at missing file ${target} — re-run: context-doctor install` };
    }
    // Configs written before 0.12 pinned the exact node binary, which a Node
    // upgrade removes; the app then silently loses the tools.
    const cmd = String(entry.command ?? "");
    if (cmd.includes("/") && !existsSync(cmd)) {
      return {
        label: appName,
        status: "fail",
        detail: `MCP command ${cmd} no longer exists (a Node upgrade moves version-pinned paths) — re-run: context-doctor install`,
      };
    }
    return { label: appName, status: "ok", detail: `MCP wired (${launcher ? "npx, tracks npm releases" : "local build"})` };
  } catch (e) {
    return { label: appName, status: "fail", detail: `${configPath} is not valid JSON (${(e as Error).message})` };
  }
}

/**
 * For a hook command, the path that must exist for it to run — or null when it
 * resolves through PATH (`node`, `npx`) and there is nothing to check here.
 *
 * Forms written by install: `node "<cli.js>" hook`, `"<binary>" hook`,
 * `npx -y context-doctor hook`.
 */
function hookBinaryMissing(command: string): string | null {
  const quoted = [...command.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const first = command.trim().split(/\s+/)[0]?.replace(/^"|"$/g, "") ?? "";
  const candidates = quoted.length > 0 ? quoted : /[\\/]/.test(first) ? [first] : [];
  for (const path of candidates) {
    if (!existsSync(path)) return path;
  }
  return null;
}

/**
 * Claude Code's settings files, lowest precedence first: user, project,
 * local. A later file's value for a key wins, as in Claude Code itself.
 */
function claudeSettingsLayers(): Array<Record<string, any>> {
  const paths = [
    join(homedir(), ".claude", "settings.json"),
    join(process.cwd(), ".claude", "settings.json"),
    join(process.cwd(), ".claude", "settings.local.json"),
  ];
  return [...new Set(paths)].flatMap((p) => {
    try {
      return existsSync(p) ? [JSON.parse(readFileSync(p, "utf8")) as Record<string, any>] : [];
    } catch {
      return []; // an unreadable user settings.json is reported by the hook check
    }
  });
}

/**
 * Is the context-doctor plugin enabled? Plugins are switched on with
 * enabledPlugins: {"<plugin>@<marketplace>": true}; ours is named
 * context-doctor in whichever marketplace it came from. A plugin brings its
 * own MCP server and hooks, so neither ~/.claude.json nor settings.json's
 * hooks mention us, and those checks failed on a working plugin install.
 */
function pluginEnabled(layers: Array<Record<string, any>>): boolean {
  const state = new Map<string, boolean>();
  for (const s of layers) {
    for (const [key, on] of Object.entries((s.enabledPlugins ?? {}) as Record<string, unknown>)) {
      if (isOurPluginKey(key)) state.set(key, on === true);
    }
  }
  return [...state.values()].some(Boolean);
}

/** "headroom (pid 4242)", or "another program". */
function occupantName(o: { name?: string; pid?: number }): string {
  return `${o.name ?? "another program"}${o.pid ? ` (pid ${o.pid})` : ""}`;
}

/**
 * The subagent price (PreToolUse on the Agent tool, fanout.ts): registered
 * with a matcher that names the tool by both its names, and what the medians
 * it quotes come from.
 */
function fanoutCheck(settings: Record<string, any>, plugin: boolean): Check {
  const label = "Subagent price";
  const entries: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> = Array.isArray(settings.hooks?.PreToolUse) ? settings.hooks.PreToolUse : [];
  const ours = entries.find((e) => /context-doctor|cli\.js"?\s+hook/.test(e.hooks?.[0]?.command ?? ""));
  let costs: SubagentCosts | undefined;
  try { costs = JSON.parse(readFileSync(subagentCostsPath(), "utf8")); } catch { /* not measured yet */ }
  const basis = costs?.all ? `; quotes your medians (${describeCosts(costs)})` : "; quotes your medians once you have run a few subagents";
  if (ours && !/\bAgent\b/.test(ours.matcher ?? "")) return { label, status: "warn", detail: `PreToolUse entry without the Agent matcher (${JSON.stringify(ours.matcher ?? "")}): it runs before every tool; re-run context-doctor install` };
  if (ours) return { label, status: "ok", detail: `PreToolUse on the Agent tool: before a subagent starts, its price at your median and the Sonnet option; never blocks${basis}` };
  if (plugin) return { label, status: "ok", detail: `PreToolUse: provided by the context-doctor plugin${basis}` };
  return { label, status: "warn", detail: "not registered: subagents start with no price shown; run context-doctor install" };
}

/**
 * The model-switch warning (PreModelSwitch). Its entry in settings.json is a
 * failure next to a Claude Code older than the event: that version skips the
 * whole file, every other setting and hook with it.
 */
function modelSwitchCheck(settings: Record<string, any>, plugin: boolean): Check {
  const label = "Model-switch warning";
  const entries: Array<{ hooks?: Array<{ command?: string }> }> = settings.hooks?.PreModelSwitch ?? [];
  const ours = entries.some((e) => /context-doctor|cli\.js"?\s+hook/.test(e.hooks?.[0]?.command ?? ""));
  const readiness = modelSwitchReadiness(claudeCodeInstallsFromEnv());
  if (Array.isArray(settings.hooks?.PreModelSwitch) && readiness.old.length > 0) {
    return {
      label,
      status: "fail",
      detail: `~/.claude/settings.json has a PreModelSwitch hook${ours ? "" : " (not ours)"}, and ${describeInstalls(readiness.old)} predates that event (${PRE_MODEL_SWITCH_SINCE}): it skips the whole file, every setting and hook in it. Update that Claude Code, or ${ours ? "run context-doctor install (it takes ours out)" : "remove the entry"}`,
    };
  }
  if (ours) return { label, status: "ok", detail: "PreModelSwitch: before a model switch, the price of re-writing the context into the new model's cache" };
  if (plugin) {
    return readiness.old.length > 0
      ? { label, status: "skip", detail: `the plugin carries it, but ${describeInstalls(readiness.old)} predates PreModelSwitch (${PRE_MODEL_SWITCH_SINCE}) and drops it` }
      : { label, status: "ok", detail: "PreModelSwitch: provided by the context-doctor plugin" };
  }
  if (readiness.old.length > 0) return { label, status: "skip", detail: `not installed: ${describeInstalls(readiness.old)} predates PreModelSwitch (${PRE_MODEL_SWITCH_SINCE}); update it, then run context-doctor install` };
  if (!readiness.ok) return { label, status: "skip", detail: `not installed: no Claude Code version found to check (needs ${PRE_MODEL_SWITCH_SINCE})` };
  return { label, status: "warn", detail: "not registered: model switches re-write the whole context into the new model's cache unannounced; run context-doctor install" };
}

/**
 * Devin (Cognition): the Devin CLI, and Devin Desktop (formerly Windsurf).
 * Checked against docs.devin.ai (2026-10-20): the CLI runs hooks from
 * ~/.claude/settings.json in Claude Code's format while its
 * `read_config_from.claude` is on (the default), with session_id and
 * prompt_id but no transcript_path in the input; the desktop app's Cascade
 * hooks (~/.codeium/windsurf/hooks.json) pass a transcript only to
 * post_cascade_response_with_transcript. So in Devin our hook runs (CLI) or
 * does not (Desktop) and has no transcript to measure either way: say that,
 * rather than nothing or a false "ok".
 */
export function devinCheck(home = homedir()): Check {
  const label = "Devin";
  const app = [join("/Applications", "Devin.app"), join(home, "Applications", "Devin.app"), join(home, "Library", "Application Support", "Devin"), join(home, ".devin")].find((p) => existsSync(p));
  const cliConfig = join(home, ".config", "devin", "config.json");
  const cli = binOnPath("devin") || existsSync(join(home, ".local", "bin", "devin")) || existsSync(cliConfig);
  if (!app && !cli) return { label, status: "skip", detail: "not detected (Devin CLI or Devin Desktop)" };
  const parts: string[] = [];
  if (cli) {
    let readsClaude = true;
    try {
      const config = JSON.parse(readFileSync(cliConfig, "utf8"));
      if (config?.read_config_from?.claude === false) readsClaude = false;
    } catch {
      /* no config: the default, which reads ~/.claude */
    }
    parts.push(
      readsClaude
        ? "Devin CLI runs the hooks in ~/.claude/settings.json (read_config_from.claude, on by default), so the every-prompt hook runs there too, but Devin gives hooks no transcript path, so it stays silent"
        : "Devin CLI found with read_config_from.claude off: it runs none of the hooks in ~/.claude/settings.json"
    );
  }
  if (app) parts.push(`Devin Desktop found (${app.replace(home, "~")}): its Cascade hooks pass a transcript to one event only, after a response, too late to steer it`);
  return { label, status: "skip", detail: `${parts.join("; ")}. Not supported yet; the MCP tools work in any MCP client` };
}

/** "~/..." for a path under the home directory. */
function tilde(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

/**
 * The Copilot session-start hook: registered, its command resolves, hooks
 * not switched off, and when it last ran (from the ledger, when there is one).
 * What it does not do is said too: no size checks, since Copilot passes a
 * transcript only to hooks that cannot add context.
 */
function copilotHookCheck(mcp: Check, missingHook: (label: string, app: Check) => Check): Check {
  const label = "Copilot hook";
  const path = copilotHookFilePath();
  let config: Record<string, any> | undefined;
  try {
    config = readConfig(path, ["version"]);
  } catch (e) {
    return { label, status: "fail", detail: `${tilde(path)} is not valid JSON (${(e as Error).message}); Copilot skips it` };
  }
  if (config !== undefined && (typeof config !== "object" || Array.isArray(config))) return { label, status: "fail", detail: `${tilde(path)} is not a JSON object; Copilot skips it — delete it and re-run: context-doctor install` };
  const entry = ((Array.isArray(config?.hooks?.[COPILOT_HOOK_EVENT]) ? config!.hooks[COPILOT_HOOK_EVENT] : []) as unknown[]).find(isOurCopilotEntry) as { command?: string } | undefined;
  if (!entry) return missingHook(label, mcp);
  // The runtime loads no hooks at all from a file whose version is not 1.
  if (config?.version !== 1) return { label, status: "fail", detail: `${tilde(path)} says "version": ${JSON.stringify(config?.version)}, and Copilot loads hooks only from version 1 files: set it to 1` };
  const missing = hookBinaryMissing(String(entry.command ?? ""));
  if (missing) return { label, status: "fail", detail: `registered, but ${missing} no longer exists — re-run: context-doctor install` };
  // disableAllHooks in the hook file, settings.json, or the older config.json.
  const off = [path, copilotSettingsPath(), copilotLegacyConfigPath()].find((p) => {
    if (p === path) return config?.disableAllHooks === true;
    try {
      return JSON.parse(readFileSync(p, "utf8"))?.disableAllHooks === true;
    } catch {
      return false; // absent or unreadable: hooks stay on
    }
  });
  if (off) return { label, status: "fail", detail: `registered, but disableAllHooks is true in ${tilde(off)}, so Copilot runs no hooks` };
  // The rules name the MCP tools: without the server they point at nothing.
  if (mcp.status !== "ok") return { label, status: "warn", detail: `sessionStart in ${tilde(path)} adds the standing rules, which name context-doctor's MCP tools, but the MCP server is not wired (above): re-run context-doctor install` };
  const last = readLedger().filter((e) => e.ev === "session_rules" && e.app === "copilot").pop();
  const ran = last ? ` Last ran ${new Date(last.ts).toISOString().slice(0, 16).replace("T", " ")}.` : "";
  return {
    label,
    status: "ok",
    detail: `sessionStart in ${tilde(path)}: each new or resumed Copilot session gets the standing context rules.${ran} No size checks there: Copilot gives a transcript only to hooks that cannot add context`,
  };
}

/**
 * VS Code forwards the servers in its own user mcp.json into Copilot
 * sessions, beside ~/.copilot/mcp-config.json. One that also starts
 * context-doctor, under any name, can load the tools twice. VS Code's file
 * may hold comments, so it is searched as text when it does not parse.
 */
function vsCodeDuplicateCheck(): Check | undefined {
  for (const dir of vsCodeUserDirs()) {
    const path = join(dir, "mcp.json");
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (!raw.includes("context-doctor")) continue;
    let names: string[] = [];
    try {
      const servers = JSON.parse(raw)?.servers ?? {};
      names = Object.entries(servers as Record<string, unknown>).filter(([, v]) => JSON.stringify(v).includes("context-doctor")).map(([k]) => k);
    } catch { /* JSONC: the text search above is the evidence */ }
    return {
      label: "Copilot MCP",
      status: "warn",
      detail: `VS Code's ${tilde(path)} also starts context-doctor${names.length ? ` (as ${names.map((n) => `"${n}"`).join(", ")})` : ""}; VS Code forwards it into Copilot sessions beside ${tilde(copilotMcpConfigPath())}, so the tools can load twice: remove one`,
    };
  }
  return undefined;
}

/** Claude Code's disableAllHooks: when true, no hook of anyone's runs. */
function hooksDisabled(layers: Array<Record<string, any>>): boolean {
  return layers.reduce<boolean>((off, s) => (typeof s.disableAllHooks === "boolean" ? s.disableAllHooks : off), false);
}

/** Spawn our own MCP server and run the initialize handshake over stdio. */
function checkMcpHandshake(): Promise<Check> {
  const label = "MCP server handshake";
  const mcpPath = join(dirname(fileURLToPath(import.meta.url)), "mcp.js");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [mcpPath], { stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ label, status: "fail", detail: "no initialize response within 5s" });
    }, 5000);
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      if (out.includes("\n")) {
        clearTimeout(timer);
        child.kill();
        try {
          const reply = JSON.parse(out.split("\n")[0]);
          const version = reply.result?.serverInfo?.version;
          const hasInstructions = typeof reply.result?.instructions === "string" && reply.result.instructions.length > 0;
          resolve(
            version && hasInstructions
              ? { label, status: "ok", detail: `v${version} responds; standing instructions present` }
              : { label, status: "fail", detail: "handshake reply missing serverInfo/instructions" }
          );
        } catch {
          resolve({ label, status: "fail", detail: "unparseable handshake reply" });
        }
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ label, status: "fail", detail: e.message });
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "doctor", version: "1" } } }) + "\n"
    );
  });
}

export async function runDoctor(): Promise<void> {
  const checks: Check[] = [];

  checks.push(checkMcpEntry("Claude Desktop", claudeDesktopConfigPath()));
  // Desktop chat has no hook or transcript; its own logs are the only evidence the tools are used.
  const desktop = desktopUsage();
  if (desktop) checks.push({ label: "Desktop chat tool use", status: "ok", detail: describeDesktopUsage(desktop, recentSurfaces(7).get("claude-desktop") ?? 0) });
  const layers = claudeSettingsLayers();
  const plugin = pluginEnabled(layers);
  const claudeMcp = checkMcpEntry("Claude Code", join(homedir(), ".claude.json"), plugin);
  const cursorMcp = checkMcpEntry("Cursor", join(homedir(), ".cursor", "mcp.json"));
  checks.push(claudeMcp, cursorMcp);
  // A missing hook is an issue only for an app that is there to hook: when
  // the app's own MCP check says it is absent or holds nothing of ours, the
  // hook is "not installed" too, not a failure.
  const missingHook = (label: string, app: Check): Check =>
    app.status === "skip"
      ? { label, status: "skip", detail: "not installed (nor is the MCP server, above)" }
      : { label, status: "fail", detail: "not registered — run: context-doctor install" };

  // Hook registration. ~/.claude without a settings.json is Claude Code with
  // no hook registered, not Claude Code absent.
  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (existsSync(settingsPath) || existsSync(join(homedir(), ".claude"))) {
    try {
      const settings = readConfig(settingsPath) ?? {};
      const entries: Array<{ hooks?: Array<{ command?: string }> }> = settings.hooks?.UserPromptSubmit ?? [];
      const ours = entries.map((e) => e.hooks?.[0]?.command ?? "").find((c) => /context-doctor|cli\.js"?\s+hook/.test(c));
      if (hooksDisabled(layers)) {
        // Registered or not, nothing runs: say that first, it is the fix.
        checks.push({
          label: "Every-prompt hook",
          status: "fail",
          detail: `${ours || plugin ? "registered" : "not registered"}, and disableAllHooks is true in Claude Code's settings, so Claude Code runs no hooks at all; remove that setting${ours || plugin ? "" : ", then run: context-doctor install"}`,
        });
      } else if (!ours && plugin) {
        checks.push({ label: "Every-prompt hook", status: "ok", detail: "provided by the context-doctor plugin" });
        checks.push({ label: "Compaction hook", status: "ok", detail: "PreCompact: provided by the context-doctor plugin" });
        checks.push(fanoutCheck(settings, plugin));
      } else if (!ours) {
        checks.push(missingHook("Every-prompt hook", claudeMcp));
      } else {
        // "Registered" is not "working": a hook whose binary has been deleted
        // (an npx cache sweep, a Node upgrade) fails silently on every prompt,
        // and this check used to report it as fine.
        const missing = hookBinaryMissing(ours);
        checks.push(
          missing
            ? { label: "Every-prompt hook", status: "fail", detail: `registered, but ${missing} no longer exists — re-run: context-doctor install` }
            : { label: "Every-prompt hook", status: "ok", detail: "registered in ~/.claude/settings.json; command resolves" }
        );
        const pre: Array<{ hooks?: Array<{ command?: string }> }> = settings.hooks?.PreCompact ?? [];
        const preOurs = plugin || pre.some((e) => /context-doctor|cli\.js"?\s+hook/.test(e.hooks?.[0]?.command ?? ""));
        checks.push(
          preOurs
            ? { label: "Compaction hook", status: "ok", detail: "PreCompact: each compaction's summary keeps the session's files, open tasks, your instructions and failing commands" }
            : { label: "Compaction hook", status: "warn", detail: "not registered: compactions use generic instructions; run context-doctor install" }
        );
        checks.push(fanoutCheck(settings, plugin));
      }
      checks.push(modelSwitchCheck(settings, plugin));
    } catch (e) {
      checks.push({ label: "Every-prompt hook", status: "fail", detail: `settings.json unreadable (${(e as Error).message})` });
    }
  } else {
    checks.push({ label: "Every-prompt hook", status: "skip", detail: "Claude Code not detected" });
  }

  // Plugin AND install: Claude Code then starts our MCP server twice (its
  // instructions and tools load twice) and runs the hook twice.
  const copies = plugin ? claudeInstalledCopies() : [];
  if (copies.length > 0) {
    checks.push({
      label: "Plugin + install",
      status: "warn",
      detail:
        `the context-doctor plugin is enabled and \`install\` also wired Claude Code (${copies.join(", ")}), so its instructions and tools load twice. ` +
        "Keep one: `context-doctor uninstall` removes the installed copy (then `context-doctor install` re-wires other apps and skips Claude Code while the plugin is on), or disable the plugin",
    });
  }

  // Codex (OpenAI): MCP table in config.toml, hook in hooks.json, skill.
  const codexHome = join(homedir(), ".codex");
  if (existsSync(codexHome)) {
    const toml = existsSync(join(codexHome, "config.toml")) ? readFileSync(join(codexHome, "config.toml"), "utf8") : "";
    // Parsed rather than searched for one exact header: a quoted key or a
    // trailing comment is the same table to Codex.
    const codexEntry = codexMcpEntry(toml);
    // An absent or empty config.toml is "not installed", as for every other app.
    const codexMcp: Check = !codexEntry
      ? toml.trim() === ""
        ? { label: "Codex MCP", status: "skip", detail: NOT_INSTALLED }
        : { label: "Codex MCP", status: "fail", detail: "Codex detected but not wired — run: context-doctor install" }
      : launcherNamesMissingPackage(codexEntry)
        ? missingPackageCheck("Codex MCP")
        : { label: "Codex MCP", status: "ok", detail: "wired in ~/.codex/config.toml" };
    checks.push(codexMcp);
    try {
      const hooksPath = join(codexHome, "hooks.json");
      const hooks = readConfig(hooksPath) ?? {};
      const entries: Array<{ hooks?: Array<{ command?: string }> }> = hooks.hooks?.UserPromptSubmit ?? [];
      const ours = entries.map((e) => e.hooks?.[0]?.command ?? "").find((c) => /context-doctor|cli\.js"?\s+hook/.test(c));
      if (!ours) {
        checks.push(missingHook("Codex hook", codexMcp));
      } else {
        const missing = hookBinaryMissing(ours);
        checks.push(
          missing
            ? { label: "Codex hook", status: "fail", detail: `registered, but ${missing} no longer exists — re-run: context-doctor install` }
            : { label: "Codex hook", status: "ok", detail: "registered in ~/.codex/hooks.json (Codex must trust it once: /hooks)" }
        );
      }
    } catch (e) {
      checks.push({ label: "Codex hook", status: "fail", detail: `~/.codex/hooks.json unreadable (${(e as Error).message})` });
    }
    // Autopilot reaches Codex through openai_base_url (OPENAI_BASE_URL no
    // longer routes it), and only on an API key.
    const route = codexRouting(homedir());
    const local = route.baseUrl && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/v1\/?$/.test(route.baseUrl);
    if (local && route.auth !== "apikey") {
      checks.push({ label: "Codex autopilot", status: "warn", detail: `openai_base_url points at ${route.baseUrl} while Codex signs in ${route.auth === "chatgpt" ? "with ChatGPT" : "without an API key"}: autopilot routes Codex only on an API key (the proxy relays ChatGPT traffic unedited meanwhile); remove the line from ~/.codex/config.toml` });
    } else if (local) {
      checks.push({ label: "Codex autopilot", status: "ok", detail: `Codex (API key) sends its requests through ${route.baseUrl}` });
    } else if (process.env.OPENAI_BASE_URL && route.auth === "apikey") {
      checks.push({ label: "Codex autopilot", status: "warn", detail: "OPENAI_BASE_URL is set, but Codex no longer reads it: `context-doctor autopilot on` sets openai_base_url in ~/.codex/config.toml" });
    }
  } else {
    checks.push({ label: "Codex", status: "skip", detail: "not detected (ChatGPT's Codex agent, IDE extension or CLI)" });
  }

  // Gemini CLI: MCP server and the BeforeAgent hook, both in ~/.gemini/settings.json.
  if (geminiCliPresent()) {
    try {
      const path = geminiSettingsPath();
      const read = readConfig(path);
      const settings = read ?? {};
      const geminiEntry = settings.mcpServers?.["context-doctor"];
      const geminiMcp: Check = !geminiEntry
        ? read === undefined
          ? { label: "Gemini CLI MCP", status: "skip", detail: NOT_INSTALLED }
          : { label: "Gemini CLI MCP", status: "fail", detail: "Gemini CLI detected but not wired — run: context-doctor install" }
        : launcherNamesMissingPackage(geminiEntry)
          ? missingPackageCheck("Gemini CLI MCP")
          : { label: "Gemini CLI MCP", status: "ok", detail: "wired in ~/.gemini/settings.json" };
      checks.push(geminiMcp);
      const entries: Array<{ hooks?: Array<{ command?: string }> }> = settings.hooks?.BeforeAgent ?? [];
      const ours = entries.map((e) => e.hooks?.[0]?.command ?? "").find((c) => /context-doctor|cli\.js"?\s+hook/.test(c));
      const missing = ours ? hookBinaryMissing(ours) : undefined;
      checks.push(
        !ours
          ? missingHook("Gemini CLI hook", geminiMcp)
          : missing
            ? { label: "Gemini CLI hook", status: "fail", detail: `registered, but ${missing} no longer exists — re-run: context-doctor install` }
            : settings.hooksConfig?.enabled === false
              ? { label: "Gemini CLI hook", status: "fail", detail: "registered, but hooksConfig.enabled is false in ~/.gemini/settings.json" }
              : { label: "Gemini CLI hook", status: "ok", detail: "BeforeAgent hook in ~/.gemini/settings.json" }
      );
    } catch (e) {
      checks.push({ label: "Gemini CLI", status: "fail", detail: `~/.gemini/settings.json unreadable (${(e as Error).message})` });
    }
  } else {
    checks.push({ label: "Gemini CLI", status: "skip", detail: "not detected" });
  }

  checks.push(devinCheck());

  // GitHub Copilot (CLI, app, VS Code): MCP in ~/.copilot/mcp-config.json,
  // the sessionStart hook in a hook file of our own.
  if (copilotPresent()) {
    const mcpPath = copilotMcpConfigPath();
    let copilotMcp: Check;
    try {
      copilotMcp = readConfig(mcpPath) === undefined
        ? { label: "Copilot MCP", status: "skip", detail: NOT_INSTALLED }
        : checkMcpEntry("Copilot MCP", mcpPath);
    } catch (e) {
      copilotMcp = { label: "Copilot MCP", status: "fail", detail: `${tilde(mcpPath)} is not valid JSON (${(e as Error).message})` };
    }
    if (copilotMcp.status === "ok") copilotMcp.detail += ` in ${tilde(mcpPath)} (Copilot CLI, the Copilot app and VS Code's Copilot sessions)`;
    checks.push(copilotMcp);
    const duplicate = copilotMcp.status === "ok" ? vsCodeDuplicateCheck() : undefined;
    if (duplicate) checks.push(duplicate);
    checks.push(copilotHookCheck(copilotMcp, missingHook));
  } else {
    checks.push({ label: "GitHub Copilot", status: "skip", detail: "not detected (Copilot CLI, the GitHub Copilot app, or VS Code)" });
  }

  // Cursor: its agent gets the guidance through native hooks (the Claude
  // Code hook it also runs cannot add context there). Whether the text then
  // reaches the model depends on the Cursor version, and Cursor logs only
  // that the hook ran, so this says what is known rather than "✓".
  if (existsSync(join(homedir(), ".cursor"))) {
    const hooksPath = join(homedir(), ".cursor", "hooks.json");
    try {
      const hooks = readConfig(hooksPath, ["version"]) ?? {};
      const oursIn = (event: string) => ((hooks.hooks?.[event] ?? []) as Array<{ command?: string }>).map((e) => e.command ?? "").find((c) => /(cli\.js|context-doctor(\.cmd|\.exe|\.bat)?)"?\s+hook\s*$/.test(c));
      const ours = oursIn("postToolUse");
      const missing = ours ? hookBinaryMissing(ours) : undefined;
      const fallbacks = CURSOR_HOOK_EVENTS.filter((e) => !oursIn(e));
      if (!ours) checks.push(missingHook("Cursor hook", cursorMcp));
      else if (missing) checks.push({ label: "Cursor hook", status: "fail", detail: `registered, but ${missing} no longer exists — re-run: context-doctor install` });
      else {
        const v = cursorVersion();
        const delivered = v ? versionAtLeast(v, 3, 17) : undefined;
        const where = `registered in ~/.cursor/hooks.json for ${CURSOR_HOOK_EVENTS.filter((e) => oursIn(e)).join(", ")}`;
        checks.push(
          delivered === false
            ? { label: "Cursor hook", status: "warn", detail: `${where}, but Cursor ${v} drops hook additional_context before the model (confirmed by Cursor staff, March 2026; reported through 3.10): update Cursor to 3.17 or later; until then the MCP tools are the way in` }
            : fallbacks.length
              ? { label: "Cursor hook", status: "warn", detail: `${where}; re-run context-doctor install to add ${fallbacks.join(" and ")} (the fallbacks Cursor 3.17+ delivers)` }
              : { label: "Cursor hook", status: "ok", detail: `${where}. ${v ? `Cursor ${v}` : "Cursor 3.17 and later"} attaches their additional_context to the tool result; Cursor does not log what the model saw: in a long chat, ask its agent what context-doctor said` }
        );
      }
    } catch (e) {
      checks.push({ label: "Cursor hook", status: "fail", detail: `~/.cursor/hooks.json unreadable (${(e as Error).message})` });
    }
  }

  // Status line (opt-in, so absence is a note, not a failure)
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const cmd = settings.statusLine?.command as string | undefined;
      if (cmd && /context-doctor|cli\.js"?\s+statusline/.test(cmd)) {
        const missing = hookBinaryMissing(cmd);
        checks.push(
          missing
            ? { label: "Status line", status: "fail", detail: `configured, but ${missing} no longer exists — re-run: context-doctor install --statusline` }
            : hooksDisabled(layers)
              ? { label: "Status line", status: "fail", detail: "configured, but disableAllHooks also turns off custom status lines" }
              : { label: "Status line", status: "ok", detail: "live context in Claude Code's status bar" }
        );
      } else {
        checks.push({ label: "Status line", status: "skip", detail: cmd ? "you have your own statusLine (left alone)" : "not enabled (optional: context-doctor install --statusline)" });
      }
    } catch {
      /* settings.json unreadable is already reported by the hook check */
    }
  }

  // Skill
  const skillPath = join(homedir(), ".claude", "skills", "context-doctor", "SKILL.md");
  checks.push(
    existsSync(skillPath)
      ? { label: "Agent Skill", status: "ok", detail: skillPath }
      : { label: "Agent Skill", status: "skip", detail: "not installed (run context-doctor install on a Claude Code machine)" }
  );

  // Ledger writable. Tested without writing an entry: recordLedger swallows
  // errors (so this could never fail), and the entry it wrote counted as a
  // hook check in every report.
  // Nor by creating its directory: doctor making ~/.claude on a machine
  // without Claude Code made the next install and doctor see Claude Code.
  try {
    const lp = ledgerPath();
    let dir = dirname(lp);
    while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
    accessSync(existsSync(lp) ? lp : dir, fsConstants.W_OK);
    checks.push({ label: "Ledger", status: "ok", detail: `writable at ${lp}` });
  } catch {
    checks.push({ label: "Ledger", status: "fail", detail: `cannot write ${ledgerPath()}` });
  }

  // Project config: a setting that is silently ignored looks exactly like the
  // feature being broken, so name it here rather than leaving it to be guessed.
  const loaded = loadConfig(process.cwd());
  if (loaded.path && loaded.error) {
    // A file with a typo used to read as "no .contextdoctorrc": the budget the
    // user wrote is silently not in force, which is the case worth naming.
    checks.push({ label: "Project config", status: "fail", detail: `${loaded.path} cannot be read (${loaded.error}): every setting in it is ignored until it parses as a JSON object` });
  } else if (loaded.path) {
    const warnings = loaded.warnings ?? [];
    checks.push(
      warnings.length === 0
        ? { label: "Project config", status: "ok", detail: `${loaded.path} — all settings understood` }
        : { label: "Project config", status: "fail", detail: `${warnings.length} setting(s) will be ignored:\n` + warnings.map((w) => `    ${w}`).join("\n") }
    );
  } else {
    checks.push({ label: "Project config", status: "skip", detail: "no .contextdoctorrc (optional; create one with: context-doctor init <preset>)" });
  }

  checks.push(await checkMcpHandshake());

  // Autopilot: optional, so "off" is a skip, not a failure. When it is on, a
  // dead proxy or a settings file pointing elsewhere is a real problem.
  {
    const paths = autopilotPaths();
    // A truncated file used to throw at JSON.parse here, before a single line
    // of the report was printed: one damaged file hid every other check.
    let cfg: { port: number; cli?: string } | undefined;
    let damage = "";
    if (existsSync(paths.config)) {
      try {
        const parsed = JSON.parse(readFileSync(paths.config, "utf8"));
        if (typeof parsed?.port === "number") cfg = parsed;
        else damage = "no port in it";
      } catch (e) {
        damage = (e as Error).message;
      }
    }
    if (!existsSync(paths.config)) {
      checks.push({ label: "Autopilot", status: "skip", detail: "off (context-doctor autopilot on: clears stale tool output in every new Claude Code session)" });
      // Another local proxy on autopilot's port: `autopilot on` would not start there.
      const other = await portOccupant(DEFAULT_AUTOPILOT_PORT);
      if (other.listening && !other.ours) {
        checks.push({
          label: "Autopilot port",
          status: "warn",
          detail: other.bindable
            ? `${occupantName(other)} listens on port ${DEFAULT_AUTOPILOT_PORT} on another address: \`autopilot on\` would start beside it on 127.0.0.1 and take the traffic sent to 127.0.0.1 (Claude Code's), while apps that use localhost:${DEFAULT_AUTOPILOT_PORT} may reach ${occupantName(other)}; to keep them apart: context-doctor autopilot on --port 8788`
            : `${occupantName(other)} already listens on ${proxyUrl(DEFAULT_AUTOPILOT_PORT)}: \`autopilot on\` could not start there; use another port (context-doctor autopilot on --port 8788)`,
        });
      } else if (other.onIpv6Loopback) {
        checks.push({ label: "Autopilot port", status: "warn", detail: `${other.onIpv6Loopback} listens on [::1]:${DEFAULT_AUTOPILOT_PORT}: apps that use localhost:${DEFAULT_AUTOPILOT_PORT} may reach it instead of autopilot, which uses 127.0.0.1` });
      }
    } else if (!cfg) {
      let routedTo: string | undefined;
      try { routedTo = JSON.parse(readFileSync(paths.settings, "utf8"))?.env?.ANTHROPIC_BASE_URL; } catch { /* reported by the hook check */ }
      checks.push({
        label: "Autopilot",
        status: "fail",
        detail:
          `${paths.config} is damaged (${damage}). Run: context-doctor autopilot off` +
          (routedTo ? `, then remove env.ANTHROPIC_BASE_URL (${routedTo}) from ~/.claude/settings.json if it is the proxy` : "") +
          "; autopilot on starts it again cleanly",
      });
    } else {
      const installed = typeof cfg.cli === "string" ? installedVersion(cfg.cli) : undefined;
      const h = await health(cfg.port);
      let routed = false;
      try { routed = JSON.parse(readFileSync(paths.settings, "utf8"))?.env?.ANTHROPIC_BASE_URL === proxyUrl(cfg.port); } catch { /* reported below */ }
      const paused = existsSync(paths.pauseFile);
      // Routed in settings is not the same as reached: the desktop app ignores it.
      let seen = -1;
      try {
        const st = (await fetch(`${proxyUrl(cfg.port)}/stats`, { signal: AbortSignal.timeout(800) }).then((r) => r.json())) as { autopilot?: { requests: number } };
        seen = st.autopilot?.requests ?? -1;
      } catch { /* stats are best effort */ }
      const surfaces = recentSurfaces(7);
      const known = [...surfaces.keys()].filter((ep) => ep !== "unknown");
      const desktopOnly = known.length > 0 && known.every((ep) => ep.startsWith("claude-desktop"));
      checks.push(
        h.ok && h.autopilot && routed && seen === 0 && desktopOnly
          ? { label: "Autopilot", status: "warn", detail: "running, but it has seen 0 requests: your recent Claude Code sessions all ran in the desktop app, which ignores settings.json's API address. Autopilot only reaches terminal and IDE sessions; for desktop ones, see `context-doctor compact-window`" }
          : h.ok && h.autopilot && routed && h.version && installed && h.version !== installed
          ? { label: "Autopilot", status: "warn", detail: `proxy is running v${h.version} but v${installed} is installed; the next Claude Code prompt restarts it, or run: context-doctor autopilot on` }
          : h.ok && h.autopilot && routed
          ? { label: "Autopilot", status: "ok", detail: `proxy up on ${proxyUrl(cfg.port)}, Claude Code routed through it${seen >= 0 ? ` (${seen} requests since start)` : ""}${paused ? " (PAUSED: passthrough)" : ""}` }
          : { label: "Autopilot", status: "fail", detail: !h.ok ? `proxy not answering on ${proxyUrl(cfg.port)}: the next Claude Code prompt restarts it; or run: context-doctor autopilot on` : "settings.json no longer routes Claude Code to the proxy: run context-doctor autopilot on" }
      );
      // Not ours, yet listening on our port: with Claude Code routed there,
      // its requests go through that program, and the proxy cannot restart.
      const other = await portOccupant(cfg.port);
      if (!h.ok && other.listening && !other.ours) {
        checks.push({
          label: "Autopilot port",
          status: "fail",
          detail: `${occupantName(other)} answers on ${proxyUrl(cfg.port)} instead of the proxy${routed ? ", and Claude Code's requests go to it" : ""}${other.bindable ? " (the proxy can start beside it on 127.0.0.1: the next Claude Code prompt restarts it)" : ""}: stop it, or move autopilot (context-doctor autopilot off, then autopilot on --port 8788)`,
        });
      } else if (other.onIpv6Loopback) {
        checks.push({ label: "Autopilot port", status: "warn", detail: `${other.onIpv6Loopback} listens on [::1]:${cfg.port}: Claude Code reaches autopilot at 127.0.0.1, but apps that use localhost:${cfg.port} may reach ${other.onIpv6Loopback} instead` });
      }
    }
  }

  const mark = { ok: "✓", warn: "!", fail: "✗", skip: "–" } as const;
  console.log("CONTEXT DOCTOR — self-check");
  console.log("═".repeat(56));
  // Fix hints name `context-doctor <command>`; after an npx run, `npx context-doctor <command>`.
  for (const c of checks) {
    console.log(withInvocation(`${mark[c.status]} ${c.label.padEnd(22)} ${c.detail}`));
  }
  const fails = checks.filter((c) => c.status === "fail");
  const warns = checks.filter((c) => c.status === "warn");
  if (fails.length > 0) process.exitCode = 1;
  console.log("");
  console.log(
    fails.length > 0
      ? `${fails.length} issue(s) found — fixes suggested above.`
      : warns.length > 0
        ? `No problems; ${warns.length} note(s) marked ! above.`
        : "All good."
  );
}

/** "3.18.25" >= major.minor. */
function versionAtLeast(v: string, major: number, minor: number): boolean {
  const m = /^(\d+)\.(\d+)/.exec(v);
  if (!m) return true;
  return Number(m[1]) > major || (Number(m[1]) === major && Number(m[2]) >= minor);
}

/**
 * The Cursor version here: the newest one that ran the hook (its input
 * carries cursor_version, on every platform), else the macOS app bundle.
 */
export function cursorVersion(): string | undefined {
  const fromLedger = readLedger().reverse().find((e) => typeof e.cv === "string")?.cv;
  if (fromLedger) return fromLedger;
  for (const plist of ["/Applications/Cursor.app/Contents/Info.plist", join(homedir(), "Applications", "Cursor.app", "Contents", "Info.plist")]) {
    try {
      const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(plist, "utf8"));
      if (m) return m[1];
    } catch { /* not there */ }
  }
  return undefined;
}
