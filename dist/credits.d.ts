/**
 * Past the plan's limit: which Claude Code requests were paid from usage
 * credits ("extra usage"), and about how much.
 *
 * With extra usage on, Claude Code keeps working when a weekly or 5-hour
 * limit runs out and the requests are paid from credits: real money that
 * the limits' % no longer shows. Two sources say when:
 *
 *  - The proxy records the API's `anthropic-ratelimit-unified-overage-*`
 *    headers into the limits ledger (limits.ts recordOverage). A request
 *    made while the newest of those readings (at most 16 minutes old) said
 *    `in-use: true` was paid from credits; `false` says it was not.
 *  - The plugin's mod and the status line hand over only the windows' %,
 *    nothing about credits. A request that still went through (it has
 *    usage in its transcript) after a window read 100% and before that
 *    window reset is past the limit, and with extra usage on most likely
 *    paid from credits: counted as inferred, and said to be. With extra
 *    usage off (`~/.claude.json`, claudedir.ts readExtraUsage) nothing is
 *    inferred.
 *
 * Dollars are each request at API list prices, as `spend` prices it.
 * Whether usage credits are billed at exactly those prices is not verified
 * here, so every figure is said to be an estimate. Read only by commands
 * the user runs (`limits`, `spend`, `doctor`, `budget`), and by the
 * budget's hook at a threshold it already speaks at: nothing is drawn or sent.
 */
import { type ExtraUsage } from "./claudedir.js";
import { type LimitReading, type OverageReading, type UsagePoint, type WindowStatus } from "./limits.js";
/** A window that read 100%: from that reading until it reset. */
export interface SpentSpan {
    window: "five_hour" | "seven_day";
    /** The first reading at 100% or more. */
    from: number;
    /** Its reset, else the next reading of a new period, else its last reading at 100% plus the keepalive. */
    to: number;
    resetsAt?: number;
}
/**
 * The stretches in which a Claude window stood at 100% or more: from its
 * first such reading to the window's reset. Within a period the % never
 * falls, so once a window reads 100% it is spent until it resets.
 */
export declare function spentSpans(readings: LimitReading[]): SpentSpan[];
/** How a request was found to be on credits: the API's replies said so, or a window read 100% and it still went through. */
export type CreditsHow = "headers" | "inferred";
/** One run of requests past the limit: one window's period, or one stretch the API's replies alone mark. */
export interface CreditsEpisode {
    /** The window that ran out, when a reading says which. */
    window?: "five_hour" | "seven_day";
    /** When it ran out: the first reading at 100%, else the first reply that said credits were in use. */
    ranOutAt: number;
    /** When that window resets (absent when only the API's replies mark the episode). */
    resetsAt?: number;
    /** Still past the limit at the report's time. */
    current: boolean;
    /** The first and last request on credits. */
    first: number;
    last: number;
    requests: number;
    /** At API list prices: an estimate of what the credits paid. */
    usd: number;
    /** Of `requests`: marked by the API's replies, and inferred from a window at 100%. */
    fromHeaders: number;
    inferred: number;
}
export interface CreditsSummary {
    episodes: CreditsEpisode[];
    requests: number;
    usd: number;
    fromHeaders: number;
    inferred: number;
}
export interface CreditsInputs {
    readings: LimitReading[];
    overage: OverageReading[];
    /** `~/.claude.json`'s word; `enabled: false` turns inference off. */
    extraUsage?: ExtraUsage;
    now: number;
}
/**
 * Sort requests (anything with a time and dollars: limits' usage points,
 * spend's items) into runs past the limit. A request counts when the
 * credits reading that speaks for it says in use, or, with no such
 * reading, when it falls in a spent window and extra usage is not off.
 */
export declare function creditsOf(points: Array<{
    ts: number;
    usd: number;
}>, inp: CreditsInputs): CreditsSummary;
export interface CreditsOptions {
    now?: number;
    logPath?: string;
    /** Claude Code transcripts to read (tests); default every one in the period. */
    claudePaths?: string[];
    /** `~/.claude.json`'s word (tests); default read from the home below. */
    extraUsage?: ExtraUsage | null;
    home?: string;
}
/** The ledger's readings for a period starting at `since`, a week earlier too (a weekly window spent before it still counts in it). */
export declare function creditsInputs(since: number, opts?: CreditsOptions): CreditsInputs;
/** Nothing in the ledger could put a request past the limit: no spent window, no reply that said credits were in use. */
export declare function nothingPast(inp: CreditsInputs): boolean;
/**
 * The last `days` days of Claude Code past the plan's limit, for `limits`:
 * the ledger, and the transcripts only when the ledger says something was.
 * Undefined when nothing was.
 */
