/**
 * A compaction's own request, estimated: the one request of a session that no
 * transcript row carries usage for.
 *
 * Compacting sends the whole conversation once more with an instruction to
 * summarize it, and the answer is the summary the session restarts from.
 * Claude Code bills it and counts it in its own cost (the mods API says the
 * session's cost ledger holds it), but writes only a `compact_boundary` row
 * (`compactMetadata.preTokens`: the context it read) and the summary as a user
 * row (`isCompactSummary`): no usage (2.1.321). So `spend`, the budget and a
 * session's price left every compaction out, and the mod's comparison with
 * Claude Code's own cost showed the gap.
 *
 * Estimated from what the transcript does record, at the model of the reply
 * before it (rateCard, as every request: the organization's rates, the day's
 * price, its fast mode and US-only):
 *  - the context it read, `preTokens`: at the cache-read rate when the cache
 *    the last reply left was still alive (an automatic compaction mid-turn,
 *    Claude Code's idle compaction before expiry), else written again at the
 *    session's lifetime (a /compact after the cache went cold);
 *  - its output, the summary: the summary row's text, in tokens.
 * Not counted: the request's own instruction (a few hundred tokens) and any
 * thinking it did. The next request's re-write of the new context is in that
 * request's own usage, as before.
 */
import { type RecordedUsage, type RequestCost } from "./pricing.js";
/** The summary's output when no summary row follows the boundary: compactwindow.ts's measured figure. */
export declare const SUMMARY_TOKENS_UNSEEN = 20000;
/** Per thread ("0" the main conversation, "1" a sidechain): the last reply's model, time, cache lifetime and billing. */
interface Thread {
    m?: string;
    at?: number;
    ttl?: number;
    b?: Pick<RecordedUsage, "speed" | "inference_geo">;
}
/** What a reader keeps between rows (and, in the budget's ledger, between reads). */
export interface CompactTrack {
    t: Record<string, Thread>;
    /** A boundary met whose summary row has not been: its uuid, time, context, thread, session. */
    p?: {
        u?: string;
        at: number;
        pre: number;
        th: string;
        s?: string;
    };
}
export declare const newTrack: () => CompactTrack;
/** A ledger's kept state, when it is one this version wrote. */
export declare function isTrack(v: unknown): v is CompactTrack;
/** One compaction's request, priced. */
export interface CompactionRequest {
    uuid?: string;
    sessionId?: string;
    sidechain: boolean;
    ts: number;
    model: string;
    usage: RecordedUsage;
    cost: RequestCost;
    /** The context it read from a live cache (false: written again). */
    warm: boolean;
}
/** The rows a reader must hand on: replies with usage, compaction boundaries, summary rows. */
export declare function isCompactionRow(line: string): boolean;
/**
 * Feed one parsed row; a compaction's request when this row completes one
 * (its summary row, or a reply that came with no summary row between). A
 * boundary still waiting for its summary at the end of what was read is kept
 * in `st` and priced when the summary is read.
 */
export declare function trackCompaction(st: CompactTrack, e: any): CompactionRequest | undefined;
/** A summary row as an extractor keeps it: its length, not its text. */
export declare function slimSummary(e: any): Record<string, unknown>;
export {};
