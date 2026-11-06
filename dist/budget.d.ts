/**
 * `context-doctor budget`: a spend budget the every-prompt hook enforces.
 *
 * `budget 50/day` (or `200/week`) is kept in ~/.claude/.context-doctor-budget.json.
 * Before each prompt the hook (Claude Code's UserPromptSubmit, Codex's
 * UserPromptSubmit, Gemini CLI's BeforeAgent) adds up what today (or this
 * week, from Monday) has cost across Claude Code, Codex and Gemini CLI, as
 * `spend` prices it, and says so to the user once per threshold: at 50%, 80%
 * and 100%. With `--block`, over the budget it holds the prompt in each
 * host's documented way (`decision: "block"` with a reason in Claude Code and
 * Codex, `decision: "deny"` in Gemini CLI), saying how to lift it. Cursor is
 * not counted: its history is a database too slow to read on every prompt,
 * and its prompt hook cannot add a line.
 *
 * The hook must stay fast, so the period's spend is a ledger
 * (~/.claude/.context-doctor-budget-state.json): per transcript, its size,
 * time and inode when last read, and the period's requests in it (a short
 * key and the dollars). A transcript met for the first time in a period is
 * read through the shared scan (scan.ts), as `spend` reads it; after that a
 * prompt reads only what was appended to the transcripts that changed, a
 * few kilobytes, without loading the scan's records for a whole transcript
 * (megabytes for a long one). The keys let a fork's copy of its parent's
 * replies count once. Measured on the author's history: docs/spend.md.
 */
import { type Tool } from "./spend.js";
export type Period = "day" | "week";
export interface Budget {
    usd: number;
    period: Period;
    /** Over the budget, hold the prompt instead of only saying so. */
    block: boolean;
    /** When it was set, ms. */
    at: number;
}
/** Beside the hook state and the ledger: ~/.claude/.context-doctor-budget.json. */
export declare function budgetPath(): string;
/** The period's spend ledger and what was said: ~/.claude/.context-doctor-budget-state.json. */
export declare function budgetStatePath(): string;
/**
 * "50/day", "$200/week", "7.5/d", "100/wk", "50/days": a budget, or an
 * error to show. Dollars are kept to the cent (50.555 was stored as given
 * and shown as $50.55); `note` says so when the amount was rounded.
 */
export declare function parseBudget(arg: string): {
    usd: number;
    period: Period;
    note?: string;
} | {
    error: string;
};
export declare function readBudget(): Budget | undefined;
/** A whole file renamed into place, so two prompts at once never read half of one. */
export declare function writeWhole(path: string, value: unknown): void;
export declare function writeBudget(b: Budget): void;
/** Remove the budget and its ledger. True when there was one. */
export declare function clearBudget(): boolean;
/** The start of the period holding `now`: local midnight, or Monday's for a week. */
export declare function periodStart(period: Period, now?: number): number;
/** When the period holding `now` ends (the next one starts). */
export declare function periodEnd(period: Period, now?: number): number;
/**
 * One transcript as last read: size, time, inode; the period's requests in
 * it as keys ("" for none) and dollars. A Claude Code transcript also keeps
 * where reading stopped (`o`, after the last whole line) and its last
 * replies (`r`: message id, index into k/d or -1, output so far, output
 * price per 1M), so an append is read from there: a reply's later rows are
 * met within its last few, and only settle its output. `a` fingerprints the
 * bytes before `o` (the shared scan's anchorOf): a transcript rewritten in
 * place, same inode and no smaller, is read again in full, not from `o`.
 * `x` lists the requests on a model with no list price (index into k/d,
 * model): in `d` at $0, and said so rather than silently left out. `y`
 * lists those priced only by their model's family (an estimate), the same way.
 */
export interface FileEntry {
    t: Tool;
    s: number;
    m: number;
    i: number;
    k: string[];
    d: number[];
    o?: number;
    a?: string;
    r?: Array<[string, number, number, number]>;
    x?: Array<[number, string]>;
    y?: Array<[number, string]>;
}
/** A ledger entry this version can use: a damaged one threw on every prompt until its transcript changed. */
export declare function wellFormed(e: FileEntry | undefined): e is FileEntry;
/**
 * One transcript's entry brought up to date: kept when the file is as last
 * read, read from where the last read stopped when a Claude Code transcript
 * only grew, read in full otherwise. `read`: the bytes read, -1 when the
 * entry was kept as it was. Undefined when the file cannot be read now.
 * `direct`: a Claude Code transcript met for the first time is read here,
 * not through the shared scan, which keeps a cache entry of it on disk (the
 * session price reads one session, and writes nothing while it has nothing
 * to say).
 */
export declare function refreshEntry(tool: Tool, file: string, prev: FileEntry | undefined, since: number, direct?: boolean): {
    e: FileEntry;
    read: number;
} | undefined;
export interface PeriodSpend {
    start: number;
    end: number;
    usd: number;
    byTool: Partial<Record<Tool, number>>;
    /** Requests on a model with no list price: counted here, not in `usd`. */
    unpriced?: {
        requests: number;
        models: string[];
    };
    /** Requests on a model priced only by its family: in `usd`, an estimate. */
    estimated?: {
        requests: number;
        usd: number;
        models: string[];
    };
}
/**
 * What the period holding `now` has cost so far, across Claude Code, Codex
 * and Gemini CLI. Re-reads only the transcripts that changed since the last
 * call (any process's), then writes the ledger back. `warn` (the hook's) is
 * the threshold reached, recorded as said, when it is one not said yet.
 */
export declare function periodSpend(period: Period, now?: number, home?: string, warnAt?: (usd: number, warned: number) => number): PeriodSpend & {
    warn?: number;
    unpricedNew?: boolean;
};
/** The thresholds the hook speaks at. */
export declare const THRESHOLDS: readonly [50, 80, 100];
/** The highest threshold `usd` has reached of `budget` (0 below the first). */
export declare function levelOf(usd: number, budget: number): number;
export interface BudgetVerdict {
    /** A line for the user, once per threshold per period. */
    message?: string;
    /** Over the budget with --block: why the prompt is held, and how to lift it. */
    block?: string;
    spend: PeriodSpend;
    budget: Budget;
}
/**
 * The hook's check: undefined with no budget set (one failed read: the hot
 * path stays a stat), otherwise the spend so far and what to say or do.
 */
export declare function budgetVerdict(now?: number, home?: string): BudgetVerdict | undefined;
/** The status line's part: "$12/$50 today", or undefined with no budget set. */
export declare function budgetStatus(now?: number, home?: string): string | undefined;
/** `budget` with no argument, and after setting one: the budget and where the period stands. */
export declare function renderBudgetStatus(b: Budget | undefined, s: PeriodSpend | undefined, hookInstalled: boolean): string;
/** Our every-prompt hook in Claude Code, Codex or Gemini CLI, or the plugin's. */
export declare function promptHookInstalled(home?: string): boolean;
