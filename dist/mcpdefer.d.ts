/**
 * `fix --apply mcp-defer`: keep an MCP server's tools behind tool search.
 *
 * Tool search defers MCP tool definitions by default, but a server the user
 * configured with `"alwaysLoad": true`, or whose author marks its tools
 * `_meta["anthropic/alwaysLoad"]`, is sent whole on every request of every
 * session and subagent. `"alwaysLoad": false` in the server's own entry
 * defers all of its tools, the author-marked ones too (Claude Code 2.1.287+,
 * "Defer a server's tools" in the MCP docs). Only servers in the user's own
 * `~/.claude.json` (user scope, or this project's local scope) are written: a
 * project's `.mcp.json` is shared with everyone who clones it, so it is named,
 * not changed. The Desktop app's own servers and connectors are not in any
 * config file and no setting reaches them.
 *
 * Undo puts back each key as it was (absent, or the value it had), only
 * where it still holds `false`: Claude Code rewrites `~/.claude.json` all the
 * time, so the file is never restored whole.
 */
/** The Claude Code version that first reads `alwaysLoad: false` on a server. */
export declare const MCP_DEFER_SINCE = "2.1.287";
export interface DeferEntry {
    /** The key path in ~/.claude.json. */
    key: string[];
    /** Whether the key was there before, and its value then. */
    hadPrevious: boolean;
    previous?: unknown;
}
/** Where a server's `alwaysLoad` lives in ~/.claude.json, by scope; undefined for a scope fix does not write. */
export declare function deferKey(name: string, scope: string, cwd?: string): string[] | undefined;
/**
 * Set `alwaysLoad: false` on each server, in one write of ~/.claude.json.
 * A server no longer in the file is skipped; one already deferred is left.
 * The caller holds the fix records' lock.
 */
export declare function applyMcpDefer(servers: Array<{
    name: string;
    scope: string;
}>, opts?: {
    home?: string;
    cwd?: string;
}): {
    file: string;
    entries: DeferEntry[];
    lines: string[];
};
/** Put each key back where it still holds `false`. The caller holds the fix records' lock. */
export declare function undoMcpDefer(file: string, entries: DeferEntry[]): string[];
