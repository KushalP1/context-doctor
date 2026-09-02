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
export declare function runInstall(): void;
export declare function runUninstall(): void;
