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
/**
 * What a reply's `anthropic-ratelimit-unified-overage-*` headers say about
 * usage credits (Claude's "extra usage": past a plan's limit, requests go on
 * and are paid from credits). Only the four the proxy records, as given:
 * `-overage-status` ("allowed", "allowed_warning", "rejected"),
 * `-overage-in-use` ("true" while requests are being paid from credits),
 * `-overage-utilization` (a fraction of the credits' cap, kept here as a
 * percent in 0.1 steps) and `-overage-reset` (epoch seconds). Read from
 * Claude Code 2.1.311's own parsing of the same headers. Undefined when a
 * reply carries none of them (an API key, Bedrock, Vertex).
 */
export interface OverageHeaders {
    status?: string;
    inUse?: boolean;
    pct?: number;
    reset?: number;
}
export declare function overageFromHeaders(get: (name: string) => string | null | undefined): OverageHeaders | undefined;
/** One reading of the credits headers, as the log keeps it. */
export interface OverageReading {
    ts: number;
    status?: string;
    inUse?: boolean;
    /** Percent of the credits' cap used. */
    pct?: number;
    /** When the credits' cap resets, ms. */
    resetsAt?: number;
    source?: LimitSource;
}
/**
 * Append what the credits headers say to the same log as the windows, as a
 * line of its own (`"w": "overage"`, which older versions skip): at
 * once when the status, whether credits are in use, or the reset changed;
 * a moved utilization at most once a minute; an unchanged one every 15
 * minutes. Never throws. Returns the lines written (0 or 1).
 */
