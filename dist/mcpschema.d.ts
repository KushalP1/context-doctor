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
import { type Extractor } from "./scan.js";
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
    /**
     * The tool list changed between two listings in a row: "order" when the
     * same tools came back in another order, "content" when a definition
     * changed (a timestamp or counter in a description, say). Either makes a
     * client that lists again send different tool definitions, and every
     * cached request after the tools is written again. The 2026-07-28 MCP spec
     * asks servers for a deterministic order for exactly this reason.
     */
    unstable?: "order" | "content";
    error?: string;
}
export interface McpUsage {
    /**
     * Calls per server as a first guess from the tool name alone (up to the
     * first "__"): right for app-provided servers, wrong for a configured name
     * with characters Claude Code turns into "_" ("linear (work)" is
     * mcp__linear__work___…). Configured servers go through serverUses().
     */
    calls: Map<string, number>;
    /** Uses per full name: tools (mcp__server__tool) and prompts run as /mcp__server__prompt. */
    names: Map<string, number>;
    /** Resource reads and listings (ReadMcpResourceTool and its kin) per `server` input. */
    resources: Map<string, number>;
    sessions: number;
    /** Sessions in which the model used ToolSearch, i.e. MCP definitions were deferred. */
    toolSearchSessions: number;
}
/** The MCP resource tools (current names and their pre-rename spellings, as the 2.1.308 binary maps them): their `server` input names the server. */
export declare const MCP_RESOURCE_TOOLS: RegExp;
/** A prompt run as a slash command: `<command-name>/mcp__server__prompt</command-name>`. */
export declare const MCP_PROMPT_COMMAND: RegExp;
/**
 * Uses of each configured server: every tool or prompt name counted under the
 * LONGEST configured prefix `mcp__<toolPrefixName(name)>__` it starts with (so
 * "linear" does not take "linear (work)"'s calls), plus resource-tool calls
 * whose `server` input is the server's name.
 */
export declare function serverUses(configNames: string[], usage: Pick<McpUsage, "names" | "resources">): Map<string, number>;
/** Names no configured prefix claims: the app's own servers and connectors, by the first-guess parse. */
export declare function otherServerUses(configNames: string[], usage: Pick<McpUsage, "names">): Map<string, number>;
/** Count one row's MCP uses into `names` and `resources`: tool calls, resource-tool calls, prompts run as slash commands. */
export declare function countMcpRow(e: any, names: Map<string, number>, resources: Map<string, number>): void;
/** Claude Code's spelling of a server name inside tool names. */
export declare function toolPrefixName(server: string): string;
/** MCP servers Claude Code starts in `cwd`, with their launch configs. */
export declare function claudeMcpConfigs(cwd?: string, home?: string): McpServerConfig[];
export declare const MCP_ROWS: Extractor<null>;
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
export declare function mcpUsage(days?: number, paths?: string[], onProgress?: (done: number, total: number) => void): McpUsage;
/**
 * How two listings of one server's tools differ: not at all, in order only,
 * or in a definition. Only what a client sends the model counts (name,
 * description, input schema): `_meta`, annotations and an output schema
 * that change per listing do not move the prompt cache.
 */
export declare function toolListChange(a: any[], b: any[]): "order" | "content" | undefined;
/** Connect to one server the way a client does and size its tool list. */
export declare function measureServer(cfg: McpServerConfig, timeoutMs?: number): Promise<McpServerSize>;
