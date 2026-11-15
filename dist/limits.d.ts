/**
 * `context-doctor limits`: your plan's usage limits, in their own unit.
 *
 * Subscriptions are billed in % of a weekly window and, on most plans, a
 * 5-hour one (Claude Pro, Max and Ultra; since 2026-10-30 Max 5x is called
 * Max and Max 20x Ultra, and Ultra has no 5-hour window), or in credits per
 * token (Codex since April 2026), and neither vendor shows where the
 * percentage went. Local sources say:
 *
 *  - Claude Code hands its status line command `rate_limits.five_hour` and
 *    `.seven_day`, each `{used_percentage, resets_at}` (documented at
 *    code.claude.com/docs/en/statusline; built in 2.1.308 as
 *    Math.round(utilization*1000)/10, so 0.1% steps; present only for
 *    subscribers, after the first reply; `five_hour` absent on Ultra), and
 *    the same windows to the plugin's mod (`session.measure`). The status
 *    line, the mod and the proxy (from the API's
 *    `anthropic-ratelimit-unified-5h-*` / `-7d-*` headers) append each new
 *    reading to a small local log (recordLimits).
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
import { type ModelPricing, type Modifiers, type RecordedUsage } from "./pricing.js";
import { type CompactionRequest } from "./compactcost.js";
/** Claude Code's two windows, as its status line input names them. */
export declare const CLAUDE_WINDOWS: readonly ["five_hour", "seven_day"];
/** What wrote a Claude reading: the status line, the plugin's mod, or the proxy. */
export type LimitSource = "statusline" | "mod" | "proxy";
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
    /** What recorded it (Claude readings written from 0.49 on; older lines have none). */
    source?: LimitSource;
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
    /** Claude Code's entrypoint ("cli", "claude-desktop", "sdk-cli"...) and version, from the transcript's rows. */
    entrypoint?: string;
    version?: string;
}
/** Beside the hook state and the ledger: ~/.claude/.context-doctor-limits.jsonl. */
export declare function limitsLogPath(): string;
/**
 * Append what changed in Claude Code's `rate_limits` to the log: a window
 * whose % or reset time moved since its last line, or that has not been
 * written for 15 minutes. Nothing when there are no limits (an API key,
 * Bedrock, Vertex). A window that is not there (Ultra's 5-hour one) is
 * simply not written. Never throws: the status line must stay silent.
 * Returns the lines written.
 */
export declare function recordLimits(rateLimits: unknown, now?: number, path?: string, source?: LimitSource): number;
/** Every Claude reading in the log since `since`. */
export declare function readClaudeReadings(since?: number, path?: string): LimitReading[];
/**
 * The windows an Anthropic response's `anthropic-ratelimit-unified-5h-*` and
 * `-7d-*` headers carry (a claude.ai sign-in, or a gateway), in the status
 * line's shape for recordLimits: utilization is a fraction, the reset epoch
 * seconds. Claude Code reads the same headers into its status line and its
 * mods (Math.round(utilization*1000)/10). Undefined when there are none; a
 * response with only the weekly pair (Ultra) gives only the weekly window.
 */
export declare function rateLimitsFromHeaders(get: (name: string) => string | null | undefined): Record<string, {
    used_percentage: number;
    resets_at?: number;
}> | undefined;
export declare function codexSessionsRoot(home?: string): string;
/** Codex rollouts under `root` (YYYY/MM/DD folders, or flat) written since `since`. */
export declare function rolloutFiles(root: string, since: number): string[];
/** The token counts a Codex event's identity is made of, in its running total and its last request. */
export declare const CODEX_USAGE_FIELDS: readonly ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"];
/**
 * A Codex token_count event's identity: its running total and its last
 * request. A forked rollout (a subagent's, a fork of a thread) begins with a
 * copy of its parent's history, token_count events included, all stamped at
 * the moment of the fork: seen on this machine, a subagent's rollout repeated
 * 11 of its parent's 18 requests. The copy carries the same counts, so this
 * key counts each request once, however many rollouts hold it. "" when the
 * event has no running total (nothing to tell a copy by).
 */
