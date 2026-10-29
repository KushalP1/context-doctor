/**
 * `context-doctor limits`: your plan's usage limits, in their own unit.
 *
 * Subscriptions are billed in % of a 5-hour and a weekly window (Claude
 * Pro/Max), or in credits per token (Codex since April 2026), and neither
 * vendor shows where the percentage went. Two local sources say:
 *
 *  - Claude Code hands its status line command `rate_limits.five_hour` and
 *    `.seven_day`, each `{used_percentage, resets_at}` (documented at
 *    code.claude.com/docs/en/statusline; built in 2.1.308 as
 *    Math.round(utilization*1000)/10, so 0.1% steps; present only for
 *    Pro/Max subscribers, after the first reply). `context-doctor statusline`
 *    appends each new reading to a small local log (recordLimits).
 *  - Codex records `rate_limits.primary` / `.secondary`
 *    `{used_percent, window_minutes, resets_at}` on every token_count event of
 *    its rollouts (~/.codex/sessions), next to that request's usage, in
 *    whole percent.
 *
 * From the readings: the current %, the pace, and when each window runs out
 * at that pace. And, by fitting each rise in % against the usage recorded on
 * this machine over the same interval, an estimate of what 1M tokens of each
 * kind cost in % of the limit, with the fit's error. Usage elsewhere (claude.ai
 * in a browser, another computer) moves the % without leaving a transcript
 * here; it shows up as error, and rises with no local usage at all are
 * counted apart. When the fit is too thin to trust, the report says so
 * instead of printing a number.
 */
import { type Extractor } from "./scan.js";
/** Claude Code's two windows, as its status line input names them. */
export declare const CLAUDE_WINDOWS: readonly ["five_hour", "seven_day"];
/** One reading of one window: how much of it was used at `ts`. */
export interface LimitReading {
    /** When it was read, ms. */
    ts: number;
    app: "claude" | "codex";
    /** "five_hour", "seven_day", or for Codex "codex:[<plan>:][<limit id>:]<minutes>". */
    window: string;
    /** Percent used, 0-100 (a gateway's spend can pass 100). */
    pct: number;
    /** When the window resets, ms. */
    resetsAt?: number;
    /** The window's length, ms, when known. */
    windowMs?: number;
    /** Codex's plan ("plus", "team", "free"...). */
    plan?: string;
}
/** One request's usage, from a transcript on this machine. */
export interface UsagePoint {
    ts: number;
    app: "claude" | "codex";
    model?: string;
    /** Uncached input, cache reads, cache writes, output: tokens. */
    input: number;
    read: number;
    write: number;
    output: number;
    /** At API list price; 0 when the model has no price on file. */
    usd: number;
}
/** Beside the hook state and the ledger: ~/.claude/.context-doctor-limits.jsonl. */
export declare function limitsLogPath(): string;
/**
 * Append what changed in Claude Code's `rate_limits` to the log: a window
 * whose % or reset time moved since its last line, or that has not been
 * written for 15 minutes. Nothing when there are no limits (an API key,
 * Bedrock, Vertex). Never throws: the status line must stay silent. Returns
 * the lines written.
 */
export declare function recordLimits(rateLimits: unknown, now?: number, path?: string): number;
/** Every Claude reading in the log since `since`. */
export declare function readClaudeReadings(since?: number, path?: string): LimitReading[];
export declare function codexSessionsRoot(home?: string): string;
/**
 * Codex readings and usage since `since`. A token_count event repeats the
 * last request's usage when only the limits were refreshed, so a request is
 * counted when the running total moves.
 */
export declare function codexLimitData(since: number, root?: string): {
    readings: LimitReading[];
    usage: UsagePoint[];
};
/**
 * Every Claude Code request between `since` and `until`, main threads and
 * subagents alike (both draw on the same limits), each reply once.
 */
/**
 * What the usage fit takes from a Claude Code transcript (subagents' too):
 * every assistant row with usage, in order. A later row of a reply already
 * met keeps only its id and output tokens: it is a repeat, read only for the
 * output a streamed reply settles on its last row.
 */
export declare const USAGE_ROWS: Extractor<{
    ids: Record<string, 1>;
}>;
export declare function claudeUsage(since: number, until?: number, paths?: string[]): UsagePoint[];
export interface WindowStatus {
    window: string;
    label: string;
    app: "claude" | "codex";
    pct: number;
    /** When the newest reading was taken. */
    at: number;
    resetsAt?: number;
    /** True when the newest reading's window has reset since (its % is stale). */
    resetSince: boolean;
    /** Points per hour over the recent stretch (the last hour of a 5-hour window, the last day otherwise). */
    recentPerHour?: number;
    /** Points per hour since the window began, when its length is known. */
    averagePerHour?: number;
    /** At the recent pace: when it reaches 100%, and whether that is before the reset. */
    runsOutAt?: number;
    beforeReset?: boolean;
    readings: number;
    plan?: string;
}
export declare function windowLabel(window: string, windowMs?: number): string;
/**
 * One window's readings, in time order, without the stale ones: a reading
 * lower than an earlier one of the same period comes from another session
 * (two Claude Code windows, two Codex sessions) still holding an older
 * figure. Within a period usage only grows, so it is dropped, never read as
 * a new period or a fall in the pace. Logs written before 0.38 hold them.
 */
