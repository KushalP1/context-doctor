/**
 * `context-doctor overhead`: what every request pays before you type.
 *
 * Each request an agent sends re-sends the same front matter: the harness's
 * system prompt, tool and MCP schemas, skills, and the memory files the user
 * wrote (CLAUDE.md and its imports, rules, auto memory, AGENTS.md, Cursor
 * rules, GEMINI.md). It is cached, so each read is cheap, but it is read on
 * every request of every session, and at full write price after every cold
 * start. Nobody sees it: transcripts do not contain it.
 *
 * Two measurements, both local:
 *  - the fixed overhead itself, from the first request of each Claude Code
 *    session (the API's own count, minus the first user message);
 *  - the memory files that load in a directory, sized with Claude's ratios and
 *    priced per month from the user's own request and cold-start counts.
 */
export type Agent = "Claude Code" | "Codex" | "Cursor" | "Gemini CLI";
export interface MemoryFile {
    agent: Agent;
    path: string;
    tokens: number;
    /** Why it loads: "project", "user", "import", "rules", "auto memory". */
    via: string;
}
export interface OverheadFinding {
    severity: "warn" | "info";
    message: string;
    suggestion: string;
}
export interface Baseline {
    sessions: number;
    /** Median tokens of the first request, minus the first user message. */
    median: number;
    p90: number;
    requests: number;
    coldStarts: number;
    days: number;
    model?: string;
    /** USD a month for each 1,000 tokens of fixed overhead, at this usage. */
    usdPerKPerMonth?: number;
}
export interface OverheadReport {
    cwd: string;
    baseline?: Baseline;
    files: MemoryFile[];
    findings: OverheadFinding[];
    mcpServers: string[];
}
/** Every memory file the four agents load for a session started in `cwd`. */
export declare function findMemoryFiles(cwd?: string, home?: string): MemoryFile[];
/**
 * Fixed overhead per session, measured: the first main-chain request's input
 * (input + cache read + cache write) minus the first user message, plus the
 * request and cold-start counts that turn tokens into a monthly bill.
 */
export declare function measureBaseline(days?: number, paths?: string[]): Baseline | undefined;
/** What is worth changing in the memory files. */
export declare function overheadFindings(files: MemoryFile[], baseline?: Baseline): OverheadFinding[];
/** MCP servers Claude Code starts in `cwd`: user scope, project scope (~/.claude.json) and .mcp.json. */
export declare function claudeMcpServers(cwd?: string, home?: string): string[];
export declare function overheadReport(opts?: {
    cwd?: string;
    home?: string;
    days?: number;
    paths?: string[];
}): OverheadReport;
export declare function renderOverhead(r: OverheadReport, home?: string): string;
