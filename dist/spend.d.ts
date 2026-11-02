/**
 * `context-doctor spend`: one bill across every AI coding tool on this
 * machine, at list prices.
 *
 * Each tool keeps its own record of what it sent, and none adds them up:
 *
 *  - Claude Code: every reply's `usage` in its transcripts, the main
 *    conversation and each subagent's (`<session>/subagents/agent-*.jsonl`),
 *    read as `limits` reads them (claudeFileUsage): each reply once, its
 *    output settled on its last row, a fork's copy of its parent counted once.
 *  - Codex: the `token_count` events of its rollouts (~/.codex/sessions and
 *    archived_sessions), a request each time the running total moves, as
 *    `limits` counts them; the model from `turn_context`, the folder from
 *    `session_meta`.
 *  - Gemini CLI: each `gemini` message's `tokens` in ~/.gemini/tmp/<project>/chats,
 *    the last copy of a message written twice. A message later rewound was
 *    still billed, so it is counted.
 *  - Cursor: the `tokenCount` on its agent replies (cursorUsage). It records
 *    no cache split, so every input token is priced uncached: an estimate,
 *    and an upper bound. Replies on Auto ("default") have no list price and
 *    are counted, not priced.
 *
 * Priced at pricing.ts's list prices (usageCost), as every report here is.
 * Claude Code, Codex and Gemini CLI are read through the shared scan
 * (scan.ts), so a second run reads only what was appended since; Cursor's
 * replies are kept per chat until the chat changes.
 *
 * `savings` bills a narrower slice of the same Claude Code requests: the main
 * conversation's input (cache writes and reads included, output not), in
 * sessions with 10+ requests. `spend` counts every request, its output and
 * subagents too; on the requests both count, the dollars are the same.
 */
import { type Extractor } from "./scan.js";
export type Tool = "claude" | "codex" | "gemini" | "cursor";
export declare const TOOLS: Tool[];
export declare const TOOL_NAME: Record<Tool, string>;
/** One request (a Cursor reply), priced. */
export interface SpendItem {
    tool: Tool;
    ts: number;
    project: string;
    /** The session it belongs to: its transcript's name, or Cursor's chat id. */
    session: string;
    model?: string;
    input: number;
    read: number;
    write: number;
    output: number;
    /** At list price; 0 when the model has no price on file (`priced` false). */
    usd: number;
    inputUsd: number;
    writeUsd: number;
    readUsd: number;
    outputUsd: number;
    priced: boolean;
    /** Claude Code: run by a subagent. */
    subagent?: boolean;
    /** Claude Code: the reply's row uuid, which a fork's copy shares. */
    key?: string;
}
/** A project's name as `savings` shows it: the folder's path with "-" for separators, less "-Users-<you>-". */
export declare function projectName(folder: string): string;
/**
 * Claude Code's requests between `since` and `until`, main threads and
 * subagents, over `tops` (default: every transcript written since `since`).
 */
export declare function claudeSpend(since: number, until?: number, tops?: string[], onProgress?: (done: number, total: number) => void): SpendItem[];
/**
 * What `spend` takes from a Codex rollout: its folder, each model change,
 * and every token_count event's last request and running total.
 */
export declare const CODEX_SPEND_ROWS: Extractor<null>;
/** The requests of one Codex rollout since `since`. Throws when it cannot be read. */
export declare function codexFileSpend(file: string, since: number, until?: number): SpendItem[];
/** Codex rollouts written since `since`: the live ones and the archived. */
export declare function codexFiles(since: number, home?: string): string[];
export declare function codexSpend(since: number, until?: number, home?: string): SpendItem[];
/**
 * What `spend` takes from a Gemini CLI chat (JSONL): each `gemini` message's
 * id, time, model and token counts. A message without a time of its own
 * takes the last time met before it.
 */
export declare const GEMINI_SPEND_ROWS: Extractor<{
    ts: string;
}>;
/** The billed messages of one Gemini CLI chat since `since`. Throws when it cannot be read. */
export declare function geminiFileSpend(file: string, since: number, until?: number): SpendItem[];
export declare function geminiFiles(since: number, home?: string): string[];
export declare function geminiSpend(since: number, until?: number, home?: string): SpendItem[];
export declare function cursorSpend(since: number, until?: number): SpendItem[];
export interface ToolSpend {
    tool: Tool;
    name: string;
    usd: number;
    requests: number;
    tokens: {
        input: number;
        read: number;
        write: number;
        output: number;
    };
    /** Claude Code: what its subagents cost, inside `usd`. */
    subagentUsd?: number;
    /** Cursor: priced without a cache split, an upper bound. */
    estimate?: boolean;
    /** Requests whose model has no list price, counted but not in `usd`. */
    unpriced: number;
    unpricedTokens: number;
    unpricedModels: string[];
}
export interface SpendRow {
    usd: number;
    requests: number;
    byTool: Partial<Record<Tool, number>>;
}
export interface SpendReport {
    days: number;
    since: number;
    until: number;
    usd: number;
    requests: number;
    tools: ToolSpend[];
    projects: Array<SpendRow & {
        project: string;
    }>;
    models: Array<SpendRow & {
        model: string;
    }>;
    /** Every local day of the window, oldest first. */
    daily: Array<SpendRow & {
        day: string;
    }>;
    /** The bill by what it paid for. */
    parts: {
        inputUsd: number;
        writeUsd: number;
        readUsd: number;
        outputUsd: number;
    };
    sessions: Array<{
        tool: Tool;
        project: string;
        session: string;
        model?: string;
        usd: number;
        requests: number;
        first: number;
        last: number;
    }>;
    /** A tool that could not be read (Cursor without SQLite), and why. */
    skipped: Array<{
        tool: Tool;
        reason: string;
    }>;
}
/** The local calendar day of `ts`, "YYYY-MM-DD". */
export declare function localDay(ts: number): string;
/** Add up priced requests into the report. */
export declare function summarizeSpend(items: SpendItem[], days: number, since: number, until: number, skipped?: SpendReport["skipped"]): SpendReport;
export interface SpendOptions {
    home?: string;
    /** Claude Code transcripts to read instead of every one written in the window (tests). */
    claudePaths?: string[];
    onProgress?: (done: number, total: number) => void;
    now?: number;
}
/** The last `days` days, every tool on this machine. A tool with nothing on disk is just absent. */
export declare function spendReport(days?: number, opts?: SpendOptions): SpendReport;
export declare const usd: (n: number) => string;
/** The full report, kept within 80 columns. `top`: rows per list. */
export declare function renderSpend(r: SpendReport, top?: number): string;
/**
 * `spend --share`: totals only. No project names, paths or session ids, so
 * sharing it leaks nothing.
 */
export declare function renderSpendShare(r: SpendReport): string;
