/**
 * One-command setup: `context-doctor install`
 *
 * Detects the AI apps present on this machine and wires the context-doctor
 * MCP server into each, plus installs the Agent Skill for Claude Code.
 * Every config edit is a careful JSON merge with a .backup file written first.
 * `context-doctor uninstall` reverses it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

interface Target {
  name: string;
  configPath: string;
  /** Where the mcpServers map lives inside the JSON (all three apps use the same key). */
  detect(): boolean;
}

function claudeDesktopConfigPath(): string {
  switch (platform()) {
    case "darwin": return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32": return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    default: return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
  }
}

function targets(): Target[] {
  const desktop = claudeDesktopConfigPath();
  const claudeCode = join(homedir(), ".claude.json");
  const cursor = join(homedir(), ".cursor", "mcp.json");
  return [
    { name: "Claude Desktop", configPath: desktop, detect: () => existsSync(dirname(desktop)) },
    { name: "Claude Code", configPath: claudeCode, detect: () => existsSync(claudeCode) || existsSync(join(homedir(), ".claude")) },
    { name: "Cursor", configPath: cursor, detect: () => existsSync(join(homedir(), ".cursor")) },
    { name: "Gemini CLI", configPath: geminiSettingsPath(), detect: geminiCliPresent },
  ];
}

// -- Gemini CLI: MCP servers and hooks both live in ~/.gemini/settings.json,
// hooks in Claude Code's shape under the event BeforeAgent (its prompt hook).
// ~/.gemini alone is not enough to call it present: Google's Antigravity IDE
// creates it too, without the CLI.
export function geminiSettingsPath(): string {
  return join(homedir(), ".gemini", "settings.json");
}

export function geminiCliPresent(): boolean {
  return existsSync(geminiSettingsPath()) || existsSync(join(homedir(), ".gemini", "tmp")) || binOnPath("gemini") !== null;
}

/**
 * The server command to write into configs.
 *
 * Never write `process.execPath`: on Homebrew, nvm and asdf that is a
 * VERSION-PINNED path (…/node/25.6.0/bin/node), so the next Node upgrade
 * silently breaks every config we wrote — the apps simply stop showing the
 * tools, with no error to explain why. `node` from PATH survives upgrades.
 *
 * Installed from npm → npx, which also picks up package updates. Local
 * checkout → the built file, so the repo works before/without publishing.
 */
function serverEntry(): { command: string; args: string[] } {
  const selfDir = dirname(fileURLToPath(import.meta.url));
  const localMcp = join(selfDir, "mcp.js");
  const fromPackage = selfDir.includes(`${sep}node_modules${sep}`) || selfDir.includes("_npx");
  if (!fromPackage && existsSync(localMcp)) {
    // `node` is node.exe on Windows — directly spawnable, no shell needed.
    return { command: "node", args: [localMcp] };
  }
  return npxLauncher(platform());
}

/**
 * How to invoke the published package as an MCP server on a given platform.
 *
 * On Windows npx is `npx.cmd` — a batch script, not an executable. MCP clients
 * spawn their server directly, without a shell, so a bare "npx" fails with
 * ENOENT and the app simply shows no tools and no error. Hence the cmd /c
 * wrapper that every working Windows MCP config uses.
 *
 * Exported so the platform branch is testable from any host OS.
 *
 * npx resolves its first operand as a PACKAGE name. context-doctor-mcp is
 * only a bin inside the context-doctor package, so `npx -y context-doctor-mcp`
 * asked npm for a package that does not exist: unless a global install
 * happened to put that command on PATH, every app got a server that never
 * started. The main bin's `mcp` subcommand is the same server.
 */
export function npxLauncher(platformName: string): { command: string; args: string[] } {
  return platformName === "win32"
    ? { command: "cmd", args: ["/c", "npx", "-y", "context-doctor", "mcp"] }
    : { command: "npx", args: ["-y", "context-doctor", "mcp"] };
}

/**
 * True for the launcher installs before 0.31.2 wrote: npx asked to run a
 * package named context-doctor-mcp, which is not on npm. npx does fall back
 * to a command of that name already on PATH, so it starts where a global
 * install provides one; everywhere else npm answers 404.
 */
export function launcherNamesMissingPackage(entry: { command?: unknown; args?: unknown } | undefined): boolean {
  if (!entry) return false;
  const words = [String(entry.command ?? ""), ...(Array.isArray(entry.args) ? entry.args.map(String) : [])];
  const npx = words.findIndex((w) => /(^|[\\/])npx(\.cmd)?$/i.test(w));
  if (npx === -1) return false;
  const rest = words.slice(npx + 1);
  if (rest.some((w) => w === "-p" || w.startsWith("--package"))) return false;
  return rest.find((w) => !w.startsWith("-")) === "context-doctor-mcp";
}

