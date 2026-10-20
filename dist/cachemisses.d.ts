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
}
/** Misses in one transcript; `since` drops requests before it. */
export declare function missesInTranscript(path: string, since?: number, add?: (eligible: {
    model: string;
    contextTokens: number;
}, miss?: CacheMiss) => void, onRequest?: (writeUsd: number) => void): void;
export declare function cacheMisses(days?: number, paths?: string[], onProgress?: (done: number, total: number) => void): CacheMissReport;
/** Worth a line in `savings`: enough misses, and enough money, to act on. */
export declare function cacheMissesSignificant(r: CacheMissReport): boolean;
/** The one line `savings` adds when the misses are significant. */
export declare function cacheMissesLine(r: CacheMissReport): string[];
export declare function renderCacheMisses(r: CacheMissReport): string;
