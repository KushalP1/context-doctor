/**
 * `context-doctor cache-misses`: requests that re-wrote the prompt cache while
 * it should still have been warm.
 *
 * Claude Code caches the conversation as it goes; the next request within the
 * cache's lifetime reads that prefix at the cache-read rate (5-10% of input)
 * and writes only what is new. When a request instead writes most of the
 * context again, at 1.25x input (2x at the 1-hour TTL), the cache missed.
 * Some misses are expected (a model switch: each model has its own cache;
 * a compaction: a new history), the rest are invisible from the client.
 *
 * Definition, request by request over each main-chain transcript:
 *  - two consecutive requests (sidechains and synthetic replies skipped),
 *    with no compaction (compact_boundary) between them;
 *  - the gap under the cache lifetime of both: 1 hour when the request wrote
 *    to the 1-hour cache (usage.cache_creation.ephemeral_1h_input_tokens > 0),
 *    else 5 minutes;
 *  - the previous request's context over 20k tokens (smaller ones are noise);
 *  - a miss when the request's cache_creation_input_tokens exceed 60% of the
 *    previous request's whole context (input + cache read + cache write).
 *
 * Priced above what the same tokens would have cost as cache reads: the
 * re-written part (up to the previous context) at the write rate minus the
 * read rate. Measured on the author's last 30 days (Oct 2026): 390 misses in
 * 29,287 requests, ~$1,925 above cache-read price, 28% of all cache-write
 * spend; 382 of them with nothing in the transcript to explain them.
 */