export declare function cleanReadings(readings: LimitReading[]): LimitReading[];
/** 0.1 when any reading has a fraction (Claude), else 1 (Codex's whole percents). */
export declare function resolutionOf(readings: LimitReading[]): number;
export declare function windowStatus(readings: LimitReading[], now?: number): WindowStatus | undefined;
/** A stretch of one window's period in which the % rose by `dpct`, with the usage recorded in it. */
export interface Segment {
    from: number;
    to: number;
    dpct: number;
    /** Millions of tokens: uncached input, cache read, cache write, output. */
    x: [number, number, number, number];
    usd: number;
    requests: number;
}
export declare const TOKEN_TYPES: readonly ["input", "cache read", "cache write", "output"];
/**
 * Cut each period into stretches of at least `stretchMs` (half an hour on
 * Claude's 0.1% steps, three hours on Codex's whole percents) and sum the
 * usage that falls inside each. Cut by time, not by rise: stretches then
 * differ in how much was used, which is what the fit learns from, and a
 * quiet stretch says as much as a busy one. A rise with no local usage at
 * all is usage elsewhere: counted, kept out of the fit; a quiet stretch with
 * no rise is left out.
 */
export declare function segmentsOf(readings: LimitReading[], usage: UsagePoint[], stretchMs?: number): {
    segments: Segment[];
    elsewhere: number;
    elsewherePct: number;
};
/**
 * Non-negative least squares through the origin, exactly, by trying every
 * subset of columns (four token types: sixteen subsets) and keeping the best
 * fit whose coefficients are all non-negative. Columns with almost no data
 * are left out and reported as such.
 */
export declare function nnls(rows: number[][], y: number[], usable: number[]): number[];
export interface FitQuality {
    /** 1 - SSE / total sum of squares around the mean: share of the variation explained (shown, not a gate). */
    r2: number;
    /** Cross-validated prediction error, in points of the limit per stretch. */
    looRmse: number;
    /** looRmse relative to the mean rise per stretch. */
    relError: number;
    /** Price fit only: the coefficient's standard error relative to the coefficient. */
    relSe?: number;
}
export interface LimitFit {
    window: string;
    label: string;
    app: "claude" | "codex";
    segments: number;
    /** Points the window rose over the fitted segments. */
    totalPct: number;
    /** Rises with no usage on this machine (usage elsewhere), left out. */
    elsewhere: number;
    elsewherePct: number;
    resolution: number;
    /** Requests and list-price dollars the segments hold. */
    requests: number;
    usd: number;
    /** % of the limit per 1M tokens of each type; undefined for a type with too little data. */
    perMillion?: Partial<Record<(typeof TOKEN_TYPES)[number], number>>;
    byType?: FitQuality;
    /** % of the limit per list-price dollar, and how well that alone explains the rises. */
    pctPerUsd?: number;
    byPrice?: FitQuality;
    /** The model most of the dollars went to, which the per-1M figures from price are for. */
    mainModel?: string;
    /** Stretches left out of the price fit for rising far beyond their usage (use elsewhere at the same time), and the excess points. */
    outliers?: number;
    outlierPct?: number;
    /** With an intercept, the slope's standard error relative to it: large when the rises do not follow the usage. */
    slopeRelSe?: number;
    /** Good enough to put savings in % of this limit. */
    usable: boolean;
    /** Why not, in words, when it is not. */
    why?: string;
}
export declare function fitWindow(readings: LimitReading[], usage: UsagePoint[], stretchMs?: number): LimitFit | undefined;
export interface LimitsReport {
    days: number;
    now: number;
    /** Where the Claude readings are logged, and how many there are. */
    claudeLog: string;
    claudeReadings: number;
    codexReadings: number;
    windows: WindowStatus[];
    fits: LimitFit[];
}
export interface LimitsOptions {
    now?: number;
    logPath?: string;
    codexRoot?: string;
    /** Claude Code transcripts to read usage from (default: every one touched in the period). */
    claudePaths?: string[];
    /** Leave Codex out (savings and the other Claude Code reports). */
    claudeOnly?: boolean;
}
export declare function limitsReport(days?: number, opts?: LimitsOptions): LimitsReport;
/** The Claude fit to quote savings in: the weekly window first (savings are weekly), then the 5-hour one. */
export declare function claudeLimitFit(r: LimitsReport): LimitFit | undefined;
/**
 * A dollar saving over `days`, in the limit's own unit: for the weekly
 * limit, points of it a week ("≈ 4.1% of your weekly limit a week (±0.4)");
 * for the 5-hour window, how many whole windows the saving amounts to. The
 * ± is the rate's own standard error: a saving sums many stretches, so the
 * per-stretch miss averages out and the rate's error is what remains.
 */
export declare function inLimit(fit: LimitFit, usd: number, days: number): string | undefined;
/**
 * Lines for the Claude Code reports: each lever's saving in the limit, when
 * a fit is good enough; nothing otherwise (never a number the fit cannot
 * carry). Kept within 60 columns, as `savings` is.
 */
export declare function limitSavingsLines(fit: LimitFit | undefined, items: Array<[label: string, usd: number]>, days: number): string[];
export declare function renderLimits(r: LimitsReport): string;