export declare function codexEventKey(total: unknown, last: unknown): string;
/**
 * Codex readings and usage since `since`. A token_count event repeats the
 * last request's usage when only the limits were refreshed, so a request is
 * counted when the running total moves. A forked rollout's copy of its
 * parent's events (codexEventKey) is counted once, at the earliest time met:
 * the copy is stamped at the fork, its limits readings stale by then.
 */
export declare function codexLimitData(since: number, root?: string): {
    readings: LimitReading[];
    usage: UsagePoint[];
};
/**
 * What the usage fit takes from a Claude Code transcript (subagents' too):
 * every assistant row with usage, in order. A later row of a reply already
 * met keeps only its id, its output tokens and its billed iterations: it is
 * a repeat, read only for what a streamed reply settles on its last row.
 * `isSidechain` is kept for `spend`, which tells a subagent inlined in an
 * older transcript from the main thread. A request's `usage.iterations` is
 * kept only where some bill beyond its top-level usage (extraIterations).
 * Also Claude Code's own running cost: each `cost-state` row as
 * costStateRecord keeps it, with the Claude Code version of the replies
 * before it (ccost.ts compares it with ours).
 */
export declare const USAGE_ROWS: Extractor<{
    ids: Record<string, 1>;
    v?: string;
}>;
/** A compaction's estimated request as a request point (no message id: its key is the boundary's uuid). */
export declare function compactionPoint(c: CompactionRequest): ClaudeRequest;
/** One Claude Code request as `claudeFileUsage` reads it: the usage point, and what `spend` and `budget` add up. */
export interface ClaudeRequest extends UsagePoint {
    /** The row's uuid: what tells a fork's copy of a reply from the reply itself. */
    uuid?: string;
    /** The reply's message id, which its later rows share. */
    id?: string;
    /** Written as a subagent's, inline in the main transcript (older Claude Code). */
    sidechain?: boolean;
    /** The prompt's part of `usd` (input, cache writes, cache reads): what `savings` bills. */
    promptUsd: number;
    /** The rates it billed at (requestCost: its tier, fast mode, US-only, its date); absent when unpriced. */
    rates?: ModelPricing;
    /** What fast mode, US-only, a long prompt's tier and web searches added to its list price, inside `usd`. */
    modifiers: Modifiers;
    /** Priced by family, or past the day its row's price changed: an estimate. */
    estimated?: boolean;
    /** Its row's price changed on this day, before the request. */
    changedOn?: string;
    /** A compaction's own request, which no row records usage for: estimated (compactcost.ts). */
    compaction?: boolean;
    /**
     * The iterations its top-level usage leaves out (extraIterations: an
     * advisor's call, an attempt a fallback replaced), each priced at its own
     * model by requestCost: inside `usd`, `promptUsd` and `modifiers`, not in
     * the token counts above (those are the top-level usage's).
     */
    extra?: IterationPoint[];
}
/** One iteration billed beyond its request's top-level usage, priced (requestCost at its own model). */
export interface IterationPoint {
    type: string;
    model?: string;
    input: number;
    read: number;
    write: number;
    output: number;
    /** 0 when its model has no price (`priced` false). */
    usd: number;
    promptUsd: number;
    priced: boolean;
    modifiers: Modifiers;
    estimated?: boolean;
    changedOn?: string;
}
/** A request's iterations billed beyond its top-level usage, each priced at its own model (the request's when it names none) at `ts`. */
export declare function iterationPoints(model: string | undefined, u: RecordedUsage, ts: number): IterationPoint[];
/**
 * The requests of one Claude Code transcript between `since` and `until`,
 * each reply once, its output settled on its last row (billed at the
 * reply's own rates, requestCost's). `runRows` is shared by every file of
 * one report, so a fork's copy of its parent's replies is counted once, in
 * the file met first (replyCounter). Replies on `<synthetic>`
 * (isUnbilledModel) are left out. Throws when the transcript cannot be read.
 */