export declare function recordOverage(o: OverageHeaders | undefined, now?: number, path?: string, source?: LimitSource): number;
/** Every credits reading in the log since `since`, oldest first. */
export declare function readOverageReadings(since?: number, path?: string): OverageReading[];
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
 * before it (ccost.ts compares it with ours). A reply row keeps its
 * `stop_reason` and `entrypoint` (a prompt suggestion follows a main-thread
 * turn's end, sidecost.ts) and, where it has no `stop_reason`, its content
 * as output tokens (`oc`: what a reply whose rows never settled cost,
 * sidecost.ts). Each `api-request` row (what Claude Code sent, 2.1.308+) as
 * its id, the request it repeats or extends and the time, a reply's
 * `requestRef` to it, and an `api_error` row's code: a request no reply
 * answers and Claude Code sent again a minute or more later is one that hung
 * (ccost.ts names them).
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
    /** Output tokens estimated from the reply's content, inside `output` and `usd`: its rows never settled it (sidecost.ts). */
    unsettled?: number;
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
    /** The weekly window stopped being read while the 5-hour one went on rising (silentMeters): no pace or run-out from its old reading. */
    silent?: SilentMeter;
    /** Both paces replayed on this window's last closed weekly periods (paceCheck): the run-out uses the one that missed less. */
    paceCheck?: PaceCheck;
}
export declare function windowLabel(window: string, windowMs?: number): string;
/**
 * One window's readings, in time order, without the stale ones: a reading
 * lower than an earlier one of the same period comes from another session
 * (two Claude Code windows, two Codex sessions) still holding an older
 * figure. Within a period usage only grows, so it is dropped, never read as
 * a new period or a fall in the pace. Logs written before 0.38 hold them.
 * One fall is kept: the proxy's, of GIVE_BACK_PTS or more (usage the server
 * gave back); readings after it are weighed against it.
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
    /** Its readings stopped while the 5-hour window went on rising (silentMeters): `pctUsed` is where they stopped, not where the window ended. */
    silent?: SilentMeter;
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
    /** The model mix on each side, when the transcripts carry models (mixOf). */
    mix?: MixShift;
    /**
     * What the mix alone predicts: the after side's dollars per 1% over the
     * before side's, at fixed per-model rates. Undefined when the mix moved
     * and no per-model rates were good enough to say.
     */
    mixFactor?: number;
    /** factor / mixFactor: the part of the move the mix does not explain (under 1: per model, 1% buys less). */
    residual?: number;
    /** How many standard errors the residual is (log scale, the two sides' errors). */
    residualSigma?: number;
    /**
     * In words: "limit", the move is the limit's own (the mix held, or what is
     * left past it is 1.5x or more beyond its error); "mix", the mix explains
     * it; "both", a mix move and a residual move; "unclear", the mix moved and
     * per-model rates are too thin to split the two.
     */
    cause?: "limit" | "mix" | "both" | "unclear";
}
/** Dollar shares by model on each side of a move, and the model whose share moved most. */
export interface MixShift {
    /** reportModel keys, 0-1 of each side's dollars. */
    before: Record<string, number>;
    after: Record<string, number>;
    /** The model whose share grew most, and the one whose share shrank most. */
    grew: string;
    shrank?: string;
    /** Half the summed share changes, 0-1: 0 when the mix held. */
    moved: number;
    /** % of the limit per list-price dollar by model, as used for the prediction. */
    pctPerUsd?: Record<string, number>;
    /** The mix alone, at those rates: dollars per 1% on each side. */
    predictedBefore?: number;
    predictedAfter?: number;
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
 * 4 inside one (the split is searched for). Each move is checked against
 * the model mix on its two sides (explainMove; needs `readings` to find the
 * stretches): `cause` says whether the limit moved or the mix did.
 */
export declare function slopeChanges(windows: ResetWindow[], usage?: UsagePoint[], readings?: LimitReading[], stretchMs?: number): SlopeChange[];
/**
 * Both of a plan's windows count the same requests, so the ratio of their
 * rises is the one limit figure the model mix cancels out of: a move in it
 * is a move in one of the two limits, never in your models. People measured
 * it moving on Pro from 10% to 12% of the week per full 5-hour window
 * (claude-code#111886, #111759, #111593). Each 5-hour period is paired with
 * the weekly reading taken at the same moment: the line the recorder wrote
 * beside it, or, where the weekly % had not moved (the recorder writes a
 * window only when it moves, and again every 15 minutes), the weekly line
 * before it. The ratio is the sum of the weekly rises over the sum of the
 * 5-hour rises, per weekly window and pooled; its error is the larger of the
 * whole-percent steps' and the spread between 5-hour windows'.
 */
/** One 5-hour period's rise and the weekly limit's rise between the same two moments. */
export interface ExchangeSample {
    from: number;
    to: number;
    fivePct: number;
    weekPct: number;
}
/** A ratio over some 5-hour windows, or why there is none worth quoting. */
export interface ExchangeFigure {
    /** 5-hour windows with weekly readings beside them, and the points each limit rose over them. */
    windows: number;
    fivePct: number;
    weekPct: number;
    /** % of the weekly limit a full 5-hour window (100 points) costs: 100 × weekly rise / 5-hour rise. */
    pct?: number;
    /** Its standard error, in points of the weekly limit. */
    err?: number;
    /** Why it is not quoted, when it is not (pct may still be there, too loose to say). */
    why?: string;
}
/** One weekly window, reset to reset, and the ratio inside it. */
export interface ExchangeWeek extends ExchangeFigure {
    start: number;
    resetsAt: number;
    current: boolean;
}
/** A move in the ratio between two weekly windows that each have one. */
export interface ExchangeMove {
    /** The later window's start, and the earlier one's reset (equal unless a window is missing between them). */
    at: number;
    prevEnd: number;
    pctBefore: number;
    errBefore: number;
    pctAfter: number;
    errAfter: number;
    /** How many standard errors apart. */
    sigma: number;
}
/** One app's exchange: the figure since its last move (or since the first reading), each weekly window, and the moves. */
export interface Exchange extends ExchangeFigure {
    app: "claude" | "codex";
    /** "Claude", "Codex (plus)". */
    label: string;
    /** The two windows paired ("five_hour" and "seven_day"; Codex's 300- and 10080-minute ones). */
    short: string;
    long: string;
    /** The first moment the figure counts from. */
    since: number;
    /** Weekly windows with a figure of their own: two or more were compared. */
    compared: number;
    weeks: ExchangeWeek[];
    moves: ExchangeMove[];
}
/** One app's exchange from its short (5-hour) and long (weekly) readings; undefined when either is missing (Ultra has no 5-hour window). */
export declare function exchangeOf(short: LimitReading[], long: LimitReading[], opts: {
    app: "claude" | "codex";
    label: string;
    now?: number;
}): Exchange | undefined;
/**
 * The weekly window's last reading, when the 5-hour window went on being
 * read, and rising, for hours after it. Both windows come from the same
 * reply (the mod after each turn, the proxy on each reply), so a weekly that
 * stops while the 5-hour goes on is a weekly the recorders did not write:
 * on Nov 27, 2026 the weekly last read 73% at 07:38 UTC, and for the 27
 * hours to its reset the 5-hour window rose 148 points with no weekly line
 * beside them. `limits` said "73% used" and projected the pace from it.
 */
export interface SilentMeter {
    /** The weekly window's last reading: when, and its %. */
    at: number;
    pct: number;
    /** When that weekly period resets, ms. */
    resetsAt: number;
    /** The last 5-hour reading in the same weekly period, and the points the 5-hour window rose after the weekly's last reading. */
    fiveLast: number;
    fiveRise: number;
    /** Still running at the report's time: the estimate is for now, not for the reset. */
    current: boolean;
    /** The weekly %, estimated from the 5-hour rise and the exchange (exchangeOf): at the reset, or now while it runs. With its error in points. */
    estimate?: number;
    err?: number;
}
/**
 * Each weekly period whose readings stop over 2 hours before the 5-hour
 * window's do, with the 5-hour window rising after: where the weekly
 * stopped, how far the 5-hour rose after it (each 5-hour period from the
 * reading standing at that moment, or from 0 for a period that began
 * after), and, with an exchange worth quoting, the weekly that rise
 * amounts to. Claude only: Codex writes both windows on every event.
 */
export declare function silentMeters(five: LimitReading[], week: LimitReading[], exchange: Exchange | undefined, now?: number): SilentMeter[];
/** A weekly window's status with its silence, when its current period has one: stale, so no pace is projected from the old reading. */
export declare function silence(s: WindowStatus, list: SilentMeter[]): WindowStatus;
/**
 * Which pace to forecast a weekly window's run-out with, from how each
 * would have done on this person's own closed weeks. The last 24 hours'
 * pace follows a change quickly but, read over the readings of the last
 * day, takes a day's burst for the week's: on the author's Nov 21-28 week
 * it put the end between 68% and 160% (a median ~22 points off the 96% it
 * reached), the window's average pace ~9 off.
 */
export interface PaceCheck {
    /** Closed weekly periods replayed (each with one moment or more), and the 12-hourly moments in all. */
    windows: number;
    checks: number;
    /** The median miss, in points of the limit, of where each pace put the window's end: the last 24 hours' and the window's average. */
    recentMiss: number;
    averageMiss: number;
    /** The one that missed less (the last 24 hours' on a tie, as before): the run-out uses it. */
    pace: "recent" | "average";
}
/**
 * Replay each of one window's last closed weekly periods every 12 hours:
 * at each moment, the status the report would have shown then
 * (windowStatus on the readings up to it), and where each pace puts the
 * window's end (the % then, plus the pace times the hours to the reset);
 * the miss is the distance to where the window really ended (its last
 * reading, or `endOf`, a silent meter's estimate). Undefined with fewer
 * than two closed periods replayed.
 */
export declare function paceCheck(readings: LimitReading[], now: number, endOf?: (resetsAt: number) => number | undefined): PaceCheck | undefined;
/** A weekly window's status with its pace check: when the window's average missed less, the run-out is at the average pace. */
export declare function withPace(s: WindowStatus, check: PaceCheck | undefined): WindowStatus;
/** "the window's average pace", "the last 24 hours' pace". */
export declare const paceName: (p: "recent" | "average") => string;
/** "Replayed every 12 hours on your last 2 weekly windows, the window's average pace missed where the week ended by a median 9.2 points, the last 24 hours' by 22: the run-out uses the average." */
export declare function paceCheckLine(c: PaceCheck): string;
/** Claude's weekly window from its readings (30 days of them for the pace check), as `limits` shows it: for the credits line outside `limits`. */
export declare function claudeWeeklyStatus(claude: LimitReading[], now: number): WindowStatus | undefined;
/**
 * A silent meter in one line. In the per-window rows (UTC): "No weekly
 * reading after Nov 27 07:38 UTC (73%); the 5-hour meter rose 148 points
 * after it: about 96% (±1) by the reset, from the 5-hour exchange; an
 * estimate." Under the current window (local clock), the estimate is for now.
 */
export declare function silentLine(m: SilentMeter, now: number, local?: boolean): string;
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
    /** What a full 5-hour window costs of the weekly limit, Claude's then Codex's (exchangeOf); none on a plan without a 5-hour window. */
    exchange: Exchange[];
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
/**
 * The exchange in one line: what a full 5-hour window costs of the weekly
 * limit, its error, how many fit in a week, and whether it moved (from what
 * to what, and when). Too thin: says so, with no figure.
 */
export declare function exchangeLine(e: Exchange): string;
/** "claude-fable-5-2" as "Fable 5.2"; any other id as it is. */
export declare function modelLabel(key: string | undefined): string;
/**
 * The full `limits` report. `pastLimit`: lines on requests paid from usage
 * credits past a limit (credits.ts creditsLines), placed under the windows;
 * none when nothing went past one. `ahead`: the line on what running out
 * before the weekly reset would cost on usage credits (credits.ts
 * creditsAheadLine), under the weekly window's run-out.
 */
export declare function renderLimits(r: LimitsReport, pastLimit?: string[], ahead?: string): string;
/**
 * `limits --report`: a block to paste into a GitHub issue. Per weekly
 * window: % used, dollars and tokens per 1%, the split by entrypoint and
 * model, Claude Code's versions, and every move in what 1% buys, dated. It
 * carries figures, dates, model and entrypoint names and version numbers
 * only: no prompt, no path, no session or account id (reportModel masks a
 * model id that is a cloud resource).
 */
export declare function renderLimitsReport(r: LimitsReport): string;
