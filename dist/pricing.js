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
/** Anthropic cache writes, relative to the input price: 5-minute TTL and 1-hour TTL. */
export const CACHE_WRITE_5M = 1.25;
export const CACHE_WRITE_1H = 2;
/**
 * OpenAI cache writes on GPT-5.6 and later, relative to input: 1.25x for the
 * default 30-minute lifetime (the same rate as Anthropic's 5-minute writes,
 * so they share that slot below) and 2.5x for 12 hours. "Total write rates,
 * not surcharges"; earlier models charge no writes (prompt caching guide,
 * read 2026-10-26).
 */
export const CACHE_WRITE_OPENAI_30M = 1.25;
export const CACHE_WRITE_OPENAI_12H = 2.5;
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
/** The Claude family fallbacks: a price for ids the table does not know by version yet. */
const CLAUDE_FAMILY = [/claude.*fable|claude.*mythos/i, /claude.*opus/i, /claude.*sonnet/i, /claude.*haiku/i];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * One OpenAI model by its exact name, bare, with a snapshot date
 * (gpt-5.5-2026-04-23) or behind a provider prefix (openai/gpt-5.5):
 * "gpt-5.5" never matches gpt-5.5-pro or gpt-5.5-cyber, "gpt-5" never
 * gpt-5.4, "o3" never o3-pro.
 */
function openai(name) {
    return new RegExp(`(?<![\\w.-])${escapeRe(name)}(?:-\\d{4}-\\d{2}-\\d{2})?(?![\\w.-])`, "i");
}
/**
 * One Gemini text model, with any suffix Google adds to the same model
 * (-preview, -001, -preview-05-20, -customtools), but not the image, audio,
 * live and TTS models that share its name and are priced per image or
 * minute, nor its -lite sibling.
 */
