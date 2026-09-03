/**
 * `context-doctor accuracy` — how much of what you are billed for is actually
 * visible in your transcript.
 *
 * Every profile in this tool describes the CONVERSATION: the messages the
 * transcript records. Your bill covers the whole request, which also carries
 * the harness's system prompt, tool schemas, skills, and per-turn injected
 * content that is never written to the transcript at all.
 *
 * Both numbers are correct; they answer different questions. This command
 * measures the distance between them on your own sessions, so "why is my bill
 * bigger than the profile?" has an answer with evidence behind it.
 *
 * WHAT THIS IS NOT: a tokenizer benchmark. It cannot be — the content behind
 * the gap is unavailable to us, so the gap cannot be attributed to estimator
 * drift. To measure the estimator itself, use `analyze --exact`, which counts
 * the same bytes with the provider's own tokenizer.
 */
export interface AccuracyReport {
    sessionsScanned: number;
    /** Turn-to-turn observations used. */
    samples: number;
    /** Median share of a turn's billed growth that the transcript accounts for. */
    medianCoverage: number;
    /** Median tokens per turn billed but absent from the transcript. */
    medianInvisiblePerTurn: number;
    /** Median fixed baseline: system prompt + tool schemas, before any turn. */
    medianBaseline?: number;
}
export declare function measureAccuracy(limit?: number): AccuracyReport;
export declare function renderAccuracy(report: AccuracyReport): string;
