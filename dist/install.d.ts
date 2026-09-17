/**
 * One-command setup: `context-doctor install`
 *
 * Detects the AI apps present on this machine and wires the context-doctor
 * MCP server into each, plus installs the Agent Skill for Claude Code.
 * Every config edit is a careful JSON merge with a .backup file written first.
 * `context-doctor uninstall` reverses it.
 */
/**
 * How to invoke the published package as an MCP server on a given platform.
 *
 * On Windows npx is `npx.cmd` — a batch script, not an executable. MCP clients
 * spawn their server directly, without a shell, so a bare "npx" fails with
 * ENOENT and the app simply shows no tools and no error. Hence the cmd /c
 * wrapper that every working Windows MCP config uses.
 *
 * Exported so the platform branch is testable from any host OS.
 */
export declare function npxLauncher(platformName: string): {
    command: string;
    args: string[];
};
/**
 * Claude Code's status bar: a `statusLine` command whose stdout is shown while
 * the user types. Opt-in, because there is only one status line and it may
 * already be someone's own — this never overwrites a statusLine that is not
 * ours. Returns what happened so install can print the truth.
 */
export declare function installStatusLine(): "installed" | "already" | "kept-foreign" | "no-claude-code";
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
export declare function runUninstall(): void;