/**
 * The Claude Code plugin's key in enabledPlugins: "<plugin>@<marketplace>".
 * Our marketplace (.claude-plugin/marketplace.json) is named context-doctor
 * and lists one plugin, context-doctor, so the official key is
 * "context-doctor@context-doctor"; a copy listed in another marketplace keeps
 * the plugin name, so any "context-doctor@…" key is ours.
 */
export const PLUGIN_KEY = "context-doctor@context-doctor";

export function isOurPluginKey(key: string): boolean {
  return key === PLUGIN_KEY || key.startsWith("context-doctor@");
}

/**
 * Is the context-doctor plugin switched on in the user's Claude Code
 * settings? The plugin brings its own MCP server, skills and hooks, so
 * `install` adding them as well makes Claude Code load the server's
 * instructions and tools twice.
 */
export function claudePluginEnabled(home = homedir()): boolean {
  try {
    const plugins = readJson(join(home, ".claude", "settings.json")).enabledPlugins ?? {};
    return Object.entries(plugins as Record<string, unknown>).some(([key, on]) => isOurPluginKey(key) && on === true);
  } catch {
    return false; // an unreadable settings.json is reported by the hook step
  }
}

/** What `install` put into Claude Code that the plugin also provides, by name. */
export function claudeInstalledCopies(home = homedir()): string[] {
  const found: string[] = [];
  try {
    if (readJson(join(home, ".claude.json")).mcpServers?.["context-doctor"]) found.push("MCP server in ~/.claude.json");
  } catch { /* unreadable: not ours to judge here */ }
  try {
    const hooks = readJson(join(home, ".claude", "settings.json")).hooks ?? {};
    if (["UserPromptSubmit", "PreCompact"].some((ev) => (hooks[ev] ?? []).some?.(isOurHookEntry))) found.push("hooks in ~/.claude/settings.json");
  } catch { /* unreadable */ }
  if (existsSync(join(home, ".claude", "skills", "context-doctor", "SKILL.md"))) found.push("skill in ~/.claude/skills/context-doctor");
  return found;
}

/**
 * A config that configures nothing: `{}`, or only empty `mcpServers` /
 * `hooks` containers (plus `extraKeys`, e.g. the `version` install writes
 * into Cursor's hooks.json). It is what install's own writes leave once our
 * entries are gone, and to an app it is the same as no file at all.
 */
export function isEmptyStub(config: unknown, extraKeys: string[] = []): boolean {
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  const empty = (v: unknown) => v !== null && typeof v === "object" && Object.keys(v as object).length === 0;
  return Object.entries(config as Record<string, unknown>).every(
    ([k, v]) => ((k === "mcpServers" || k === "hooks") && empty(v)) || extraKeys.includes(k)
  );
}

