/**
 * Token estimation without provider tokenizer dependencies.
 *
 * Exact token counts require each provider's tokenizer (tiktoken, Anthropic's
 * API, etc.). For profiling purposes an estimate within ~10% is enough to rank
 * what's eating the window, so we use a calibrated chars-per-token heuristic:
 * prose averages ~4 chars/token, code and JSON are denser (~3.2), and
 * whitespace-heavy content is cheaper. This keeps the tool zero-config and
 * fully offline.
 */
export type Provider = "anthropic" | "openai" | "google" | "generic";
export declare function contextWindowFor(model?: string): number | undefined;
export declare function providerFor(model?: string): Provider;
/**
 * Characters per token, by provider and by content type.
 *
 * Anthropic: measured 2026-09 against the API's own counts in 59 Claude Code
 * sessions (Opus 4.7 to 5, Fable 5.x), two independent ways that agree.
 * Prose: 504 assistant replies with no thinking block, visible text divided by
 * the exact output_tokens: median 2.75 (p10 2.4, p90 3.0). Code and tool
 * output: 474 single appended blocks over 6k chars, sized by the exact growth
 * of the billed prompt between consecutive calls: median 2.4 (p10 2.1, p90 2.8).
 * The ratios this tool used before (4.0 / 3.2) undercounted current Claude
 * models by about 1.45x on prose and 1.33x on code.
 *
 * OpenAI, Google and unknown models keep 4.0 / 3.2, the usual figures for
 * o200k-class tokenizers on English and code. They are not re-measured here:
 * Codex rollouts truncate tool output before the model sees it, so the same
 * delta method does not isolate a block. `analyze --exact` calibrates any
 * provider from its own tokenizer on your machine.
 */
export declare const CHARS_PER_TOKEN: Record<Provider, {
    prose: number;
    code: number;
}>;
/** True when text is dense with code/JSON symbols and tokenizes more finely. */
export declare function isCodeLike(text: string): boolean;
/** Chars per token to use for this text under this model's tokenizer. */
export declare function charsPerTokenFor(text: string, model?: string): number;
/**
 * Estimated tokens for `text`. Pass the model when you know it: Claude's
 * tokenizer produces ~40% more tokens than the provider-neutral default.
 */
export declare function estimateTokens(text: string, model?: string): number;
/** Per-message structural overhead (role markers, delimiters) is roughly constant. */
export declare const MESSAGE_OVERHEAD_TOKENS = 4;
export declare function formatTokens(n: number): string;
