/**
 * Per-model pricing for cost estimation, USD per million tokens.
 *
 * Anthropic prices are first-party API list rates, checked against
 * Anthropic's price list in October 2026. OpenAI/Google figures are
 * approximate public list prices and drift over time — all cost output is
 * labeled as an estimate. One table, one file, easy to update: PRs welcome
 * when prices change.
 */
export interface ModelPricing {
    /** USD per 1M input tokens. */
    inputPerM: number;
    /** USD per 1M output tokens (unused by the profiler, kept for reference). */
    outputPerM: number;
    /** USD per 1M cached input tokens read (2.5-10% of input, depending on the Claude model). */
    cacheReadPerM: number;
}
/** Anthropic cache writes, relative to the input price: 5-minute TTL and 1-hour TTL. */
export declare const CACHE_WRITE_5M = 1.25;
export declare const CACHE_WRITE_1H = 2;
export declare function pricingFor(model?: string): ModelPricing | undefined;
/**
 * A Claude model's price from a row for its own version, not a family
 * fallback: what a command that caps spending needs (`ab --budget`). An id
 * the table only knows by family (a new release, a typo like
 * claude-opus-9) gets undefined.
 */
export declare function exactClaudePricingFor(model?: string): ModelPricing | undefined;
export declare function inputCostUsd(tokens: number, pricing: ModelPricing): number;
/** `usage` as the API returns it and Claude Code records it on each reply. */
export interface RecordedUsage {
    input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    output_tokens?: unknown;
    /** The cache writes split by TTL; absent in older transcripts. */
    cache_creation?: {
        ephemeral_5m_input_tokens?: unknown;
        ephemeral_1h_input_tokens?: unknown;
    } | null;
}
export interface UsageCost {
    /** Uncached input. */
    inputUsd: number;
    /** Cache writes, each TTL at its own price. */
    writeUsd: number;
    readUsd: number;
    outputUsd: number;
    /** input + writes + reads: what the prompt cost. */
    promptUsd: number;
    totalUsd: number;
}
/**
 * A request's cache writes by TTL. Claude Code's main thread writes almost
 * everything at the 1-hour TTL (2x input) and subagents at 5 minutes
 * (1.25x), so a single 1.25x multiplier underpriced most writes by 37%.
 * Usage recorded without the split counts as 5-minute writes, the API's
 * default TTL.
 */
export declare function cacheWriteSplit(usage: RecordedUsage | undefined | null): {
    fiveMinute: number;
    oneHour: number;
};
/**
 * The write price, relative to input, of a mix of 5-minute and 1-hour
 * writes. Simulations that charge a write that never happened (a cold
 * re-read, a compaction's fresh context) use the session's own mix, since
 * that is the TTL its harness would have written at; 1.25x when nothing was
 * written to learn from.
 */
export declare function writeMultiplier(fiveMinute: number, oneHour: number): number;
/**
 * What one recorded request cost: uncached input, cache writes priced by
 * TTL, cache reads, output. The one place recorded usage is priced, so every
 * report agrees with the others and with the bill.
 */
export declare function usageCost(usage: RecordedUsage | undefined | null, pricing: ModelPricing): UsageCost;
/**
 * Rough time-to-first-token impact of input size. Prompt processing on major
 * providers runs on the order of tens of thousands of tokens per second;
 * ~25k tok/s is a serviceable cross-provider planning number, so every 10k
 * input tokens costs roughly 0.4s of TTFT (much less on cache hits).
 */
export declare function estimatedTtftSeconds(inputTokens: number): number;
export declare function formatUsd(amount: number): string;
