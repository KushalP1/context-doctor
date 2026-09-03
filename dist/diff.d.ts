/**
 * `context-doctor diff <before> <after>` — compare two profiles.
 *
 * Optimization currently has to be taken on trust: you run it, a number
 * changes, and nothing shows what actually moved. This puts two profiles side
 * by side, so "we cut the context" becomes a claim with evidence — which
 * categories shrank, which findings were resolved, and what it means in money
 * and latency.
 *
 * Works on any two inputs `analyze` accepts, plus session transcripts, so it
 * covers before/after an optimization and one session against another.
 */
export declare function renderDiff(beforePath: string, afterPath: string, model?: string): string;
