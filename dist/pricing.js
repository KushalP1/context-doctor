/**
 * Per-model pricing for cost estimation, USD per million tokens.
 *
 * Anthropic prices are current as of mid-2026 (first-party API list rates).
 * OpenAI/Google figures are approximate public list prices and drift over
 * time — all cost output is labeled as an estimate. One table, one file,
 * easy to update: PRs welcome when prices change.
 */
const PRICING = [
    [/claude.*fable|claude.*mythos/i, { inputPerM: 10, outputPerM: 50, cacheReadPerM: 1 }],
    [/claude.*opus/i, { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5 }],
    [/claude.*sonnet/i, { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 }],
    [/claude.*haiku/i, { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1 }],
    [/gpt-4o-mini/i, { inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: 0.075 }],
    [/gpt-4o|gpt-4\.1/i, { inputPerM: 2.5, outputPerM: 10, cacheReadPerM: 1.25 }],
    [/gpt-4-turbo/i, { inputPerM: 10, outputPerM: 30, cacheReadPerM: 10 }],
    [/o[13](-|$)/i, { inputPerM: 2, outputPerM: 8, cacheReadPerM: 1 }],
    [/gemini.*flash/i, { inputPerM: 0.1, outputPerM: 0.4, cacheReadPerM: 0.025 }],
    [/gemini.*pro/i, { inputPerM: 1.25, outputPerM: 5, cacheReadPerM: 0.31 }],
];
export function pricingFor(model) {
    if (!model)
        return undefined;
    for (const [pattern, pricing] of PRICING) {
        if (pattern.test(model))
            return pricing;
    }
    return undefined;
}
export function inputCostUsd(tokens, pricing) {
    return (tokens / 1_000_000) * pricing.inputPerM;
}
/**
 * Rough time-to-first-token impact of input size. Prompt processing on major
 * providers runs on the order of tens of thousands of tokens per second;
 * ~25k tok/s is a serviceable cross-provider planning number, so every 10k
 * input tokens costs roughly 0.4s of TTFT (much less on cache hits).
 */
export function estimatedTtftSeconds(inputTokens) {
    return inputTokens / 25_000;
}
export function formatUsd(amount) {
    if (amount >= 1)
        return `$${amount.toFixed(2)}`;
    if (amount >= 0.01)
        return `$${amount.toFixed(3)}`;
    return `$${amount.toFixed(4)}`;
}