export declare function claudeFileUsage(file: string, since: number, until?: number, runRows?: Set<string>): ClaudeRequest[];
/**
 * The Claude Code transcripts written since `since`: each session's main
 * transcript (`tops`, or every one under the projects folder, newest
 * first), each followed by its subagents'.
 */
export declare function claudeUsageFiles(since: number, tops?: string[]): Array<{
    file: string;
    top: string;
    subagent: boolean;
    run?: string;
}>;
/** How long before a period a session may have been last written and still have subagents running into it. */
export declare const SUBAGENT_LOOKBACK_MS: number;
/**
 * Which Claude Code wrote a transcript, and when that changed: every row
 * carries `entrypoint` ("cli", "claude-desktop", "sdk-cli" for `claude -p`,
 * "claude-vscode"...) and `version`; a record is kept only where either
 * changes (a session resumed after an update), so a file has one or two.
 */
export declare const HOST_ROWS: Extractor<{
    ep?: string;
    v?: string;
}>;
/**
 * Every Claude Code request between `since` and `until`, main threads and
 * subagents alike (both draw on the same limits), each reply once, with
 * the entrypoint and Claude Code version it was made from.
 */
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
    /** True when the newest reading is older than the stretch the pace is read over (an hour for a 5-hour window, a day otherwise): its pace is no forecast. */
    stale?: boolean;
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
/**
 * One fit over every reading assumes a percent of the limit always costs the
 * same. It does not: people measured 1% of the week falling from ~$30 to ~$4
 * of API-equivalent use within a week (claude-code#108272), and `claude -p`
 * draining ~1.8x more per token than the terminal (#97074). So each weekly
 * window (one reset to the next) gets its own figure, and the report says
 * when the figure moved, by how much, and on what date.
 */
/** What one entrypoint or model used inside a window's stretches. */
export interface UsageShare {
    key: string;
    usd: number;
    tokens: number;
    requests: number;
    /** Its part of the window's API-equivalent dollars, 0-1. */
    share: number;
    /** Dollars per 1% for this key alone, when the stretches tell the keys apart (one column per key); with its relative standard error. */
    usdPerPct?: number;
    relSe?: number;
}
/** One weekly window, reset to reset. */
export interface ResetWindow {
    window: string;
    label: string;
    app: "claude" | "codex";
    /** When it began (its reset less its length) and when it resets, ms. */
    start: number;
    resetsAt: number;
    /** Still running at the report's time. */
    current: boolean;
    readings: number;
    firstReading: number;
    lastReading: number;
    /** The highest % read in it. */
    pctUsed: number;
    /** Points risen in stretches with usage on this machine, and in stretches with none (used elsewhere: claude.ai, another computer). */
    pctMatched: number;
    pctElsewhere: number;
    stretches: number;
    /** Requests, API-equivalent dollars (requestCost, at list price) and tokens of every kind in those stretches. */
    requests: number;
    usd: number;
    tokens: number;
    /** Dollars and tokens per 1% of the limit (ratio of the sums), and the ratio's relative standard error across stretches. */
    usdPerPct?: number;
    tokensPerPct?: number;
    relSe?: number;
    /** Why there is no figure, when there is none. */
    why?: string;
    byEntrypoint: UsageShare[];
    byModel: UsageShare[];
    /** Claude Code versions its requests were made with, oldest first. */
    versions: string[];
}
/** A move in what 1% costs. */
export interface SlopeChange {
    window: string;
    label: string;
    /** "reset": between two windows, dated at the later one's start; "within": inside one window, dated at the stretch where it moved. */
    kind: "reset" | "within";
    at: number;
    /** For "reset", the earlier window's reset (equal to `at` unless a window is missing between them). */
    prevEnd?: number;
    usdPerPctBefore: number;
    usdPerPctAfter: number;
    tokensPerPctBefore?: number;
    tokensPerPctAfter?: number;
    /** after / before: under 1 when 1% buys less (the limit drains faster per dollar). */
    factor: number;
    /** How many standard errors the move is (on the log scale). */
    sigma: number;
    versionsBefore: string[];
    versionsAfter: string[];
}
/**
 * Each reset window of one weekly window's readings: % used, dollars and
 * tokens per 1% (over the stretches with usage here; rises with none are
 * counted apart), the split by entrypoint and by model, and the Claude Code
 * versions. `usage` in time order.
 */
