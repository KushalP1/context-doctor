/**
 * Which MCP servers Claude Code hands context-doctor's mod, and how
 * (ROADMAP H3): the evidence `fix`'s desktop-tools-defer and `doctor` read
 * before anyone applies the lever.
 *
 * The mod's `tool.describe` hook (Claude Code 2.1.326+) sees each tool once
 * per session with its server's transport (`mcpServer.type`) and whether the
 * engine already lists it behind tool search (`isDeferred`). It keeps that in
 * memory, per server, and hands it to `context-doctor mod measure` after the
 * turn (the CLI it already runs), which appends one line per session here,
 * changes only: a second measure of the same session with the same servers
 * writes nothing. The mod draws nothing and moves nothing for this; with
 * CONTEXT_DOCTOR_DEFER_MCP unset it only watches.
 *
 * `~/.claude/.context-doctor-tools.jsonl` (beside the session-cost ledger),
 * capped as that one is: past 128 KB it keeps its newest 96 KB (a line is
 * ~400 bytes: months of sessions). Off: CONTEXT_DOCTOR_NO_COST_LOG=1, as the
 * session-cost ledger.
 */
/** One server as the mod saw it in a session. */
export interface ToolServerSeen {
    server: string;
    /** `mcpServer.type`: stdio, http, sse, ws, sdk (in-process, the Desktop app's own), sse-ide, ws-ide, claudeai-proxy. */
    type: string;
    /** Its tools the engine described in that session. */
    tools: number;
    /** Every one of them came already behind tool search (the engine's own rule). */
    deferredByHost: boolean;
    /** The mod put them behind tool search (CONTEXT_DOCTOR_DEFER_MCP named the server). */
    movedByUs: boolean;
}
/** One session's servers. */
export interface ToolsLine {
    ts: number;
    sid: string;
    /** `session.start`'s surface: desktop, terminal, vscode; absent when the engine gave none. */
    surface?: string;
    servers: ToolServerSeen[];
}
export declare function toolsLogPath(): string;
/** The servers as the mod sent them, cleaned: valid names and types only, each once, sorted by name. */
export declare function cleanServers(list: unknown): ToolServerSeen[];
/**
 * Append a session's servers, unless its last line says the same (the mod
 * sends them again only when they changed, and a second window of the same
 * session may send them too). Never throws. True when a line was written.
 */
export declare function recordToolServers(line: {
    ts: number;
    sid: string;
    surface?: string;
    servers: unknown;
}, path?: string): boolean;
/** Every line since `since`, each session's last only (a session's servers grow as they connect). */
export declare function readToolLines(since?: number, path?: string): ToolsLine[];
/** A Desktop session: the surface says so, or (no surface given) the app's own servers are in it. */
export declare function isDesktopLine(l: ToolsLine): boolean;
/** The newest Desktop session the mod recorded, or undefined. */
export declare function newestDesktop(lines: ToolsLine[]): ToolsLine | undefined;
/**
 * What the newest Desktop session says of the servers the lever would name:
 * those that arrive whole (the setting reaches them), those Claude Code
 * already keeps behind tool search (nothing to do), those the mod was never
 * shown (the setting would not reach them). Undefined with no Desktop session
 * on record: not yet known.
 */
export interface AppToolsVerdict {
    at: number;
    reach: ToolServerSeen[];
    hostDefers: ToolServerSeen[];
    unseen: string[];
}
export declare function appToolsVerdict(lines: ToolsLine[], servers: readonly string[]): AppToolsVerdict | undefined;
/** The verdict's sentences, for fix's lines. */
export declare function verdictLines(v: AppToolsVerdict): string[];
/** Sessions in which the mod moved a server's tools behind tool search, and the first of them. */
export declare function movedSessions(lines: ToolsLine[]): {
    sessions: number;
    since?: number;
    servers: string[];
};
/**
 * `doctor`'s line: the servers the newest Desktop session handed the mod,
 * their type, and what desktop-tools-defer would do with them. A fact, not a
 * fault. Undefined when the mod recorded no Desktop session.
 */
export declare function appToolsCheckText(lines: ToolsLine[]): string | undefined;
/** The ledger's lines of the last `days`, never throwing. */
export declare function recentToolLines(days?: number, now?: number, path?: string): ToolsLine[];
