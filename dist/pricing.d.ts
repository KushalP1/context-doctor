/**
 * Per-model pricing for cost estimation, USD per million tokens.
 *
 * List rates of each provider's first-party API (standard tier, global
 * routing, no batch or fast mode), each family with the page it was read
 * from and the date. Prices drift, so all cost output is labeled as an
 * estimate. One table, one file, easy to update: PRs welcome when prices
 * change.
 *
 * A row names one model (a "known" price, see knownPricingFor) unless it is
 * listed in FALLBACKS: those price ids the table does not know by version,
 * at a family's price, so a new release still gets a number. A model a
 * provider prices only per minute, per image or not at all has no row.
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
/**
 * OpenAI cache writes on GPT-5.6 and later, relative to input: 1.25x for the
 * default 30-minute lifetime (the same rate as Anthropic's 5-minute writes,
 * so they share that slot below) and 2.5x for 12 hours. "Total write rates,
 * not surcharges"; earlier models charge no writes (prompt caching guide,
 * read 2026-10-26).
 */
export declare const CACHE_WRITE_OPENAI_30M = 1.25;
export declare const CACHE_WRITE_OPENAI_12H = 2.5;
export declare function pricingFor(model?: string): ModelPricing | undefined;
/**
 * A model's price from a row for that model, not a family fallback: undefined
 * for an id the table only knows by family (a new release, a typo like
 * claude-opus-9, gpt-5-codex) and for one it does not know at all. What a
 * report needs to say which models it priced by guess or not at all.
 */
export declare function knownPricingFor(model?: string): ModelPricing | undefined;
/** Whether a model id has a price of its own in the table (see knownPricingFor). */
export declare function hasKnownPrice(model?: string): boolean;
/**
 * Ids that are never billed, so never "unpriced": Claude Code writes
 * `<synthetic>` on replies it makes itself (an error, an interruption)
 * without calling the API.
 */
export declare function isUnbilledModel(model?: string): boolean;
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
    /**
     * The cache writes split by TTL; absent in older transcripts.
     * `ttl_12h_input_tokens` carries OpenAI's 12-hour writes (see openAIUsage).
     */
    cache_creation?: {
        ephemeral_5m_input_tokens?: unknown;
        ephemeral_1h_input_tokens?: unknown;
        ttl_12h_input_tokens?: unknown;
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
    twelveHour: number;
};
/**
 * The write price, relative to input, of a mix of 5-minute and 1-hour
 * writes. Simulations that charge a write that never happened (a cold
 * re-read, a compaction's fresh context) use the session's own mix, since
 * that is the TTL its harness would have written at; 1.25x when nothing was
 * written to learn from.
 */
export declare function writeMultiplier(fiveMinute: number, oneHour: number, twelveHour?: number): number;
/**
 * What one recorded request cost: uncached input, cache writes priced by
 * TTL, cache reads, output. The one place recorded usage is priced, so every
 * report agrees with the others and with the bill.
 */
export declare function usageCost(usage: RecordedUsage | undefined | null, pricing: ModelPricing): UsageCost;
/**
 * OpenAI usage, in any of its shapes, as RecordedUsage: Responses
 * (`input_tokens`, `input_tokens_details.cached_tokens`, `cache_write_tokens`
 * and its `cache_write_tokens_details.ttl_30m_tokens` / `ttl_12h_tokens`),
 * Chat Completions (`prompt_tokens`, `prompt_tokens_details`,
 * `completion_tokens`) and Codex rollouts (`cached_input_tokens`,
 * `cache_write_input_tokens`). OpenAI's input count holds every input token
 * once, each billed at the uncached, cached or write rate, so the uncached
 * part is what is left after reads AND writes. Writes without a split are
 * 30-minute writes, the default lifetime: Codex rollouts record only the
 * total, so a Codex 12-hour write would be priced at half its 2.5x.
 */
export declare function openAIUsage(raw: Record<string, any> | undefined | null): RecordedUsage;
/**
 * Rough time-to-first-token impact of input size. Prompt processing on major
 * providers runs on the order of tens of thousands of tokens per second;
 * ~25k tok/s is a serviceable cross-provider planning number, so every 10k
 * input tokens costs roughly 0.4s of TTFT (much less on cache hits).
 */
export declare function estimatedTtftSeconds(inputTokens: number): number;
export declare function formatUsd(amount: number): string;