export declare function resetWindowsOf(readings: LimitReading[], usage: UsagePoint[], opts?: {
    now?: number;
    stretchMs?: number;
}): ResetWindow[];
/**
 * A model id as a report may carry it: a model's name, never a cloud
 * resource (a Bedrock ARN holds an account number) or anything path-shaped.
 */
export declare function reportModel(model: string | undefined): string;
/**
 * Where what 1% costs moved: between consecutive windows that each have a
 * figure (dated at the reset), and inside a window at the one split of its
 * stretches that separates two rates best (dated at that stretch). Reported
 * from a 1.5x move either way, beyond 3 standard errors between windows and
 * 4 inside one (the split is searched for).
 */
export declare function slopeChanges(windows: ResetWindow[], usage?: UsagePoint[], readings?: LimitReading[], stretchMs?: number): SlopeChange[];
export interface LimitsReport {
    days: number;
    now: number;
    /** Where the Claude readings are logged, and how many there are. */
    claudeLog: string;
    claudeReadings: number;
    codexReadings: number;
    windows: WindowStatus[];
    fits: LimitFit[];
    /** Each weekly window, reset to reset: % used, dollars and tokens per 1%, by entrypoint and model (resetWindowsOf). */
    resets: ResetWindow[];
    /** Where what 1% costs moved (slopeChanges). */
    changes: SlopeChange[];
    /** The Claude windows the readings hold: ["seven_day"] alone on a plan with no 5-hour window (Ultra). */
    claudeWindows: string[];
    /** How many Claude readings each recorder wrote ("statusline", "mod", "proxy"; "earlier" for lines from before 0.49). */
    claudeSources: Record<string, number>;
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
/** What a usage view needs of the limits: each window now, each weekly window reset to reset, and the moves between them. */
export interface LimitsByReset {
    now: number;
    /** Each window's current %, pace and reset (a Claude 5-hour one only on plans that have it). */
    windows: WindowStatus[];
    resets: ResetWindow[];
    changes: SlopeChange[];
    /** True when there are Claude weekly readings and no 5-hour ones (Ultra). */
    noFiveHour: boolean;
    /** Readings in the period, Claude and Codex: 0 means nothing is recording them (see howToRecord). */
    readings: number;
}
/**
 * The per-reset view of the limits, for a pane or a script: every window's
 * current state, every weekly window with its dollars and tokens per 1%
 * (by entrypoint and model where the readings allow) and every move in that
 * figure, dated. Reads the limits ledger, Codex's rollouts and the
 * transcripts over the readings' span; never writes.
 */
export declare function limitsByReset(days?: number, opts?: LimitsOptions): LimitsByReset;
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
/**
 * The one line that says how to start recording Claude readings: the
 * plugin's mod (after each turn, in the Desktop app, the terminal and VS
 * Code), or the autopilot proxy (from the API's rate-limit headers).
 */
export declare const HOW_TO_RECORD = "To record them: `context-doctor install` (the plugin's mod writes them after each turn, Claude Code 2.1.286+; `install --statusline` on older ones), or `context-doctor autopilot on` (its proxy reads them from the API's replies).";
export declare function renderLimits(r: LimitsReport): string;
/**
 * `limits --report`: a block to paste into a GitHub issue. Per weekly
 * window: % used, dollars and tokens per 1%, the split by entrypoint and
 * model, Claude Code's versions, and every move in what 1% buys, dated. It
 * carries figures, dates, model and entrypoint names and version numbers
 * only: no prompt, no path, no session or account id (reportModel masks a
 * model id that is a cloud resource).
 */
export declare function renderLimitsReport(r: LimitsReport): string;