export declare function creditsReport(days?: number, opts?: CreditsOptions): (CreditsSummary & {
    extraUsage?: ExtraUsage;
}) | undefined;
/** The same from `since` to now (`budget`'s day or week). Undefined when nothing was past the limit. */
export declare function creditsSince(since: number, opts?: CreditsOptions): (CreditsSummary & {
    extraUsage?: ExtraUsage;
}) | undefined;
/**
 * The weekly limit at the recent pace runs out before it resets, and extra
 * usage is on: Claude Code would keep working on usage credits from then
 * until the reset. About how much, at the last 24 hours' dollars an hour on
 * this machine (list prices, an estimate).
 */
export interface CreditsAhead {
    /** When the weekly limit runs out at the recent pace, and when it resets, ms. */
    runsOutAt: number;
    resetsAt: number;
    /** Hours from the run-out (or now, if later) to the reset. */
    hours: number;
    /** Claude Code's list-price dollars an hour over the last 24 hours, on this machine, subagents included. */
    usdPerHour: number;
    /** hours times usdPerHour. */
    usd: number;
    /** The model most of those dollars went to, and its share, when it is most of them. */
    model?: string;
    modelShare?: number;
    /** The window's average pace (% an hour), and whether the limit lasts to the reset at it. */
    averagePerHour?: number;
    averageLasts?: boolean;
}
/** Extra usage on, and nothing in `~/.claude.json` saying credits are not paying now. */
export declare function extraUsageOn(x: ExtraUsage | undefined): boolean;
/**
 * The weekly window's run-out and what the hours past it would cost. Pure:
 * `usage` is the last 24 hours' requests. Undefined unless extra usage is on
 * and the weekly window, read recently, runs out before its reset at the
 * recent pace, with dollars to price the hours at.
 */
export declare function creditsAhead(status: WindowStatus | undefined, extra: ExtraUsage | undefined, usage: Array<Pick<UsagePoint, "ts" | "usd" | "model">>, now: number): CreditsAhead | undefined;
export interface CreditsAheadOptions {
    now?: number;
    logPath?: string;
    /** Claude Code transcripts to read (tests); default every one touched in the last day. */
    claudePaths?: string[];
    /** `~/.claude.json`'s word (tests); default read from the home below. */
    extraUsage?: ExtraUsage | null;
    home?: string;
    /** The weekly window's status when the caller has it (`limits`); default read from the ledger. */
    status?: WindowStatus;
}
/**
 * creditsAhead from this machine: `~/.claude.json` first, then the ledger's
 * weekly window, and the transcripts of the last day only when both say it
 * applies. Never throws: a command's own figures must not be lost to it.
 */
export declare function creditsAheadNow(opts?: CreditsAheadOptions): CreditsAhead | undefined;
/**
 * One line: "Extra usage is on: at this pace your weekly limit runs out on
 * Thu, Nov 26 at 18:19, 46 hours before it resets, and Claude Code would
 * keep working on usage credits until then: about $1,234 at API list prices
 * (an estimate), at your last 24 hours' $26.80 an hour, mostly Fable 5.2.
 * At this week's average pace (0.55% an hour) it lasts until the reset."
 */
export declare function creditsAheadLine(a: CreditsAhead, now: number): string;
/** "at 14:05" within the day, else "on Tue, Nov 17 at 14:05": local time. */
export declare function whenText(ms: number, now: number): string;
/** The dollars, in the words every report uses: list prices, an estimate. */
export declare const AT_LIST_PRICES = "at API list prices (an estimate)";
/**
 * One episode in plain words: "Your weekly limit ran out on Tue, Nov 17 at
 * 14:05; 37 requests after that were paid from usage credits, about $41.20
 * at API list prices (an estimate)." Inferred ones say so.
 */
export declare function episodeLine(e: CreditsEpisode, now: number): string;
/** Lines for `limits`: one per episode, newest last, and what "inferred" and the dollars mean when it applies. */
export declare function creditsLines(r: CreditsSummary, now: number): string[];
/**
 * `doctor`'s line on extra usage, from `~/.claude.json`: on, on but held
 * back (and why), or off. Undefined when the file says nothing (an API key,
 * never signed in).
 */
export declare function extraUsageText(x: ExtraUsage | undefined): {
    on: boolean;
    text: string;
} | undefined;
