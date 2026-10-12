/**
 * Prompt-cache analysis for Claude Code sessions.
 *
 * Transcripts record what the API actually charged per request — including
 * cache reads and cache writes — so cache behaviour can be reported as fact
 * rather than estimated. This is usually the largest single lever on cost:
 * a cached read bills at a tenth of input or less, while a cache write bills
 * at 1.25x (2x at the 1-hour TTL Claude Code's main thread uses), so a
 * session that keeps invalidating its prefix pays more than one with no
 * caching at all.
 */
export interface CacheUsage {
    /** API requests: each reply once, however many transcript rows it was written as. */
    requests: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** The part of cacheWriteTokens written at the 1-hour TTL (2x input instead of 1.25x). */
    cacheWrite1hTokens: number;
    uncachedTokens: number;
    /** Share of input tokens served from cache (0-1). */
    hitRate: number;
    model?: string;
    /** What the input actually cost, at list prices. */
    paidUsd?: number;
    /** What the same input would have cost with no caching at all. */
    uncachedUsd?: number;
    /** paidUsd vs uncachedUsd — positive means caching is paying off. */
    savedUsd?: number;
    /** USD spent on cache writes; high values mean the prefix keeps changing. */
    writeUsd?: number;
}
export declare function analyzeCacheUsage(transcriptPath: string): CacheUsage | null;
/** One-paragraph verdict for humans, or null when there is nothing to say. */
export declare function renderCacheReport(usage: CacheUsage | null): string | null;
