/**
 * One-command setup: `context-doctor install`
 *
 * Detects the AI apps present on this machine and wires the context-doctor
 * MCP server into each, plus installs the Agent Skill for Claude Code.
 * Every config edit is a careful JSON merge with a .backup file written first.
 * `context-doctor uninstall` reverses it.
 */
export declare function geminiSettingsPath(): string;
export declare function geminiCliPresent(): boolean;
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
export declare function npxLauncher(platformName: string): {
    command: string;
    args: string[];
};
/**
 * True for the launcher installs before 0.31.2 wrote: npx asked to run a
 * package named context-doctor-mcp, which is not on npm. npx does fall back
 * to a command of that name already on PATH, so it starts where a global
 * install provides one; everywhere else npm answers 404.
 */
export declare function launcherNamesMissingPackage(entry: {
    command?: unknown;
    args?: unknown;
} | undefined): boolean;
/**
 * The Claude Code plugin's key in enabledPlugins: "<plugin>@<marketplace>".
 * Our marketplace (.claude-plugin/marketplace.json) is named context-doctor
 * and lists one plugin, context-doctor, so the official key is
 * "context-doctor@context-doctor"; a copy listed in another marketplace keeps
 * the plugin name, so any "context-doctor@…" key is ours.
 */
export declare const PLUGIN_KEY = "context-doctor@context-doctor";
export declare function isOurPluginKey(key: string): boolean;
/**
 * Is the context-doctor plugin switched on in the user's Claude Code
 * settings? The plugin brings its own MCP server, skills and hooks, so
 * `install` adding them as well makes Claude Code load the server's
 * instructions and tools twice.
 */
export declare function claudePluginEnabled(home?: string): boolean;
/** What `install` put into Claude Code that the plugin also provides, by name. */
export declare function claudeInstalledCopies(home?: string): string[];
/**
 * A config that configures nothing: `{}`, or only empty `mcpServers` /
 * `hooks` containers (plus `extraKeys`, e.g. the `version` install writes
 * into Cursor's hooks.json). It is what install's own writes leave once our
 * entries are gone, and to an app it is the same as no file at all.
 */
export declare function isEmptyStub(config: unknown, extraKeys?: string[]): boolean;
export declare function readJson(path: string): Record<string, any>;
/** Copy `path` to its .context-doctor.backup, once per run. */
export declare function backupOnce(path: string): void;
export declare function writeJsonWithBackup(path: string, data: Record<string, any>): void;
/**
 * Find an executable on PATH without shelling out (works on Windows too).
 * Used to prefer a global `context-doctor` install for the hook: a stable
 * location that survives both package updates and Node upgrades.
 */
export declare function binOnPath(name: string): string | null;
/** Paths npm may delete at any time: the npx cache and the npm cache itself. */
export declare function isEphemeralPath(path: string): boolean;
/**
 * Claude Code's status bar: a `statusLine` command whose stdout is shown while
 * the user types. Opt-in, because there is only one status line and it may
 * already be someone's own — this never overwrites a statusLine that is not
 * ours. Returns what happened so install can print the truth.
 */
export declare function installStatusLine(): "installed" | "already" | "kept-foreign" | "no-claude-code";
/**
 * Cursor runs Claude Code's UserPromptSubmit hook as its own
 * beforeSubmitPrompt, which can only allow or block a prompt: what the hook
 * says never reaches Cursor's model. Cursor's postToolUse can add context
 * (`additional_context`), and its input carries the agent transcript, so the
 * check runs there, in Cursor's own ~/.cursor/hooks.json. It fires after every
 * tool call, which the hook's stat-only fast path and regrowth gate make cheap.
 */
export declare function cursorHooksPath(): string;
export declare const isOurCursorEntry: (e: unknown) => boolean;
/**
 * Cursor's events whose `additional_context` can reach its agent: after a
 * tool call, after a failed one, and at the start of a chat. Cursor 3.18's
 * agent runtime attaches the first two to the tool result (Cursor confirmed
 * postToolUseFailure delivery in 3.17.8); before 3.17 it dropped postToolUse
 * output (staff-confirmed, March 2026). sessionStart is the documented way
 * to add context to a chat's start, and serves a resumed heavy chat.
 */
export declare const CURSOR_HOOK_EVENTS: readonly ["postToolUse", "postToolUseFailure", "sessionStart"];
export declare function installCursorHook(): string | null;
export declare function codexDir(): string;
/**
 * Add or replace our [mcp_servers.context-doctor] table in config.toml without
 * a TOML library: the file is the user's, so everything outside our own table
 * is copied through byte for byte. Our table is delimited by its header and the
 * next header (or EOF). Our subtables (e.g. an env the user added) are kept.
 */
export declare function upsertCodexMcpTable(toml: string, entry: {
    command: string;
    args: string[];
}): string;
export declare function removeCodexMcpTable(toml: string): string;
/**
 * The command and args of our Codex server, or undefined when config.toml
 * does not define one. Reads the inline forms too: Codex runs those fine.
 */
export declare function codexMcpEntry(toml: string): {
    command?: string;
    args: string[];
} | undefined;
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
export declare function runInstall(options?: {
    statusLine?: boolean;
}): InstallResult;
export declare function runUninstall(): Promise<void>;