function gemini(name) {
    return new RegExp(`(?<![\\w.-])${escapeRe(name)}(?![\\w.])(?!-(?:[\\w.]+-)*(?:lite|image|tts|live|audio|transcribe|translate)\\b)`, "i");
}
/** A row that prices ids the table does not know by name, at a family's price. */
const FALLBACK = true;
const PRICING = [
    // Anthropic: platform.claude.com/docs/en/about-claude/pricing ("Model
    // pricing"; 5-minute writes 1.25x, 1-hour writes 2x), read 2026-11-06.
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
    // Sonnet 5.5's cache hits are 5% of input ($0.10), Sonnet 5's 10%.
    [claude("sonnet", 5, 5), rate(2, 10, 0.1)],
    [claude("sonnet", 5), rate(2, 10, 0.2)],
    // Haiku 5.5's rates hold for prompts up to 100k tokens; a longer prompt
    // bills the whole request at $0.50 / $2.50 / $0.05, a tier this per-token
    // table does not model.
    [claude("haiku", 5, 5), rate(0.1, 0.5, 0.01)],
    [claude("haiku", 4, 5), rate(1, 5, 0.1)],
    // Sonnet 4.6, 4.5 and 4 are all $3 / $15 / $0.30, the family row's price;
    // rows of their own so a spending cap can tell a known version from a
    // guess (knownPricingFor).
    [claude("sonnet", 4, 6), rate(3, 15, 0.3)],
    [claude("sonnet", 4, 5), rate(3, 15, 0.3)],
    [claude("sonnet", 4), rate(3, 15, 0.3)],
    // Retired Claude 3 models, no longer on the page: their last list price.
    [/claude-3-opus/i, rate(15, 75, 1.5)],
    [/claude-3-5-haiku/i, rate(0.8, 4, 0.08)],
    [/claude-3-haiku/i, rate(0.25, 1.25, 0.03)],
    [/claude-3-[57]-sonnet/i, rate(3, 15, 0.3)],
    // Claude Mythos Preview (claude-mythos-preview) has no list price on the
    // page; the Fable/Mythos family row prices it as a fallback.
    [CLAUDE_FAMILY[0], rate(10, 50, 1), FALLBACK],
    [CLAUDE_FAMILY[1], rate(5, 25, 0.5), FALLBACK],
    [CLAUDE_FAMILY[2], rate(3, 15, 0.3), FALLBACK],
    [CLAUDE_FAMILY[3], rate(1, 5, 0.1), FALLBACK],
    // OpenAI: developers.openai.com/api/docs/pricing (Standard, the "Short"
    // context column), read 2026-11-06. Prompts over 272k input tokens bill
    // the whole request at 2x input and cache rates and 1.5x output on GPT-5.4
    // and later (per model page), a tier this table does not model. Cache
    // writes are 1.25x input on GPT-5.6 and later (CACHE_WRITE_OPENAI_30M).
    // Models with no cached-input price (the -pro ones) read at full input.
    [openai("gpt-6-astra"), rate(10, 50, 1)],
    [openai("gpt-6-astra-law"), rate(10, 50, 1)],
    [openai("gpt-6.1-sol"), rate(2, 10, 0.1)],
    [openai("gpt-6.1-terra"), rate(1, 5, 0.05)],
    [openai("gpt-6-sol"), rate(2, 10, 0.2)],
    [openai("gpt-6-luna"), rate(0.1, 0.5, 0.01)],
    [openai("gpt-6-cyber"), rate(20, 100, 2)],
    [openai("gpt-6-rosalind"), rate(15, 75, 1.5)],
    [openai("gpt-rosalind-research"), rate(5, 25, 0.5)],
    [openai("gpt-rosalind-discovery"), rate(5, 25, 0.5)],
    // GPT-5.6 Sol's $4 / $20 is promotional "until November 30, 2026"; the
    // page does not say what follows. The gpt-5.6 alias routes to Sol (model
    // page, read 2026-11-06).
    [openai("gpt-5.6-sol"), rate(4, 20, 0.4)],
    [openai("gpt-5.6"), rate(4, 20, 0.4)],
    [openai("gpt-5.6-terra"), rate(2, 12, 0.2)],
    [openai("gpt-5.6-luna"), rate(0.2, 1.2, 0.02)],
    [openai("gpt-5.6-cyber"), rate(12.5, 75, 1.25)],
    [openai("gpt-5.5"), rate(5, 30, 0.5)],
    [openai("gpt-5.5-pro"), rate(30, 180, 30)],
    [openai("gpt-5.5-cyber"), rate(12.5, 75, 1.25)],
    [openai("gpt-5.4"), rate(2.5, 15, 0.25)],
    [openai("gpt-5.4-mini"), rate(0.75, 4.5, 0.075)],
    [openai("gpt-5.4-nano"), rate(0.2, 1.25, 0.02)],
    [openai("gpt-5.4-pro"), rate(30, 180, 30)],
    [openai("gpt-5.3-codex"), rate(1.75, 14, 0.175)],
    [openai("gpt-5.2"), rate(1.75, 14, 0.175)],
    [openai("gpt-5.2-pro"), rate(21, 168, 21)],
    [openai("gpt-5.1"), rate(1.25, 10, 0.125)],
    [openai("gpt-5"), rate(1.25, 10, 0.125)],
    [openai("gpt-5-mini"), rate(0.25, 2, 0.025)],
    [openai("gpt-5-nano"), rate(0.05, 0.4, 0.005)],
    [openai("gpt-5-pro"), rate(15, 120, 15)],
    [openai("gpt-4.1"), rate(2, 8, 0.5)],
    [openai("gpt-4.1-mini"), rate(0.4, 1.6, 0.1)],
    [openai("gpt-4o"), rate(2.5, 10, 1.25)],
    [openai("gpt-4o-mini"), rate(0.15, 0.6, 0.075)],
    [openai("o3"), rate(2, 8, 0.5)],
    [openai("o3-pro"), rate(20, 80, 20)],
    [openai("chat-latest"), rate(5, 30, 0.5)],
    // Fallbacks for OpenAI ids not on the page (gpt-5-codex, gpt-5.1-codex-max,
    // gpt-4.1-nano, gpt-4-turbo, o1, o3-mini...): older approximate prices.
    [/gpt-5.*(mini|nano)/i, rate(0.25, 2, 0.025), FALLBACK],
    [/gpt-5/i, rate(1.25, 10, 0.125), FALLBACK],
    [/gpt-4o-mini/i, rate(0.15, 0.6, 0.075), FALLBACK],
    [/gpt-4o|gpt-4\.1/i, rate(2.5, 10, 1.25), FALLBACK],
    [/gpt-4-turbo/i, rate(10, 30, 10), FALLBACK],
    [/o[13](-|$)/i, rate(2, 8, 1), FALLBACK],
    // Google: ai.google.dev/gemini-api/docs/pricing (paid tier, Standard, text),
    // read 2026-11-06.
    // Gemini 4 Argon's $2 / $10 / $0.10 hold through 2026-11-30; from
    // 2026-12-01 it is $4 / $20 / $0.20.
    [gemini("gemini-4-argon"), rate(2, 10, 0.1)],
    // 3.6 and 3.8 Flash double from 2027-01-01 ($1.50 / $7.50 / $0.15).
    [gemini("gemini-3.8-flash"), rate(0.75, 3.75, 0.075)],
    [gemini("gemini-3.6-flash"), rate(0.75, 3.75, 0.075)],
    [gemini("gemini-3.5-flash-lite"), rate(0.3, 2.5, 0.03)],
    [gemini("gemini-3.1-flash-lite"), rate(0.25, 1.5, 0.025)],
    // 3.1 Pro and 2.5 Pro bill prompts over 200k at $4 / $18 / $0.40 and
    // $2.50 / $15 / $0.25, a tier this table does not model.
    [gemini("gemini-3.1-pro"), rate(2, 12, 0.2)],
    [gemini("gemini-3-flash"), rate(0.5, 3, 0.05)],
    [gemini("gemini-2.5-pro"), rate(1.25, 10, 0.125)],
    [gemini("gemini-2.5-flash"), rate(0.3, 2.5, 0.03)],
    [gemini("gemini-2.5-flash-lite"), rate(0.1, 0.4, 0.01)],
    // Fallbacks for Gemini ids not on the page (gemini-3-pro, a new 3.x Flash,
    // 2.0 Flash...).
    [/gemini-3[.\d]*-flash-lite/i, rate(0.3, 2.5, 0.03), FALLBACK],
    [/gemini-3[.\d]*-flash/i, rate(0.75, 3.75, 0.075), FALLBACK],
    [/gemini-3[.\d]*-pro/i, rate(2, 12, 0.2), FALLBACK],
    [/gemini.*flash/i, rate(0.1, 0.4, 0.025), FALLBACK],
    [/gemini.*pro/i, rate(1.25, 5, 0.31), FALLBACK],
];
function row(model) {
    if (!model)
        return undefined;
    return PRICING.find(([pattern]) => pattern.test(model));
}
export function pricingFor(model) {
    return row(model)?.[1];
}
/**
 * A model's price from a row for that model, not a family fallback: undefined
 * for an id the table only knows by family (a new release, a typo like
 * claude-opus-9, gpt-5-codex) and for one it does not know at all. What a
 * report needs to say which models it priced by guess or not at all.
 */
