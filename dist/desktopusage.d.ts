/**
 * How Claude Desktop's chat actually uses the MCP server, from Desktop's own
 * log. Desktop gives an MCP server no hook and no transcript, so its
 * per-server log (mcp-server-context-doctor.log: initialize, tools/list,
 * tools/call) is the only evidence that the tools are offered and called.
 * Desktop does not log which pages are opened, so chat activity itself cannot
 * be measured locally; Code-tab sessions can (Claude Code transcripts record
 * the desktop app as their entrypoint), and those reach context-doctor
 * through Claude Code's hook and MCP config, not through this server.
 */
export interface DesktopUsage {
    launches: number;
    toolLists: number;
    toolCalls: number;
    lastCall?: string;
}
export declare function desktopLogDir(home?: string): string;
export declare function desktopUsage(dir?: string): DesktopUsage | undefined;
/** One line for `doctor`: the numbers, and what to do with them. `codeTabSessions`: this week's Claude Code sessions run in Desktop's Code tab. */
export declare function describeDesktopUsage(u: DesktopUsage, codeTabSessions?: number): string;
