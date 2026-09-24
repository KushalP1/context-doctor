/**
 * Measure a model's real chars-per-token from Claude Code transcripts, with no
 * API key and no tokenizer: the API's own counts are already in the file.
 *
 * Two independent measurements, so one can check the other:
 *
 *  - PROSE. An assistant reply with no thinking block is billed as exactly
 *    `output_tokens`, and all of it is visible text in the transcript. Visible
 *    chars / output_tokens is the tokenizer's ratio on the model's own prose.
 *
 *  - BLOCKS (code, tool output, pastes). Between two consecutive API calls in
 *    one session the prompt is the old prompt plus what was appended: the
 *    previous reply (all of `output_tokens`, thinking included, since a tool
 *    loop re-sends it) and the new user-side content. When that content is a
 *    single large block, (growth − previous output_tokens) is its exact size.
 *
 * The injected reminders the harness adds make the block figure slightly
 * pessimistic (a few dozen tokens on blocks of thousands), which is why only
 * blocks over 6k chars count.
 */
export interface RatioStats {
    samples: number;
    median: number;
    p10: number;
    p90: number;
}
export interface ModelRatios {
    model: string;
    prose?: RatioStats;
    blocks?: RatioStats;
    /** What the estimator uses for this model: prose, code. */
    assumed: {
        prose: number;
        code: number;
    };
}
export interface TokenizerReport {
    sessionsScanned: number;
    models: ModelRatios[];
}
export declare function measureTokenizer(limit?: number, paths?: string[]): TokenizerReport;
export declare function renderTokenizer(report: TokenizerReport): string;