export function knownPricingFor(model) {
    const r = row(model);
    return r && !r[2] ? r[1] : undefined;
}
/** Whether a model id has a price of its own in the table (see knownPricingFor). */
export function hasKnownPrice(model) {
    return knownPricingFor(model) !== undefined;
}
/**
 * Ids that are never billed, so never "unpriced": Claude Code writes
 * `<synthetic>` on replies it makes itself (an error, an interruption)
 * without calling the API.
 */
export function isUnbilledModel(model) {
    return model === "<synthetic>";
}
/**
 * A Claude model's price from a row for its own version, not a family
 * fallback: what a command that caps spending needs (`ab --budget`). An id
 * the table only knows by family (a new release, a typo like
 * claude-opus-9) gets undefined.
 */
export function exactClaudePricingFor(model) {
    return model && /claude/i.test(model) ? knownPricingFor(model) : undefined;
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
        return { fiveMinute: total, oneHour: 0, twelveHour: 0 };
    const all = total || count(split.ephemeral_5m_input_tokens) + count(split.ephemeral_1h_input_tokens) + count(split.ttl_12h_input_tokens);
    const oneHour = Math.min(all, count(split.ephemeral_1h_input_tokens));
    const twelveHour = Math.min(all - oneHour, count(split.ttl_12h_input_tokens));
    return { fiveMinute: all - oneHour - twelveHour, oneHour, twelveHour };
}
/**
 * The write price, relative to input, of a mix of 5-minute and 1-hour
 * writes. Simulations that charge a write that never happened (a cold
 * re-read, a compaction's fresh context) use the session's own mix, since
 * that is the TTL its harness would have written at; 1.25x when nothing was
 * written to learn from.
 */
export function writeMultiplier(fiveMinute, oneHour, twelveHour = 0) {
    const total = fiveMinute + oneHour + twelveHour;
    return total > 0 ? (fiveMinute * CACHE_WRITE_5M + oneHour * CACHE_WRITE_1H + twelveHour * CACHE_WRITE_OPENAI_12H) / total : CACHE_WRITE_5M;
}
/**
 * What one recorded request cost: uncached input, cache writes priced by
 * TTL, cache reads, output. The one place recorded usage is priced, so every
 * report agrees with the others and with the bill.
 */
export function usageCost(usage, pricing) {
    const { fiveMinute, oneHour, twelveHour } = cacheWriteSplit(usage);
    const perM = (tokens, usd) => (tokens * usd) / 1_000_000;
    const inputUsd = perM(count(usage?.input_tokens), pricing.inputPerM);
    const writeUsd = perM(fiveMinute * CACHE_WRITE_5M + oneHour * CACHE_WRITE_1H + twelveHour * CACHE_WRITE_OPENAI_12H, pricing.inputPerM);
    const readUsd = perM(count(usage?.cache_read_input_tokens), pricing.cacheReadPerM);
    const outputUsd = perM(count(usage?.output_tokens), pricing.outputPerM);
    const promptUsd = inputUsd + writeUsd + readUsd;
    return { inputUsd, writeUsd, readUsd, outputUsd, promptUsd, totalUsd: promptUsd + outputUsd };
}
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
export function openAIUsage(raw) {
    const u = raw ?? {};
    const details = u.input_tokens_details ?? u.prompt_tokens_details ?? {};
    const input = count(u.input_tokens ?? u.prompt_tokens);
    const cached = count(details.cached_tokens ?? u.cached_input_tokens);
    const writes = count(details.cache_write_tokens ?? u.cache_write_input_tokens);
    const split = details.cache_write_tokens_details ?? {};
    const twelveHour = Math.min(writes, count(split.ttl_12h_tokens));
    return {
        input_tokens: Math.max(0, input - cached - writes),
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: writes,
        cache_creation: { ephemeral_5m_input_tokens: writes - twelveHour, ephemeral_1h_input_tokens: 0, ttl_12h_input_tokens: twelveHour },
        output_tokens: count(u.output_tokens ?? u.completion_tokens),
    };
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
