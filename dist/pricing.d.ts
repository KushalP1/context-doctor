/**
 * Per-model pricing for cost estimation, USD per million tokens.
 *
 * List rates of each provider's first-party API (standard tier, global
 * routing, no batch or fast mode), each family with the page it was read
 * from and the date. What a request recorded can bill it differently (fast
 * mode, US-only inference, a long prompt's tier, web searches) and a row's
 * price can end on a known day: requestCost applies all of it, per request,
 * from the row's billing options. Prices drift, so all cost output is
 * labeled as an estimate. One table, one file, easy to update: PRs welcome
 * when prices change.
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
/** A model's list row, as the page lists it today (no tier, mode or date applied). */
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
    /** Anthropic: "fast" for a fast-mode request ("standard" otherwise). */
    speed?: unknown;
    /** Anthropic: "us" for US-only inference ("global", "", "not_available" otherwise). */
    inference_geo?: unknown;
    /** Anthropic: server-side tool uses billed per use. */
    server_tool_use?: {
        web_search_requests?: unknown;
        web_fetch_requests?: unknown;
        code_execution_requests?: unknown;
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
 * Recorded usage at given rates: uncached input, cache writes priced by
 * TTL, cache reads, output. The rates a request was billed at (its tier,
 * fast mode, US-only, its date) are requestCost's to decide.
 */
export declare function usageCost(usage: RecordedUsage | undefined | null, pricing: ModelPricing): UsageCost;
/** US-only inference on Claude 4.6 and later: 1.1x on every token category (Anthropic, "Data residency pricing", read 2026-11-08). */
export declare const US_ONLY_MULTIPLIER = 1.1;
/**
 * Claude's web search tool: $10 per 1,000 searches, on top of its tokens
 * (Anthropic, "Web search tool", read 2026-11-08). A token price, so not
 * under the US-only multiplier. Web fetch has no charge beyond its tokens;
 * code execution bills container time (1,550 free hours a month, then $0.05
 * an hour), which usage does not record per request: not modelled.
 */
export declare const WEB_SEARCH_USD: number;
/** The tokens a request's prompt holds: uncached input, cache reads and cache writes (what a long-prompt tier counts). */
export declare function promptTokens(usage: RecordedUsage | undefined | null): number;
/**
 * The rates a model's requests bill at, from its row and what the request
 * recorded: `rates` for a prompt up to `over` tokens, `longRates` beyond
 * (no tier: `over` absent). Fast mode replaces the rates (its price holds
 * across the full context window); US-only scales them. A request on or
 * after the day its row's price changes (`changedOn`) is priced at the
 * price the page said would follow, or the old one when it said none: an
 * estimate either way (a scheduled price can be called off: Sonnet 5's was).
 */
export interface RateCard {
    rates: ModelPricing;
    over?: number;
    longRates?: ModelPricing;
    /** The list row's own rates, before tier, fast mode and US-only: what the modifiers are measured from. */
    list: ModelPricing;
    /** Fast mode's rates applied. */
    fast?: true;
    /** US-only's 1.1x applied. */
    geo?: true;
    /** Priced by family or past its row's date: an estimate. */
    estimated?: true;
    /** "YYYY-MM-DD": the row's price changed on this day, before the request. */
    changedOn?: string;
    /** Web searches bill per use (Claude). */
    webSearch?: true;
}
/** The rate card for one of `model`'s requests at time `at`, with the modifiers its usage records. Undefined for a model with no price. */
export declare function rateCard(model: string | undefined, usage?: RecordedUsage | null, at?: number): RateCard | undefined;
/** A card's rates for a prompt of `prompt` tokens: its long tier's past `over`. */
export declare function ratesAt(card: RateCard, prompt: number): ModelPricing;
/**
 * What a request's billing modifiers added to its list-row price, in USD:
 * fast mode, US-only inference, a long-prompt tier, and the web searches it
 * ran (`webSearches` of them, `webSearchUsd`).
 */
export interface Modifiers {
    fastUsd: number;
    geoUsd: number;
    longUsd: number;
    webSearchUsd: number;
    webSearches: number;
}
export declare const NO_MODIFIERS: Readonly<Modifiers>;
export interface RequestCost extends UsageCost {
    /** The rates its tokens were billed at (the parts above); `totalUsd` adds the web searches. */
    rates: ModelPricing;
    modifiers: Modifiers;
    /** Priced by family, or past the day its row's price changed: an estimate. */
    estimated?: true;
    /** "YYYY-MM-DD": its row's price changed on this day, before the request. */
    changedOn?: string;
}
/**
 * What one recorded request cost, as billed: its model's row at the time it
 * ran, its prompt's tier, fast mode, US-only inference, cache writes by TTL,
 * and per-use tool fees. The one place a request's price is decided, so
 * every report agrees with the others and with the bill. `at`: when it ran.
 * Undefined for a model with no price.
 */
export declare function requestCost(model: string | undefined, usage: RecordedUsage | undefined | null, at?: number): RequestCost | undefined;
/** `a` plus `b`, part by part. */
export declare function addModifiers(a: Modifiers, b: Readonly<Modifiers>): Modifiers;
/**
 * When a model's price in the table stops being its list price: the day
 * (YYYY-MM-DD) and, when the page said, the price from then. Undefined for
 * a row with no end date. What `doctor` and the budget say once it has passed.
 */
export declare function priceChange(model?: string): {
    on: string;
    then?: ModelPricing;
} | undefined;
/** "gemini-4-argon's price changed on 2026-12-01; a newer context-doctor knows the new one": said for each model priced past its row's date. */
export declare function priceChangedText(models: Array<[model: string, on: string]>): string;
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
