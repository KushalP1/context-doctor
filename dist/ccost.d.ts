/**
 * Claude Code's own cost beside ours.
 *
 * Every Claude Code transcript carries `cost-state` rows: Claude Code's
 * running total for the session (`totalCostUSD`, what /cost shows), and per
 * model the tokens and dollars it counted (`modelUsage`). It writes one at
 * points through a session and restores it on resume (one `startTime` per
 * session, the total never falls: all 567 rows of the author's 79 sessions
 * that have one). It counts every request its process made for the session,
 * subagents included, and also what no transcript row records: a
 * compaction's own request (which context-doctor estimates, compactcost.ts),
 * the small requests it makes on its own (titles and the like, on a Haiku),
 * web searches at their fee, and from Claude Code 2.1.325 other mods' own
 * model calls.
 *
 * So it is the check ROADMAP K2 waited on the mod for, read from what is
 * already on disk: per session, its last `cost-state` against our price of
 * the same requests (the session's transcript and its subagents', from the
 * session's start to the last reply before that row). The gap is taken
 * apart, per model, with Claude Code's own token counts:
 *  - models it counted that no transcript row has (its side requests);
 *  - on the models both count, its tokens beyond ours, at our prices
 *    (requests the transcripts keep no usage for: compactions past our
 *    estimate of them, retries);
 *  - what is left is price: its dollars against ours for its own tokens
 *    (its price table, fast mode, a long prompt's tier, contracted rates).
 * The mod's ledger (modmeasure.ts) stays for what it measures live; this is
 * the comparison `spend`, `session` and `doctor` show.
 */
import type { SpendItem } from "./spend.js";
/** What one model's line of a `cost-state` holds, as numbers. */
export interface CcModel {
    usd: number;
    input: number;
    output: number;
    read: number;
    write: number;
    /** The writes by lifetime (`cacheCreationEphemeral1hInputTokens`, `...5m...`): both 0 where Claude Code did not split them (before ~2.1.317). */
    write1h: number;
    write5m: number;
    searches: number;
}
/** A `cost-state` row as the usage scan keeps it (scan.ts: numbers and model names only). */
export interface CostStateRecord {
    type: "cost-state";
    usd: number;
    /** The session's start (ms), restored with the total on resume. */
    start?: number;
    models: Record<string, CcModel>;
    /** Claude Code said some model's cost was unknown to it (`hasUnknownModelCost`). */
    unknown?: true;
    /** The Claude Code version of the replies before it. */
    version?: string;
}
/** A `cost-state` row, kept as numbers; undefined when it is not one. */
export declare function costStateRecord(e: any, version?: string): CostStateRecord | undefined;
/**
 * A request Claude Code sent, the model declined (a refusal), and Claude
 * Code sent again on another model (`model_refusal_fallback`): billed, and
 * no row records its usage. Kept by the usage scan as its model and time.
 */
export declare function refusalRecord(e: any): {
    type: "refusal";
    model: string;
    timestamp?: string;
} | undefined;
/** A transcript's last `cost-state`, the time of the last reply before it (what it covers), and the declined requests before it, by model. */
export declare function lastCostState(rows: unknown[]): {
    cs: CostStateRecord;
    to: number;
    first?: number;
    declined: Record<string, number>;
} | undefined;
/** One model's two figures in a comparison. */
export interface ModelGap {
    model: string;
    /** Claude Code's dollars and tokens. */
    ccUsd: number;
    cc: {
        input: number;
        output: number;
        read: number;
        write: number;
        searches: number;
    };
    /** Ours, on the same requests. */
    ourUsd: number;
    ours: {
        input: number;
        output: number;
        read: number;
        write: number;
        requests: number;
    };
    /** Claude Code's tokens at our prices (atOurPrices): an estimate. */
    ccAtOurUsd: number;
    /** Requests on it that it declined and Claude Code sent again on another model (refusalRecord). */
    declined?: number;
}
/** One session: Claude Code's figure and ours, and where the gap comes from. */
export interface SessionGap {
    session: string;
    project?: string;
    /** What both cover: from the session's start to the last reply before Claude Code's last record. */
    from: number;
    to: number;
    ccUsd: number;
    ourUsd: number;
    /** Of ours: the compactions' own requests, which we estimate (no row records their usage). */
    compactionUsd: number;
    compactions: number;
    version?: string;
    unknown?: true;
    models: ModelGap[];
}
/** The gap taken apart: each part is Claude Code's figure less ours, so they add up to ccUsd - ourUsd. */
export interface GapParts {
    /** Models no transcript row has, of requests the model declined and Claude Code sent again elsewhere. */
    declinedUsd: number;
    declined: number;
    declinedModels: string[];
    /** Other models no transcript row has: Claude Code's own side requests (its web searches among them). */
    sideUsd: number;
    sideModels: string[];
    sideSearches: number;
    /** On the models both count: its tokens less ours, priced at ours. */
    tokensUsd: number;
    /** Its dollars against ours on its own tokens: price. */
    priceUsd: number;
}
/** The parts of the gap of one or more sessions (see GapParts). */
export declare function gapParts(sessions: SessionGap[]): GapParts;
/**
 * The comparison for the sessions among `tops` whose Claude Code record and
 * our requests both fall inside [`since`, `until`]: `items` are spend's
 * Claude Code items (each request once, its session the transcript's name).
 * A session whose last record starts after its first reply (a record that
 * restarted on resume) is compared from where the record starts.
 */
export declare function compareSessions(tops: string[], items: SpendItem[], since?: number, until?: number): SessionGap[];
/** One session's figures, from Claude Code's record and our items over the same span. */
export declare function sessionGap(session: string, cs: CostStateRecord, mine: SpendItem[], from: number, to: number, declined?: Record<string, number>): SessionGap;
/** The version that counts other mods' model calls in Claude Code's cost (CHANGELOG 2.1.325). */
export declare const MODS_COUNTED_FROM = "2.1.325";
/** a >= b, as dotted versions. */
export declare function versionAtLeast(a: string | undefined, b: string): boolean;
/** Within this of Claude Code's figure is a match (ROADMAP K2, F1). */
export declare const CC_GAP_TARGET = 0.02;
/** What the gap is made of, in words, largest part first: what Claude Code's figure holds more (or less) than ours, and why. */
export declare function gapText(sessions: SessionGap[]): string[];
/** `spend`'s lines: Claude Code's figure beside ours on the sessions both cover; none when no session has a record in the window. */
export declare function renderComparison(sessions: SessionGap[]): string[];
/** `session`'s lines for one session; none when its transcript has no record. */
export declare function renderSessionComparison(s: SessionGap | undefined): string[];
/** `doctor`'s check: how close our price is to Claude Code's own, session by session. Undefined when no session has a record worth comparing. */
export declare function comparisonCheck(sessions: SessionGap[], days: number): {
    label: string;
    status: "ok" | "warn";
    detail: string;
} | undefined;