export function readJson(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} exists but is not valid JSON — fix or remove it first (${(e as Error).message})`);
  }
}

/**
 * Config files already backed up (or found absent) in this process.
 *
 * One install writes ~/.claude/settings.json up to three times (prompt hook,
 * compaction hook, status line). Copying before every write left a .backup
 * that already held our own first write, so the user's original was gone
 * before the run even finished. The first write of a run keeps the original.
 */
const backedUp = new Set<string>();

/** Copy `path` to its .context-doctor.backup, once per run. */
export function backupOnce(path: string): void {
  if (backedUp.has(path)) return;
  backedUp.add(path);
  if (existsSync(path)) copyFileSync(path, path + ".context-doctor.backup");
}

export function writeJsonWithBackup(path: string, data: Record<string, any>): void {
  mkdirSync(dirname(path), { recursive: true });
  backupOnce(path);
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/**
 * Find an executable on PATH without shelling out (works on Windows too).
 * Used to prefer a global `context-doctor` install for the hook: a stable
 * location that survives both package updates and Node upgrades.
 */
export function binOnPath(name: string): string | null {
  const exts = platform() === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    // npx prepends its OWN cache's .bin to PATH while it runs the command. So
    // during `npx -y context-doctor install`, the first "global binary" on
    // PATH is inside _npx — the garbage-collected directory this lookup exists
    // to avoid. That hole put a cache path in the hook of every user who
    // followed the README's headline command.
    if (isEphemeralPath(dir)) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Paths npm may delete at any time: the npx cache and the npm cache itself. */
export function isEphemeralPath(path: string): boolean {
  return /[\\/]_npx[\\/]/.test(path) || /[\\/]\.npm[\\/]/.test(path) || /[\\/]npm-cache[\\/]/i.test(path);
}

/**
 * Shell command used for the Claude Code every-prompt hook.
 *
 * The hook runs on EVERY prompt, so the command must be both fast and durable.
 * In preference order:
 *   1. a local checkout's built cli.js — absolute, stable, zero resolution cost;
 *   2. a global `context-doctor` binary on PATH — same, for npm -g installs;
 *   3. `npx -y context-doctor hook` — last resort.
 *
 * Critically, a path inside npx's `_npx` cache is NEVER written: npm garbage-
 * collects that directory, and the hook would then fail silently on every
 * prompt. `node` (not process.execPath) keeps it alive across Node upgrades.
 */
function hookCommand(): string {
  return cliCommand("hook");
}

/** The same durable command resolution, for any subcommand Claude Code runs for us. */
function cliCommand(subcommand: string): string {
  const selfDir = dirname(fileURLToPath(import.meta.url));
  const localCli = join(selfDir, "cli.js");
  if (!isEphemeralPath(selfDir + sep) && existsSync(localCli)) return `node "${localCli}" ${subcommand}`;
  const global = binOnPath("context-doctor");
  if (global) return `"${global}" ${subcommand}`;
  return `npx -y context-doctor ${subcommand}`;
}

/**
 * Claude Code's status bar: a `statusLine` command whose stdout is shown while
 * the user types. Opt-in, because there is only one status line and it may
 * already be someone's own — this never overwrites a statusLine that is not
 * ours. Returns what happened so install can print the truth.
 */
export function installStatusLine(): "installed" | "already" | "kept-foreign" | "no-claude-code" {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (!existsSync(join(homedir(), ".claude"))) return "no-claude-code";
  const settings = readJson(settingsPath);
  const want = cliCommand("statusline");
  const current = settings.statusLine?.command as string | undefined;
  if (current === want) return "already";
  if (current && !isOurStatusLine(current)) return "kept-foreign";
  settings.statusLine = { type: "command", command: want };
  writeJsonWithBackup(settingsPath, settings);
  return "installed";
}

function isOurStatusLine(command: string): boolean {
  return /context-doctor|cli\.js"?\s+statusline\s*$/.test(command);
}

function uninstallStatusLine(): void {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (!existsSync(settingsPath)) return;
  const settings = readJson(settingsPath);
  const current = settings.statusLine?.command as string | undefined;
  if (current && isOurStatusLine(current)) {
    delete settings.statusLine;
    writeJsonWithBackup(settingsPath, settings);
    console.log("✓ Claude Code status line removed");
  }
}

/** True when the hook had to fall back to npx — worth telling the user. */
function hookUsesNpx(): boolean {
  return hookCommand().startsWith("npx ");
}

const HOOK_MARKER = "context-doctor";

/**
 * Is this settings.json hook entry ours?
 *
 * Usually the command contains "context-doctor" (npx form, or a path through
 * the package directory). A repo cloned into a differently-named folder does
 * not, so a command ending in `cli.js hook` counts too — specific enough not
 * to claim an unrelated hook.
 */
function isOurHookEntry(entry: unknown): boolean {
  const raw = JSON.stringify(entry ?? "");
  if (raw.includes(HOOK_MARKER)) return true;
  const command = String((entry as { hooks?: Array<{ command?: string }> })?.hooks?.[0]?.command ?? "");
  return /(cli\.js|context-doctor(\.cmd|\.exe|\.bat)?)"?\s+hook\s*$/.test(command);
}

/**
 * Register the UserPromptSubmit hook in ~/.claude/settings.json so EVERY
 * Claude Code query gets a context-size check. Idempotent.
 */
function installHook(): string | null {
  const settings = join(homedir(), ".claude", "settings.json");
  const path = installHookInto(settings, join(homedir(), ".claude"));
  // The same command also answers PreCompact: what each compaction's summary must keep.
  if (path) installHookInto(settings, join(homedir(), ".claude"), "PreCompact");
  return path;
}

/**
 * Register the UserPromptSubmit hook in a hooks file. Claude Code's
 * settings.json and Codex's hooks.json share the exact same shape
 * ({hooks:{UserPromptSubmit:[{hooks:[{type:"command",command}]}]}}), so one
 * writer serves both; only the path differs.
 */
function installHookInto(settingsPath: string, gateDir: string, event = "UserPromptSubmit"): string | null {
  if (!existsSync(gateDir)) return null; // that app is not on this machine
  const settings = readJson(settingsPath);
  settings.hooks = settings.hooks ?? {};
  const entries: Array<Record<string, any>> = settings.hooks[event] ?? [];
  const want = hookCommand();

  // Re-running install must REPAIR a stale entry, not skip it. Earlier versions
  // wrote a version-pinned node binary; if we only checked "is it present?" an
  // upgrade would leave that broken command in place forever.
  const ours = entries.filter(isOurHookEntry);
  const current = ours[0]?.hooks?.[0]?.command;
  if (ours.length === 0) {
    entries.push({ hooks: [{ type: "command", command: want }] });
  } else if (current !== want) {
    // Replace every entry of ours with exactly one correct entry.
    const others = entries.filter((e) => !isOurHookEntry(e));
    others.push({ hooks: [{ type: "command", command: want }] });
    settings.hooks[event] = others;
    writeJsonWithBackup(settingsPath, settings);
    return settingsPath;
  } else {
    return settingsPath; // already correct — leave the file untouched
  }
  settings.hooks[event] = entries;
  writeJsonWithBackup(settingsPath, settings);
  return settingsPath;
}

function uninstallHook(): void {
  uninstallHookFrom(join(homedir(), ".claude", "settings.json"), "Claude Code every-prompt hook");
  uninstallHookFrom(join(homedir(), ".claude", "settings.json"), "Claude Code compaction hook", "PreCompact");
  uninstallHookFrom(join(homedir(), ".codex", "hooks.json"), "Codex every-prompt hook");
  uninstallHookFrom(geminiSettingsPath(), "Gemini CLI every-prompt hook", "BeforeAgent");
  uninstallCursorHook();
}

/**
 * Cursor runs Claude Code's UserPromptSubmit hook as its own
 * beforeSubmitPrompt, which can only allow or block a prompt: what the hook
 * says never reaches Cursor's model. Cursor's postToolUse can add context
 * (`additional_context`), and its input carries the agent transcript, so the
 * check runs there, in Cursor's own ~/.cursor/hooks.json. It fires after every
 * tool call, which the hook's stat-only fast path and regrowth gate make cheap.
 */
export function cursorHooksPath(): string {
  return join(homedir(), ".cursor", "hooks.json");
}

const isOurCursorEntry = (e: unknown): boolean => /(cli\.js|context-doctor(\.cmd|\.exe|\.bat)?)"?\s+hook\s*$/.test(String((e as { command?: string })?.command ?? ""));

export function installCursorHook(): string | null {
  if (!existsSync(join(homedir(), ".cursor"))) return null;
  const path = cursorHooksPath();
  const config = readJson(path);
  config.version = config.version ?? 1;
  config.hooks = config.hooks ?? {};
  const entries: Array<Record<string, any>> = config.hooks.postToolUse ?? [];
  const want = hookCommand();
  const ours = entries.filter(isOurCursorEntry);
  if (ours.length === 1 && ours[0].command === want) return path; // already correct
  config.hooks.postToolUse = [...entries.filter((e) => !isOurCursorEntry(e)), { command: want, timeout: 10 }];
  writeJsonWithBackup(path, config);
  return path;
}

function uninstallCursorHook(): void {
  const path = cursorHooksPath();
  if (!existsSync(path)) return;
  const config = readJson(path);
  const entries: Array<Record<string, any>> | undefined = config.hooks?.postToolUse;
  if (!entries) return;
  const filtered = entries.filter((e) => !isOurCursorEntry(e));
  if (filtered.length === entries.length) return;
  if (filtered.length === 0) delete config.hooks.postToolUse;
  else config.hooks.postToolUse = filtered;
  writeJsonWithBackup(path, config);
  console.log("✓ Cursor after-tool-call hook removed");
}

function uninstallHookFrom(settingsPath: string, label: string, event = "UserPromptSubmit"): void {
  if (!existsSync(settingsPath)) return;
  const settings = readJson(settingsPath);
  const entries: Array<Record<string, any>> | undefined = settings.hooks?.[event];
  if (!entries) return;
  const filtered = entries.filter((e) => !isOurHookEntry(e));
  if (filtered.length !== entries.length) {
    settings.hooks[event] = filtered;
    if (filtered.length === 0) delete settings.hooks[event];
    writeJsonWithBackup(settingsPath, settings);
    console.log(`✓ ${label} removed`);
  }
}

function installSkill(): string | null {
  return installSkillInto(join(homedir(), ".claude", "skills", "context-doctor"));
}

/** Agent Skills are one format across Claude Code and Codex; only the home differs. */
function installSkillInto(skillDest: string): string | null {
  const selfDir = dirname(fileURLToPath(import.meta.url));
  // dist/install.js → package root is one level up; skills/ ships in the package.
  const skillSource = join(selfDir, "..", "skills", "context-doctor", "SKILL.md");
  if (!existsSync(skillSource)) return null;
  mkdirSync(skillDest, { recursive: true });
  copyFileSync(skillSource, join(skillDest, "SKILL.md"));
  return join(skillDest, "SKILL.md");
}

// -- Codex (OpenAI's agent: the Codex tab in ChatGPT.app, the IDE extension, the CLI)
//
// Codex supports the same three integration points as Claude Code, in almost
// the same formats: MCP servers ([mcp_servers.<name>] in ~/.codex/config.toml),
// hooks (~/.codex/hooks.json, identical shape to Claude's settings.json, same
// hookSpecificOutput.additionalContext response), and Agent Skills
// (~/.codex/skills/<name>/SKILL.md). One difference matters: Codex requires the
// user to trust a new hook once, via /hooks inside Codex, before it runs.

export function codexDir(): string {
  return join(homedir(), ".codex");
}

// Our key as TOML allows it to be written: bare or quoted, any spacing.
const OUR_KEY = String.raw`\s*mcp_servers\s*\.\s*(?:context-doctor|"context-doctor"|'context-doctor')\s*`;
/** Our table's header, with or without a trailing comment. */
const OUR_HEADER = new RegExp(String.raw`^\s*\[${OUR_KEY}\]\s*(?:#.*)?$`);
/** A subtable of ours, e.g. [mcp_servers.context-doctor.env]. */
const OUR_SUBHEADER = new RegExp(String.raw`^\s*\[${OUR_KEY}\.[^\]]*\]\s*(?:#.*)?$`);
const ANY_HEADER = /^\s*\[/;

/**
 * [start, end) line ranges of our tables (and, when asked, our subtables).
 *
 * A table runs to the next header, except that comment lines directly above
 * that header describe IT: they stay with the next table rather than being
 * deleted along with ours.
 */
function codexTableRanges(lines: string[], withSubtables: boolean): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!OUR_HEADER.test(lines[i]) && !(withSubtables && OUR_SUBHEADER.test(lines[i]))) continue;
    let end = i + 1;
    while (end < lines.length && !ANY_HEADER.test(lines[end])) end++;
    if (end < lines.length) {
      let k = end;
      while (k > i + 1 && /^\s*(#.*)?$/.test(lines[k - 1])) k--;
      // Blank lines after our last key are ours; the comments after them are not.
      while (k < end && lines[k].trim() === "") k++;
      end = k;
    }
    ranges.push([i, end]);
    i = end - 1;
  }
  return ranges;
}

/**
 * Lines that define context-doctor WITHOUT a header of its own:
 *   [mcp_servers] context-doctor = { command = "npx", ... }   (inline table)
 *   [mcp_servers] context-doctor.command = "npx"               (dotted keys)
 *   mcp_servers.context-doctor.command = "npx"                 (dotted, at the root)
 * Appending a [mcp_servers.context-doctor] table next to any of these defines
 * the key twice, which is invalid TOML, so these are refused instead.
 */
function inlineCodexDefinition(lines: string[]): number[] {
  const found: number[] = [];
  let table: string | null = ""; // "" = the root table; null = inside an array of tables
  const norm = (s: string) => s.replace(/\s+/g, "").replace(/["']/g, "");
  lines.forEach((line, i) => {
    if (/^\s*\[\[/.test(line)) { table = null; return; }
    const header = line.match(/^\s*\[([^\[\]]*)\]\s*(?:#.*)?$/);
    if (header) { table = norm(header[1]); return; }
    const key = line.match(/^\s*([A-Za-z0-9_\-."' ]+?)\s*=/)?.[1];
    if (key === undefined || table === null) return;
    const full = norm(table ? `${table}.${key}` : key);
    const ours = full === "mcp_servers.context-doctor" || full.startsWith("mcp_servers.context-doctor.");
    if ((table === "mcp_servers" || table === "") && ours) found.push(i);
    else if (table === "" && full === "mcp_servers" && /["']?context-doctor["']?\s*=/.test(line)) found.push(i);
  });
  return found;
}

function refuseInlineCodexDefinition(lines: string[]): void {
  const at = inlineCodexDefinition(lines);
  if (at.length > 0) {
    throw new Error(
      `config.toml defines context-doctor as an inline table or dotted keys (line ${at[0] + 1}), which cannot be edited safely line by line; ` +
        "replace it with a [mcp_servers.context-doctor] table, or delete it, and re-run. Nothing was changed."
    );
  }
}

/**
 * Add or replace our [mcp_servers.context-doctor] table in config.toml without
 * a TOML library: the file is the user's, so everything outside our own table
 * is copied through byte for byte. Our table is delimited by its header and the
 * next header (or EOF). Our subtables (e.g. an env the user added) are kept.
 */
export function upsertCodexMcpTable(toml: string, entry: { command: string; args: string[] }): string {
  const table =
    `[mcp_servers.context-doctor]\n` +
    `command = ${JSON.stringify(entry.command)}\n` +
    `args = [${entry.args.map((a) => JSON.stringify(a)).join(", ")}]\n`;
  const lines = toml.split("\n");
  refuseInlineCodexDefinition(lines);
  const [first, ...duplicates] = codexTableRanges(lines, false);
  if (!first) {
    const sep = toml.length === 0 || toml.endsWith("\n\n") ? "" : toml.endsWith("\n") ? "\n" : "\n\n";
    return toml + sep + table;
  }
  // A second table of ours is what earlier versions appended after a header
  // they did not recognise; it makes the file invalid, so repair it here.
  const kept = lines.filter((_, i) => !duplicates.some(([s, e]) => i >= s && i < e));
  const before = kept.slice(0, first[0]).join("\n");
  const after = kept.slice(first[1]).join("\n");
  return `${before}${before.length ? "\n" : ""}${table}${after.length ? "\n" + after : ""}`;
}

export function removeCodexMcpTable(toml: string): string {
  const lines = toml.split("\n");
  refuseInlineCodexDefinition(lines);
  // Subtables go too: a [mcp_servers.context-doctor.env] left alone defines
  // a server with no command, which Codex reports as broken.
  const ranges = codexTableRanges(lines, true);
  if (ranges.length === 0) return toml;
  return lines.filter((_, i) => !ranges.some(([s, e]) => i >= s && i < e)).join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * The command and args of our Codex server, or undefined when config.toml
 * does not define one. Reads the inline forms too: Codex runs those fine.
 */
export function codexMcpEntry(toml: string): { command?: string; args: string[] } | undefined {
  const lines = toml.split("\n");
  const [first] = codexTableRanges(lines, false);
  const inline = inlineCodexDefinition(lines);
  if (!first && inline.length === 0) return undefined;
  const text = first ? lines.slice(first[0] + 1, first[1]).join("\n") : inline.map((i) => lines[i]).join("\n");
  const command = text.match(/(?:^|[\s{,.])command\s*=\s*(["'])(.*?)\1/m)?.[2];
  const argsText = text.match(/(?:^|[\s{,.])args\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "";
  return { command, args: [...argsText.matchAll(/(["'])(.*?)\1/g)].map((m) => m[2]) };
}

function installCodex(entry: { command: string; args: string[] }, failures: string[]): void {
  const dir = codexDir();
  if (!existsSync(dir)) return; // Codex is not on this machine
  const configPath = join(dir, "config.toml");
  try {
    const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    const next = upsertCodexMcpTable(current, entry);
    if (next !== current) {
      backupOnce(configPath);
      writeFileSync(configPath, next);
    }
    console.log(`✓ Codex: MCP server added (${configPath})`);
  } catch (e) {
    console.error(`✗ Codex MCP: ${(e as Error).message}`);
    failures.push("Codex MCP");
  }
  try {
    const skill = installSkillInto(join(dir, "skills", "context-doctor"));
    if (skill) console.log(`✓ Agent Skill installed for Codex (${skill})`);
  } catch (e) {
    console.error(`✗ Codex skill: ${(e as Error).message}`);
    failures.push("Codex skill");
  }
  try {
    const hook = installHookInto(join(dir, "hooks.json"), dir);
    if (hook) {
      console.log(`✓ Codex every-prompt hook installed (${hook})`);
      console.log("  Codex runs a new hook only after you trust it once: open Codex, type /hooks, and trust context-doctor.");
    }
  } catch (e) {
    console.error(`✗ Codex hook: ${(e as Error).message}`);
    failures.push("Codex hook");
  }
}

function uninstallCodex(): void {
  const dir = codexDir();
  if (!existsSync(dir)) return;
  const configPath = join(dir, "config.toml");
  try {
    if (existsSync(configPath)) {
      const current = readFileSync(configPath, "utf8");
      const next = removeCodexMcpTable(current);
      if (next !== current) {
        backupOnce(configPath);
        writeFileSync(configPath, next);
        console.log("✓ Codex: MCP server removed");
      }
    }
  } catch (e) {
    console.error(`✗ Codex MCP: ${(e as Error).message}`);
  }
  const skillDir = join(dir, "skills", "context-doctor");
  if (existsSync(skillDir)) {
    rmSync(skillDir, { recursive: true });
    console.log("✓ Codex skill removed");
  }
}

/** Outcome of an install run, so the CLI can set a truthful exit code. */
export interface InstallResult {
  /** Detected targets that could not be configured, with the reason. */
  failures: string[];
}

/**
 * Install into every detected app.
 *
 * A failure in one app must not stop the others: someone with a corrupt
 * Claude Desktop config still wants Claude Code and Cursor wired. But it
 * must not be reported as success either — automation (dotfiles, CI,
 * onboarding scripts) reads the exit code, and a "Done." with exit 0 over a
 * failed target is a lie that surfaces later as "the tools never showed up".
 * So: keep going, summarize, and return the failures for a non-zero exit.
 */
export function runInstall(options: { statusLine?: boolean } = {}): InstallResult {
  const entry = serverEntry();
  const found = targets().filter((t) => t.detect());

  if (found.length === 0 && !existsSync(codexDir())) {
    console.log("No supported AI apps detected (Claude Desktop, Claude Code, Cursor, Codex, Gemini CLI).");
    console.log("Manual setup — add to your app's MCP config:");
    console.log(JSON.stringify({ mcpServers: { "context-doctor": entry } }, null, 2));
    return { failures: [] };
  }

  const failures: string[] = [];
  // The plugin already gives Claude Code the server, skill and hooks; a
  // second copy of each makes every session load the instructions and the
  // tools twice. Claude Code is skipped; the other apps are not.
  const viaPlugin = claudePluginEnabled();
  if (viaPlugin) {
    console.log("– Claude Code: skipped the MCP server, skill and hooks. The context-doctor plugin is enabled and");
    console.log("  provides them already; installing them as well would load its instructions and tools twice.");
    const copies = claudeInstalledCopies();
    if (copies.length > 0) {
      console.log(`  An earlier install is still in place (${copies.join(", ")}): \`context-doctor uninstall\``);
      console.log("  removes it, then `context-doctor install` wires the other apps again.");
    }
  }
  for (const target of found) {
    if (viaPlugin && target.name === "Claude Code") continue;
    try {
      const config = readJson(target.configPath);
      config.mcpServers = config.mcpServers ?? {};
      // Always overwrite: re-running install is how a stale entry gets repaired.
      config.mcpServers["context-doctor"] = entry;
      writeJsonWithBackup(target.configPath, config);
      console.log(`✓ ${target.name}: MCP server added (${target.configPath})`);
    } catch (e) {
      console.error(`✗ ${target.name}: ${(e as Error).message}`);
      failures.push(target.name);
    }
  }

  try {
    const skillPath = viaPlugin ? null : installSkill();
    if (skillPath) console.log(`✓ Agent Skill installed for Claude Code (${skillPath})`);
  } catch (e) {
    console.error(`✗ Agent Skill: ${(e as Error).message}`);
    failures.push("Agent Skill");
  }

  try {
    const hookPath = viaPlugin ? null : installHook();
    if (hookPath) {
      console.log(`✓ Claude Code every-prompt hook installed (${hookPath}) — heavy sessions get automatic hygiene guidance`);
      // npx resolves the package on every single prompt; a global install makes
      // the hook a plain exec instead, which is both faster and update-proof.
      if (hookUsesNpx()) {
        console.log("  note: the hook falls back to npx. For a faster, permanent hook: npm i -g context-doctor && context-doctor install");
      }
    }
  } catch (e) {
    // An unreadable settings.json used to escape as a stack trace and abort
    // the run; it is a failed target like any other.
    console.error(`✗ Claude Code every-prompt hook: ${(e as Error).message}`);
    failures.push("Claude Code hook");
  }

  try {
    const cursorHook = installCursorHook();
    if (cursorHook) console.log(`✓ Cursor after-tool-call hook installed (${cursorHook}) — Cursor's agent gets the same guidance in heavy sessions`);
  } catch (e) {
    console.error(`✗ Cursor hook: ${(e as Error).message}`);
    failures.push("Cursor hook");
  }

  installCodex(entry, failures);

  if (geminiCliPresent()) {
    try {
      const hook = installHookInto(geminiSettingsPath(), join(homedir(), ".gemini"), "BeforeAgent");
      if (hook) console.log(`✓ Gemini CLI every-prompt hook installed (${hook})`);
    } catch (e) {
      console.error(`✗ Gemini CLI hook: ${(e as Error).message}`);
      failures.push("Gemini CLI hook");
    }
  }

  if (options.statusLine) {
    try {
      switch (installStatusLine()) {
        case "installed": console.log("✓ Claude Code status line installed — live context size, cache share and cost while you type"); break;
        case "already": console.log("✓ Claude Code status line already installed"); break;
        case "kept-foreign": console.log("– Claude Code status line left alone: you already have your own statusLine command. Remove it first if you want ours."); break;
        case "no-claude-code": console.log("– status line skipped: Claude Code not detected"); break;
      }
    } catch (e) {
      console.error(`✗ Claude Code status line: ${(e as Error).message}`);
      failures.push("Claude Code status line");
    }
  }

  if (failures.length > 0) {
    console.log(`\nDone with ${failures.length} problem(s): ${failures.join(", ")}. See the ✗ lines above.`);
    console.log("Everything else was installed. Exit code is 1 so scripts can tell; fix the file(s) and re-run install.");
  } else {
    console.log("\nDone. Restart the apps to pick up the new tools, then try:");
    console.log('  "What\'s eating my context?" — or paste a conversation and ask for a profile.');
    console.log("See what it is worth on your own sessions:   context-doctor savings");
    console.log("Chat apps (Claude Desktop, claude.ai, ChatGPT, phones) have no hook. To make the rules standing there:");
    console.log("  context-doctor instructions --copy   then paste into the app's preferences (it tells you where).");
  }
  return { failures };
}

/**
 * Autopilot points Claude Code at a local proxy (env.ANTHROPIC_BASE_URL in
 * settings.json), kept alive by a login service and by this package's hook.
 * Uninstalling around it left that address in place with nothing behind it,
 * so every new Claude Code session failed to reach the API. It is switched
 * off first, exactly as `autopilot off` does it (setting before service).
 */
async function uninstallAutopilot(): Promise<void> {
  const { autopilotOff, autopilotPaths, proxyUrl, DEFAULT_AUTOPILOT_PORT } = await import("./autopilot.js");
  const paths = autopilotPaths();
  // Only for a home that has autopilot: removing the service addresses
  // systemd and the Windows task scheduler by NAME, not by anything under
  // this home, so a home without autopilot must never reach them.
  if (!existsSync(paths.config)) return;
  // The port, read before `off` deletes the file; a damaged file usually
  // still names it.
  let port = DEFAULT_AUTOPILOT_PORT;
  try {
    port = Number(readFileSync(paths.config, "utf8").match(/"port"\s*:\s*(\d+)/)?.[1] ?? port);
  } catch {
    /* unreadable: the default port */
  }
  try {
    // `autopilot pause` is advice for someone keeping the package; not here.
    for (const line of await autopilotOff(paths)) if (!line.includes("autopilot pause")) console.log(line);
  } catch (e) {
    console.error(`✗ Autopilot: ${(e as Error).message} (run: context-doctor autopilot off)`);
    return;
  }
  // `off` restores only what a readable config describes. A damaged one
  // leaves the proxy address in settings.json, which is the dead-port case.
  try {
    const settings = readJson(paths.settings);
    if (settings.env?.ANTHROPIC_BASE_URL === proxyUrl(port)) {
      delete settings.env.ANTHROPIC_BASE_URL;
      if (Object.keys(settings.env).length === 0) delete settings.env;
      writeJsonWithBackup(paths.settings, settings);
      console.log(`✓ Claude Code no longer routed through ${proxyUrl(port)} (autopilot's config could not say what address, if any, it had replaced)`);
    }
  } catch (e) {
    console.error(`✗ Autopilot: ${(e as Error).message}`);
  }
}

/** Everything of ours under ~/.claude besides configs: state, ledger, autopilot bookkeeping. */
const OUR_CLAUDE_FILES = [
  ".context-doctor-hook-state.json",
  ".context-doctor-hook-state.d",
  ".context-doctor-ledger.jsonl",
  ".context-doctor-calibration.json",
  ".context-doctor-autopilot-cleared.json",
  ".context-doctor-autopilot-paused",
  ".context-doctor-proxy.log",
  ".context-doctor-proxy-restart",
];

export async function runUninstall(): Promise<void> {
  // First: if anything below fails, Claude Code must still reach the API.
  await uninstallAutopilot();
  for (const target of targets().filter((t) => t.detect())) {
    try {
      if (!existsSync(target.configPath)) continue;
      const config = readJson(target.configPath);
      if (config.mcpServers?.["context-doctor"]) {
        delete config.mcpServers["context-doctor"];
        writeJsonWithBackup(target.configPath, config);
        console.log(`✓ ${target.name}: MCP server removed`);
      }
    } catch (e) {
      console.error(`✗ ${target.name}: ${(e as Error).message}`);
    }
  }
  const skillDir = join(homedir(), ".claude", "skills", "context-doctor");
  if (existsSync(skillDir)) {
    rmSync(skillDir, { recursive: true });
    console.log("✓ Agent Skill removed");
  }
  uninstallHook();
  uninstallStatusLine();
  uninstallCodex();
  // Remove our bookkeeping files too — uninstall means gone. The hook's
  // per-session state is a directory, one small file per session.
  for (const file of OUR_CLAUDE_FILES) {
    const p = join(homedir(), ".claude", file);
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
      console.log(`✓ Removed ${file}`);
    }
  }
  console.log("Done.");
}
