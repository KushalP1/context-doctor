/**
 * The MCP schema tax: what each MCP server's tool definitions add to every
 * request, and whether the server is used at all.
 *
 * Tool definitions (name, description, JSON schema) ride in the request's
 * `tools` array, so they are part of the fixed overhead `overhead` measures;
 * transcripts never contain them. Two sources:
 *  - usage, from transcripts: every MCP call is a tool_use named
 *    `mcp__<server>__<tool>`, which also reveals servers the app provides
 *    (desktop browser, connectors) that no config file lists;
 *  - size, by asking each configured server for its tool list, exactly as
 *    Claude Code does at startup. That launches the servers, so it runs only
 *    when asked (`overhead --mcp`).
 *
 * Claude Code's tool search defers MCP definitions until the model looks them
 * up; with it on, an unused server costs about its tool names, not its
 * schemas. Usage of ToolSearch in the transcripts says whether that is so.
 */
export interface McpServerConfig {
    name: string;
    scope: "user" | "project" | ".mcp.json";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    type?: string;
}
export interface McpServerSize {
    name: string;
    tools?: number;
    /** Tokens of the full definitions: what an up-front load costs on every request. */
    schemaTokens?: number;
    /** Tokens of the tool names alone: roughly what a deferred load costs. */
    nameTokens?: number;
    error?: string;
}
export interface McpUsage {
    /** Calls per server name (as it appears in tool names), main chain and subagents. */
    calls: Map<string, number>;
    sessions: number;
    /** Sessions in which the model used ToolSearch, i.e. MCP definitions were deferred. */
    toolSearchSessions: number;
}
/** Claude Code's spelling of a server name inside tool names. */
export declare function toolPrefixName(server: string): string;
/** MCP servers Claude Code starts in `cwd`, with their launch configs. */
export declare function claudeMcpConfigs(cwd?: string, home?: string): McpServerConfig[];
/**
 * MCP calls per server over the last `days`, from Claude Code transcripts
 * and their subagents' (`<session>/subagents/agent-*.jsonl`). Only lines
 * naming an MCP tool or ToolSearch are parsed.
 *
 * Subagents: on the author's machine 49 Gmail and 23 Slack connector calls
 * were made only by subagents, so scanning the top-level transcripts alone
 * told the user to remove a server their subagents use. Once per call: a
 * forked session starts as a copy of its parent's history, the same rows
 * (uuid) holding the same calls (tool_use id), so a call is counted once by
 * the two together; like replyCounter, that leaves alone hand-made
 * transcripts that reuse an id. Each call by its own row's time: a file
 * touched in the window also holds every older call of its session (2,983
 * of them in one 30-day count). Rows without a timestamp count with their
 * file.
 */
export declare function mcpUsage(days?: number, paths?: string[]): McpUsage;
/** Connect to one server the way a client does and size its tool list. */
export declare function measureServer(cfg: McpServerConfig, timeoutMs?: number): Promise<McpServerSize>;
