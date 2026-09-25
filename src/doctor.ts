/**
 * `context-doctor doctor` — self-check for a local installation.
 *
 * Verifies every integration point end to end and prints one ✓/✗/– line per
 * check, so "it doesn't work" becomes a single pasteable diagnosis. Always
 * exits 0 — absence of an app is a note, not a failure.
 */

import { autopilotPaths, health, proxyUrl } from "./autopilot.js";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ledgerPath, recordLedger } from "./ledger.js";
import { loadConfig } from "./config.js";

function claudeDesktopConfigPath(): string {
  switch (platform()) {
    case "darwin": return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32": return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    default: return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
  }
}

interface Check {
  label: string;
  status: "ok" | "fail" | "skip";
  detail: string;
}

function checkMcpEntry(appName: string, configPath: string): Check {
  if (!existsSync(configPath)) return { label: appName, status: "skip", detail: "app not detected (config file absent)" };
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const entry = config.mcpServers?.["context-doctor"];
    if (!entry) return { label: appName, status: "fail", detail: `no context-doctor entry in ${configPath} — run: context-doctor install` };
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
  checks.push(checkMcpEntry("Claude Code", join(homedir(), ".claude.json")));
  checks.push(checkMcpEntry("Cursor", join(homedir(), ".cursor", "mcp.json")));

  // Hook registration
  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const entries: Array<{ hooks?: Array<{ command?: string }> }> = settings.hooks?.UserPromptSubmit ?? [];
      const ours = entries.map((e) => e.hooks?.[0]?.command ?? "").find((c) => /context-doctor|cli\.js"?\s+hook/.test(c));
      if (!ours) {
        checks.push({ label: "Every-prompt hook", status: "fail", detail: "not registered — run: context-doctor install" });
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
      }
    } catch (e) {
      checks.push({ label: "Every-prompt hook", status: "fail", detail: `settings.json unreadable (${(e as Error).message})` });
    }
  } else {
    checks.push({ label: "Every-prompt hook", status: "skip", detail: "Claude Code not detected" });
  }

  // Codex (OpenAI): MCP table in config.toml, hook in hooks.json, skill.
  const codexHome = join(homedir(), ".codex");
  if (existsSync(codexHome)) {
    const toml = existsSync(join(codexHome, "config.toml")) ? readFileSync(join(codexHome, "config.toml"), "utf8") : "";
    checks.push(
      toml.includes("[mcp_servers.context-doctor]")
        ? { label: "Codex MCP", status: "ok", detail: "wired in ~/.codex/config.toml" }
        : { label: "Codex MCP", status: "fail", detail: "Codex detected but not wired — run: context-doctor install" }
    );
    try {
      const hooksPath = join(codexHome, "hooks.json");
      const hooks = existsSync(hooksPath) ? JSON.parse(readFileSync(hooksPath, "utf8")) : {};
      const entries: Array<{ hooks?: Array<{ command?: string }> }> = hooks.hooks?.UserPromptSubmit ?? [];
      const ours = entries.map((e) => e.hooks?.[0]?.command ?? "").find((c) => /context-doctor|cli\.js"?\s+hook/.test(c));
      if (!ours) {
        checks.push({ label: "Codex hook", status: "fail", detail: "not registered — run: context-doctor install" });
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
  } else {
    checks.push({ label: "Codex", status: "skip", detail: "not detected (ChatGPT's Codex agent, IDE extension or CLI)" });
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

  // Ledger writable
  try {
    recordLedger({ ev: "check", sid: "doctor-probe", tok: 0, warn: false });
    checks.push({ label: "Ledger", status: "ok", detail: `writable at ${ledgerPath()}` });
  } catch {
    checks.push({ label: "Ledger", status: "fail", detail: `cannot write ${ledgerPath()}` });
  }

  // Project config: a setting that is silently ignored looks exactly like the
  // feature being broken, so name it here rather than leaving it to be guessed.
  const loaded = loadConfig(process.cwd());
  if (loaded.path) {
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
    if (!existsSync(paths.config)) {
      checks.push({ label: "Autopilot", status: "skip", detail: "off (context-doctor autopilot on: clears stale tool output in every new Claude Code session)" });
    } else {
      const cfg = JSON.parse(readFileSync(paths.config, "utf8")) as { port: number };
      const h = await health(cfg.port);
      let routed = false;
      try { routed = JSON.parse(readFileSync(paths.settings, "utf8"))?.env?.ANTHROPIC_BASE_URL === proxyUrl(cfg.port); } catch { /* reported below */ }
      const paused = existsSync(paths.pauseFile);
      checks.push(
        h.ok && h.autopilot && routed
          ? { label: "Autopilot", status: "ok", detail: `proxy up on ${proxyUrl(cfg.port)}, Claude Code routed through it${paused ? " (PAUSED: passthrough)" : ""}` }
          : { label: "Autopilot", status: "fail", detail: !h.ok ? `proxy not answering on ${proxyUrl(cfg.port)}: the next Claude Code prompt restarts it; or run: context-doctor autopilot on` : "settings.json no longer routes Claude Code to the proxy: run context-doctor autopilot on" }
      );
    }
  }

  const mark = { ok: "✓", fail: "✗", skip: "–" } as const;
  console.log("CONTEXT DOCTOR — self-check");
  console.log("═".repeat(56));
  for (const c of checks) {
    console.log(`${mark[c.status]} ${c.label.padEnd(22)} ${c.detail}`);
  }
  const fails = checks.filter((c) => c.status === "fail");
  console.log("");
  console.log(fails.length === 0 ? "All good." : `${fails.length} issue(s) found — fixes suggested above.`);
}