import { type DiagnosedMisses } from "./missledger.js";
export type MissCause = "model switch" | "context edited" | "after an API error" | "over 20 new blocks" | "nothing visible";
export interface CacheMiss {
    path: string;
    /** ISO time of the request that missed. */
    at: string;
    model: string;
    previousModel: string;
    /** The previous request's whole context: what should have been read from cache. */
    contextTokens: number;
    writeTokens: number;
    /** Cache read on the miss as a share of the previous context (the part that still matched). */
    readShare: number;
    gapSeconds: number;
    cause: MissCause;
    /** Above the cache-read price; undefined when the model has no known price. */
    extraUsd?: number;
}
export interface MissStats {
    /** Requests that could have read a warm cache (the definition above). */
    eligible: number;
    misses: number;
    rate: number;
    extraUsd: number;
}
export interface CacheMissReport {
    days: number;
    transcripts: number;
    /** Every main-chain request with usage in the period. */
    requests: number;
    eligible: number;
    misses: number;
    missWriteTokens: number;
    /** Misses priced above cache-read price (priced models only). */
    extraUsd: number;
    /** All cache writes in the period, priced: the share the misses take of it. */
    cacheWriteUsd: number;
    /** Misses on models with no known price (not in extraUsd). */
    unpricedMisses: number;
    byModel: Array<{
        model: string;
    } & MissStats>;
    bySize: Array<{
        bucket: string;
    } & MissStats>;
    causes: Record<MissCause, number>;
    /** Advice the data supports (model versions with fewer misses, context size), possibly none. */
    recommendations: string[];
    /** The costliest misses. */
    largest: CacheMiss[];
    /** The same requests by the Claude Code version that sent them (oldest first). */
    byVersion: VersionStats[];
    /** Step changes from one version to the next that the numbers support. */
    regressions: Regression[];
    /**
     * Claude Code's own diagnosis of each miss in the period, as the status line
     * logged it (2.1.260+). Its definition of a miss is Claude Code's, wider
     * than the one above (it counts a cold cache after a pause too).
     */
    diagnosed: DiagnosedMisses;
}
/** One Claude Code version's requests (the `version` every transcript line carries). */
export interface VersionStats {
    version: string;
    /** Main-chain requests, and the transcripts they came from. */
    requests: number;
    sessions: number;
    /** First requests of new sessions: the fixed overhead (system prompt, tools, memory), median. */
    firstRequests: number;
    firstMedian?: number;
    /** Cache-write tokens per request, mean. */
    writesPerRequest: number;
    /** Share of cache writes at the 1-hour TTL (Claude Code's main thread writes almost all at 1 h). */
    oneHourShare?: number;
    /** Warm requests and misses, by the definition above. */
    eligible: number;
    misses: number;
    missRate: number;
    /** The same per model (a version's rate mostly follows the models it ran). */
    byModel: Array<{
        model: string;
        eligible: number;
        misses: number;
    }>;
    /** The 1-hour share per model and surface. */
    ttlBy: Array<{
        key: string;
        requests: number;
        oneHourShare?: number;
    }>;
    /** First and last time the version was seen. */
    from: string;
    to: string;
}
export interface Regression {
    metric: "1-hour cache share" | "first request" | "miss rate";
    from: string;
    to: string;
    before: number;
    after: number;
    /** In words, with the numbers. */
    text: string;
}
/** Misses in one transcript; `since` drops requests before it. */
/** What `onRequest` is told about each main-chain request in the period. */
export interface RequestInfo {
    at: number;
    /** The Claude Code version on the transcript line, when recorded. */
    version?: string;
    write: number;
    oneHour: number;
    fiveMinute: number;
    /** The session's first request, minus its first user message: the fixed overhead. Only on that request. */
    first?: number;
    model?: string;
    /** The Claude Code surface (cli, claude-vscode, claude-desktop...): it can choose the cache TTL too. */
    entrypoint?: string;
}
export declare function missesInTranscript(path: string, since?: number, add?: (eligible: {
    model: string;
    contextTokens: number;
    version?: string;
}, miss?: CacheMiss) => void, onRequest?: (writeUsd: number, info: RequestInfo) => void, 
/** Shared by every transcript of one report: a fork's copied rows (same uuids) have no first request of their own. */
runRows?: Set<string>): void;
export declare function cacheMisses(days?: number, paths?: string[], onProgress?: (done: number, total: number) => void, missLog?: string): CacheMissReport;
interface VersionAcc {
    requests: number;
    sessions: Set<string>;
    firsts: number[];
    writes: number;
    oneHour: number;
    fiveMinute: number;
    eligible: number;
    misses: number;
    /** Warm requests and misses per model: miss rates differ by model far more than by version. */
    byModel: Map<string, {
        eligible: number;
        misses: number;
    }>;
    /** Cache writes by TTL per model and surface: either can change the TTL as much as the version. */
    ttlBy: Map<string, {
        requests: number;
        oneHour: number;
        fiveMinute: number;
    }>;
    from: number;
    to: number;
}
/**
 * Per version, oldest first, and the step changes between consecutive
 * versions with enough data (thin versions are skipped over, so a change
 * is credited to the first well-measured version after it):
 *  - the 1-hour share of cache writes moving by 30+ points (the TTL
 *    regressions users report after upgrades: 1 h to 5 min);
 *  - the median first request (fixed overhead) moving by 15% and 3k tokens;
 *  - one model's miss rate doubling (or halving), beyond chance at 99%,
 *    5+ misses, 100+ warm requests on each version.
 * Cache writes per request are shown, not flagged (they follow the work).
 */
export declare function versionReport(versions: Map<string, VersionAcc>): {
    byVersion: VersionStats[];
    regressions: Regression[];
};
/** Worth a line in `savings`: enough misses, and enough money, to act on. */
export declare function cacheMissesSignificant(r: CacheMissReport): boolean;
/** The one line `savings` adds when the misses are significant. */
export declare function cacheMissesLine(r: CacheMissReport): string[];
/** Claude Code's own diagnosis, or how to start recording it. */
export declare function renderDiagnosed(d: DiagnosedMisses): string[];
export declare function renderCacheMisses(r: CacheMissReport, limitLines?: string[]): string;
export {};
