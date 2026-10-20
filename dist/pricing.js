/**
 * Per-model pricing for cost estimation, USD per million tokens.
 *
 * Anthropic prices are first-party API list rates, checked against
 * Anthropic's price list in October 2026. OpenAI/Google figures are
 * approximate public list prices and drift over time — all cost output is
 * labeled as an estimate. One table, one file, easy to update: PRs welcome
 * when prices change.
 */
/** Anthropic cache writes, relative to the input price: 5-minute TTL and 1-hour TTL. */
export const CACHE_WRITE_5M = 1.25;
export const CACHE_WRITE_1H = 2;
const rate = (inputPerM, outputPerM, cacheReadPerM) => ({ inputPerM, outputPerM, cacheReadPerM });
/**
 * One Claude version, whatever wraps the id: a date (-20251101, @20251101),
 * "[1m]", a Bedrock prefix. Prices differ between a major and its minor
 * releases (Opus 5 is $5 in, Opus 5.5 is $4), so neither may match the
 * other: a minor is one or two digits after the major, a date suffix is
 * eight, and that is what the lookaheads tell apart.
 */
function claude(families, major, minor) {
    return minor === undefined
        ? new RegExp(`claude-(?:${families})-${major}(?![.\\d]|-\\d{1,2}(?!\\d))`, "i")
        : new RegExp(`claude-(?:${families})-${major}[-.]${minor}(?!\\d)`, "i");
}
const PRICING = [
    // Specific Claude versions first: the family rows below are only a
    // fallback for ids this table does not know yet.
    [claude("fable|mythos", 5, 1), rate(10, 50, 0.25)],
    [claude("fable|mythos", 5), rate(10, 50, 1)],
    [claude("opus", 5, 5), rate(4, 20, 0.2)],
    [claude("opus", 5), rate(5, 25, 0.5)],
    [claude("opus", 4, 8), rate(5, 25, 0.5)],
    [claude("opus", 4, 7), rate(5, 25, 0.5)],
    [claude("opus", 4, 6), rate(5, 25, 0.5)],
    [claude("opus", 4, 5), rate(5, 25, 0.5)],
    [claude("opus", 4, 1), rate(15, 75, 1.5)],
    [claude("opus", 4), rate(15, 75, 1.5)],
    [/claude-3-opus/i, rate(15, 75, 1.5)],
    [claude("sonnet", 5, 5), rate(2, 10, 0.2)],
    [claude("sonnet", 5), rate(2, 10, 0.2)],
    // Haiku 5.5's rates hold for prompts up to 100k tokens; longer prompts
    // bill higher, a tier this per-token table does not model.
    [claude("haiku", 5, 5), rate(0.1, 0.5, 0.01)],
    [claude("haiku", 4, 5), rate(1, 5, 0.1)],
    [/claude-3-5-haiku/i, rate(0.8, 4, 0.08)],
    [/claude-3-haiku/i, rate(0.25, 1.25, 0.03)],
    // Sonnet 4.6, 4.5, 4 and the 3.x Sonnets are all $3 / $15 / $0.30: the family row.
    [/claude.*fable|claude.*mythos/i, rate(10, 50, 1)],
    [/claude.*opus/i, rate(5, 25, 0.5)],
    [/claude.*sonnet/i, rate(3, 15, 0.3)],
    [/claude.*haiku/i, rate(1, 5, 0.1)],
    [/gpt-5.*(mini|nano)/i, { inputPerM: 0.25, outputPerM: 2, cacheReadPerM: 0.025 }],
    [/gpt-5/i, { inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 }],
    [/gpt-4o-mini/i, { inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: 0.075 }],
    [/gpt-4o|gpt-4\.1/i, { inputPerM: 2.5, outputPerM: 10, cacheReadPerM: 1.25 }],
    [/gpt-4-turbo/i, { inputPerM: 10, outputPerM: 30, cacheReadPerM: 10 }],
    [/o[13](-|$)/i, { inputPerM: 2, outputPerM: 8, cacheReadPerM: 1 }],
    // Gemini 3, paid tier (ai.google.dev/gemini-api/docs/pricing, Oct 2026). 3.6/3.8 Flash
    // double from 2027-01-01; 3.1 Pro bills prompts over 200k at $4/$18/$0.40, a tier
    // this per-token table does not model.
    [/gemini-3[.\d]*-flash-lite/i, rate(0.3, 2.5, 0.03)],
    [/gemini-3\.1-flash-lite/i, rate(0.25, 1.5, 0.025)],
    [/gemini-3-flash/i, rate(0.5, 3, 0.05)],
    [/gemini-3[.\d]*-flash/i, rate(0.75, 3.75, 0.075)],
    [/gemini-3[.\d]*-pro/i, rate(2, 12, 0.2)],
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
/** A token count from recorded usage: numbers and numeric strings, anything else is 0. */
function count(v) {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
    return Number.isFinite(n) && n > 0 ? n : 0;
}
/**
 * A request's cache writes by TTL. Claude Code's main thread writes almost
 * everything at the 1-hour TTL (2x input) and subagents at 5 minutes
 * (1.25x), so a single 1.25x multiplier underpriced most writes by 37%.
 * Usage recorded without the split counts as 5-minute writes, the API's
 * default TTL.
 */
export function cacheWriteSplit(usage) {
    const total = count(usage?.cache_creation_input_tokens);
    const split = usage?.cache_creation;
    if (!split || typeof split !== "object")
        return { fiveMinute: total, oneHour: 0 };
    const all = total || count(split.ephemeral_5m_input_tokens) + count(split.ephemeral_1h_input_tokens);
    const oneHour = Math.min(all, count(split.ephemeral_1h_input_tokens));
    return { fiveMinute: all - oneHour, oneHour };
}
/**
 * The write price, relative to input, of a mix of 5-minute and 1-hour
 * writes. Simulations that charge a write that never happened (a cold
 * re-read, a compaction's fresh context) use the session's own mix, since
 * that is the TTL its harness would have written at; 1.25x when nothing was
 * written to learn from.
 */
export function writeMultiplier(fiveMinute, oneHour) {
    const total = fiveMinute + oneHour;
    return total > 0 ? (fiveMinute * CACHE_WRITE_5M + oneHour * CACHE_WRITE_1H) / total : CACHE_WRITE_5M;
}
/**
 * What one recorded request cost: uncached input, cache writes priced by
 * TTL, cache reads, output. The one place recorded usage is priced, so every
 * report agrees with the others and with the bill.
 */
export function usageCost(usage, pricing) {
    const { fiveMinute, oneHour } = cacheWriteSplit(usage);
    const perM = (tokens, usd) => (tokens * usd) / 1_000_000;
    const inputUsd = perM(count(usage?.input_tokens), pricing.inputPerM);
    const writeUsd = perM(fiveMinute * CACHE_WRITE_5M + oneHour * CACHE_WRITE_1H, pricing.inputPerM);
    const readUsd = perM(count(usage?.cache_read_input_tokens), pricing.cacheReadPerM);
    const outputUsd = perM(count(usage?.output_tokens), pricing.outputPerM);
    const promptUsd = inputUsd + writeUsd + readUsd;
    return { inputUsd, writeUsd, readUsd, outputUsd, promptUsd, totalUsd: promptUsd + outputUsd };
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
    // Same reasoning as formatTokens: "$NaN" is worse than "$0.00".
    if (!Number.isFinite(amount))
        return "$0.00";
    if (amount >= 1)
        return `$${amount.toFixed(2)}`;
    if (amount >= 0.01)
        return `$${amount.toFixed(3)}`;
    return `$${amount.toFixed(4)}`;
}
