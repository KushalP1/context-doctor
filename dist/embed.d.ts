/**
 * Optional semantic ranking for `pack`, through a local Ollama.
 *
 * BM25 misses pure paraphrase ("how long before the cache goes cold" against
 * `COLD_IDLE_MS = 65 * 60_000`). When Ollama runs on this machine with an
 * embedding model, `pack --semantic` embeds the question and the chunks and
 * merges the two rankings by reciprocal rank fusion, which needs no
 * calibration between BM25 scores and cosine similarities. Never required:
 * without Ollama or an embedding model, pack stays lexical and says why.
 *
 * Local only (OLLAMA_HOST, default 127.0.0.1:11434), no key. Chunk vectors are
 * cached on disk by model and text hash, so packing the same folder again
 * embeds only what changed.
 */
import type { Chunk } from "./pack.js";
export interface SemanticResult {
    used: boolean;
    model?: string;
    /** Why semantic ranking was not used, or what it did. */
    note: string;
}
/** The embedding model to use: the one asked for, else the first installed model that looks like one. */
export declare function findEmbeddingModel(preferred?: string): Promise<string | undefined>;
/**
 * Re-score `chunks` in place: score = RRF(BM25 rank) + RRF(embedding rank),
 * k = 60. A chunk BM25 never matched can still rank by meaning alone.
 */
export declare function semanticRerank(chunks: Chunk[], query: string, opts?: {
    model?: string;
}): Promise<SemanticResult>;
