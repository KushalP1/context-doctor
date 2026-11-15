/**
 * Cold returns: a main-conversation request after the prompt cache it left
 * expired, which writes the whole context again. On the author's 30 days
 * (2026-11-15) they were the largest cost no lever reached: 183 returns,
 * $864 above cache-read price (26% of spend), $760 of it on contexts over
 * 300k. `cache-misses` reports them here, each one replayed three ways:
 *
 *  - as it went: the return as billed (requestCost, the same figure `spend`
 *    adds up);
 *  - compacted on return: the cold-resume replay's estimate (coldresume.ts),
 *    /compact right after the return, net of the compaction, counting what it
 *    saves on the requests after it until the next return;
 *  - kept warm: a cache read of the whole context every 55 minutes while away
 *    (4.5 minutes on a 5-minute cache), so the return reads the context
 *    instead of writing it. A ping is the context at the cache-read rate plus
 *    a short prompt and reply (Claude Code's mods API `$.model.fork`: the main
 *    thread's last request again, with one message after it, nothing kept in
 *    the transcript).
 *
 * By how long the person was away. The replay knows the gap; a keep-warm
 * timer does not, so the policies below price keeping warm for up to N
 * hours, counting every ping it would have sent: every pause past the first
 * ping, the returns past the cap (cold anyway) and the sessions never
 * returned to.
 *
 * Also #107157 (anthropics/claude-code): the Desktop app's transcript gains a
 * copy of a segment a compaction had already removed (its rows, its
 * `compact_boundary` included, with their original uuids), and a resume then
 * rebuilds the conversation through it: one request went from 390k to 862k
 * tokens and wrote 817k to the cache. Found here as a compaction boundary
 * whose uuid the transcript already held, followed by a jump in context with
 * no real compaction between.
 */
import { type ModelPricing } from "./pricing.js";
/** A ping every this long keeps a 1-hour cache warm (5 minutes of margin)... */
export declare const PING_EVERY_1H_MS: number;
/** ...and a 5-minute one (30 seconds of margin). */
export declare const PING_EVERY_5M_MS = 270000;
/** A ping's own prompt (uncached) and reply, a short answer and a little thinking: an estimate. */
export declare const PING_PROMPT_TOKENS = 30;
export declare const PING_OUTPUT_TOKENS = 100;
/** The keep-warm caps priced, hours. */
export declare const KEEP_WARM_HOURS: number[];
export declare const GAP_BUCKETS: readonly ["<1h", "1-2h", "2-4h", "4-8h", ">8h"];
export type GapBucket = (typeof GAP_BUCKETS)[number];
export declare function gapBucket(ms: number): GapBucket;
export declare const pingEveryMs: (ttlMs: number) => number;
/** Pings a timer sends in a pause of `gapMs`: one each `every` until the person is back. */
export declare const pingsIn: (gapMs: number, every: number) => number;
/** One ping: the context read from the cache, the ping's prompt and its reply. */
export declare function pingUsd(contextTokens: number, p: ModelPricing): number;
export interface ColdReturn {
    path: string;
    at: number;
    gapMs: number;
    /** The lifetime of the cache the previous request left. */
    ttlMs: number;
    model: string;
    /** The previous request's whole context: what a warm cache would have served. */
    contextTokens: number;
    tokens: number;
    writeTokens: number;
    /** As it went: the request as billed. */
    billedUsd: number;
    /** The part of it above cache-read price: the context written again. */
    rewriteUsd: number;
    /** Compacted on return: billed minus the compaction's net saving (undefined: not offered, under 150k or within 5 minutes of the lifetime). */
    compactedUsd?: number;
    /** Kept warm: billed without the re-write, plus the pings. A model switch misses anyway: no re-write avoided. */
    keptWarmUsd: number;
    pings: number;
    /** One ping's price on this context. */
    pingUsd: number;
    sameModel: boolean;
}
/** A pause a keep-warm timer would have pinged through: every gap between main requests, and the time since the last. */
export interface Pause {
    gapMs: number;
    ttlMs: number;
    pingUsd: number;
    /** The rewrite a ping would have avoided: a cold return on the same model (0 otherwise). */
    avoidableUsd: number;
}
/** #107157: a segment a compaction removed, put back. */
export interface ReAdded {
    path: string;
    /** When the copy of the old compaction boundary was written. */
    copiedAt: number;
    /** The request whose context jumped, and by how much. */
    at: number;
    fromTokens: number;
    toTokens: number;
    writeTokens: number;
    /** The jump written to the cache, at the request's own write rate. */
    extraWriteUsd: number;
    /** What each later request pays to read it again. */
    perRequestUsd: number;
}
export interface KeepWarmPolicy {
    hours: number;
    pings: number;
    pingUsd: number;
    /** Cold returns it would have kept warm, and the re-writes they would not have paid. */
    keptWarm: number;
    avoidedUsd: number;
    netUsd: number;
}
export interface GapRow {
    bucket: GapBucket | "all";
    returns: number;
    asItWentUsd: number;
    rewriteUsd: number;
    compactedUsd: number;
    keptWarmUsd: number;
    pings: number;
    cheapest: "as it went" | "compacted" | "kept warm";
}
export interface ColdReturnReport {
    days: number;
    returns: number;
    billedUsd: number;
    rewriteUsd: number;
    /** Of rewriteUsd, on previous contexts over 300k. */
    over300kUsd: number;
    byGap: GapRow[];
    total: GapRow;
    policies: KeepWarmPolicy[];
    /** The cap that nets the most, when any nets more than nothing. */
    best?: KeepWarmPolicy;
    readded: ReAdded[];
    /** For `--json`: the costliest returns. */
    largest: ColdReturn[];
}
/** One transcript's cold returns, pauses and re-added segments; `now` ends the last pause. */
export declare function coldReturnsInTranscript(path: string, since?: number, now?: number, runRows?: Set<string>, coldRows?: Set<string>): {
    returns: ColdReturn[];
    pauses: Pause[];
    readded: ReAdded[];
};
/** Keeping warm for up to `hours` after each request, not knowing when the person is back. */
export declare function keepWarmPolicy(pauses: Pause[], hours: number): KeepWarmPolicy;
/** Every main transcript of the last `days` (or `paths`). */
export declare function coldReturns(days?: number, paths?: string[], now?: number): ColdReturnReport;
/** The `cache-misses` section, or nothing when there were no cold returns. */
export declare function renderColdReturns(r: ColdReturnReport): string[];
