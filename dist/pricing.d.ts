/**
 * Per-model pricing for cost estimation, USD per million tokens.
 *
 * Anthropic prices are current as of mid-2026 (first-party API list rates).
 * OpenAI/Google figures are approximate public list prices and drift over
 * time — all cost output is labeled as an estimate. One table, one file,
 * easy to update: PRs welcome when prices change.
 */
export interface ModelPricing {
    /** USD per 1M input tokens. */
    inputPerM: number;
    /** USD per 1M output tokens (unused by the profiler, kept for reference). */
    outputPerM: number;
    /** USD per 1M cached input tokens read (≈10% of input for Claude/OpenAI). */
    cacheReadPerM: number;
}
export declare function pricingFor(model?: string): ModelPricing | undefined;
export declare function inputCostUsd(tokens: number, pricing: ModelPricing): number;
/**
 * Rough time-to-first-token impact of input size. Prompt processing on major
 * providers runs on the order of tens of thousands of tokens per second;
 * ~25k tok/s is a serviceable cross-provider planning number, so every 10k
 * input tokens costs roughly 0.4s of TTFT (much less on cache hits).
 */
export declare function estimatedTtftSeconds(inputTokens: number): number;
export declare function formatUsd(amount: number): string;
