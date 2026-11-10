/**
 * What a request recorded that bills it above its row (requestCost), each
 * against the provider's page as read on 2026-11-08:
 *
 *  - Anthropic, platform.claude.com/docs/en/about-claude/pricing.md: "Fast
 *    mode pricing" (Opus 5.5 $8 / $40, Opus 5 and 4.8 $10 / $50, caching
 *    multipliers on top), "Data residency pricing" (1.1x on every category
 *    for Claude 4.6 and later, Haiku 5.5's long-prompt prices included),
 *    "Long context pricing" (Haiku 5.5 over 100,000 prompt tokens, cache
 *    reads and writes counted: $0.50 / $2.50 / $0.05), "Web search tool"
 *    ($10 per 1,000 searches; web fetch free).
 *  - OpenAI, developers.openai.com/api/docs/pricing: "Long context: >272K
 *    input tokens", 2x input and cached input, 1.5x output.
 *  - Google, ai.google.dev/gemini-api/docs/pricing: 3.1 Pro and 2.5 Pro over
 *    200k prompt tokens.
 * And the rows whose price ends on a day (P2), with a clock on either side.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pricingFor, priceChange, priceChangedText, promptTokens, rateCard, ratesAt, requestCost, usageCost } from "../pricing.js";
const near = (a, b, what = "") => assert.ok(Math.abs(a - b) < 1e-12, `${what}: ${a} vs ${b}`);
const AT = Date.UTC(2026, 10, 8, 12);
/** 1k uncached, 10k written at 1 hour, 50k read, 2k out. */
const usage = (extra = {}) => ({
    input_tokens: 1_000, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 50_000, output_tokens: 2_000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10_000 }, ...extra,
});
/** By hand: input, 1-hour writes (2x input), reads, output, USD per 1M. */
const cost = (inp, read, out) => (1_000 * inp + 10_000 * 2 * inp + 50_000 * read + 2_000 * out) / 1e6;
test("no modifier recorded: requestCost is the list row's usageCost, to the bit", () => {
    for (const [model, u] of [
        ["claude-opus-5-5", usage({ speed: "standard", inference_geo: "global", server_tool_use: { web_search_requests: 0, web_fetch_requests: 3 } })],
        ["claude-haiku-5-5", usage({ inference_geo: "not_available" })],
        ["gpt-5.5", usage()],
        ["gemini-3.1-pro-preview", usage()],
    ]) {
        const c = requestCost(model, u, AT);
        assert.equal(c.totalUsd, usageCost(u, pricingFor(model)).totalUsd, model);
        assert.deepEqual(c.modifiers, { fastUsd: 0, geoUsd: 0, longUsd: 0, webSearchUsd: 0, webSearches: 0 }, model);
        assert.equal(c.estimated, undefined);
    }
    assert.equal(requestCost("llama-3", usage(), AT), undefined);
    assert.equal(requestCost(undefined, usage(), AT), undefined);
});
test("fast mode (usage.speed \"fast\"): Opus 5.5 at $8 / $40, Opus 5 and 4.8 at $10 / $50, cache rates on top; other models as listed", () => {
    const u = usage({ speed: "fast" });
    const o55 = requestCost("claude-opus-5-5", u, AT);
    // Opus 5.5's reads are 0.05x of input: $0.40 in fast mode.
    near(o55.totalUsd, cost(8, 0.4, 40), "Opus 5.5 fast");
    near(o55.modifiers.fastUsd, cost(8, 0.4, 40) - cost(4, 0.2, 20), "what fast mode added");
    assert.deepEqual([o55.rates.inputPerM, o55.rates.outputPerM, o55.rates.cacheReadPerM], [8, 40, 0.4]);
    for (const m of ["claude-opus-5", "claude-opus-4-8"]) {
        const c = requestCost(m, u, AT);
        near(c.totalUsd, cost(10, 1, 50), m);
        near(c.modifiers.fastUsd, cost(10, 1, 50) - cost(5, 0.5, 25), m);
    }
    // The page names no fast price for these: billed at their rows, nothing added.
    for (const m of ["claude-opus-4-7", "claude-sonnet-5-5", "claude-fable-5-1"]) {
        const c = requestCost(m, u, AT);
        assert.equal(c.totalUsd, usageCost(u, pricingFor(m)).totalUsd, m);
        assert.equal(c.modifiers.fastUsd, 0, m);
    }
    // "Fast mode pricing applies across the full context window": no other tier.
    const big = usage({ speed: "fast", cache_read_input_tokens: 900_000 });
    near(requestCost("claude-opus-5-5", big, AT).totalUsd, (1_000 * 8 + 10_000 * 16 + 900_000 * 0.4 + 2_000 * 40) / 1e6, "fast over 200k");
});
test("US-only inference (usage.inference_geo \"us\"): 1.1x on every category for Claude 4.6 and later, on top of fast mode; earlier models as listed", () => {
    const us = usage({ inference_geo: "us" });
    for (const [m, inp, read, out] of [
        ["claude-opus-5-5", 4, 0.2, 20], ["claude-fable-5-1", 10, 0.25, 50], ["claude-sonnet-5", 2, 0.2, 10],
        ["claude-sonnet-4-6", 3, 0.3, 15], ["claude-opus-4-6", 5, 0.5, 25], ["claude-haiku-5-5", 0.1, 0.01, 0.5],
    ]) {
        const c = requestCost(m, us, AT);
        near(c.totalUsd, cost(inp, read, out) * 1.1, m);
        near(c.modifiers.geoUsd, cost(inp, read, out) * 0.1, m);
    }
    // Earlier models reject the parameter (a 400): never billed at 1.1x.
    for (const m of ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5-20251001", "claude-opus-4-1"])
        assert.equal(requestCost(m, us, AT).modifiers.geoUsd, 0, m);
    // Not an Anthropic field anywhere else.
    assert.equal(requestCost("gpt-5.5", us, AT).modifiers.geoUsd, 0);
    // Stacked on fast mode: data residency "on top of fast mode pricing".
    const both = requestCost("claude-opus-5-5", usage({ speed: "fast", inference_geo: "us" }), AT);
    near(both.totalUsd, cost(8, 0.4, 40) * 1.1, "fast + US-only");
    near(both.modifiers.fastUsd, cost(8, 0.4, 40) - cost(4, 0.2, 20), "fast part");
    near(both.modifiers.geoUsd, cost(8, 0.4, 40) * 0.1, "US-only part");
    near(both.totalUsd, cost(4, 0.2, 20) + both.modifiers.fastUsd + both.modifiers.geoUsd, "the parts add up");
});
test("Haiku 5.5 over 100k prompt tokens (cache reads and writes count): the whole request at $0.50 / $2.50 / $0.05; US-only on top", () => {
    // 150k prompt: 1k uncached + 10k written + 139k read.
    const long = usage({ cache_read_input_tokens: 139_000 });
    assert.equal(promptTokens(long), 150_000);
    const c = requestCost("claude-haiku-5-5", long, AT);
    const at = (inp, read, out) => (1_000 * inp + 10_000 * 2 * inp + 139_000 * read + 2_000 * out) / 1e6;
    near(c.totalUsd, at(0.5, 0.05, 2.5), "150k Haiku 5.5");
    near(c.modifiers.longUsd, at(0.5, 0.05, 2.5) - at(0.1, 0.01, 0.5), "what the tier added");
    // Exactly 100,000 is not over it.
    const edge = usage({ cache_read_input_tokens: 89_000 });
    assert.equal(promptTokens(edge), 100_000);
    assert.equal(requestCost("claude-haiku-5-5", edge, AT).modifiers.longUsd, 0);
    // "the multiplier also applies to the higher prices for prompts over 100,000 tokens".
    const us = requestCost("claude-haiku-5-5", { ...long, inference_geo: "us" }, AT);
    near(us.totalUsd, at(0.5, 0.05, 2.5) * 1.1, "150k Haiku 5.5, US-only");
    near(us.modifiers.longUsd, c.modifiers.longUsd, "the tier's part, before US-only");
    // Haiku 4.5 has no tier.
    assert.equal(requestCost("claude-haiku-4-5", long, AT).modifiers.longUsd, 0);
    // The rate card a replay re-evaluates per simulated prompt.
    const card = rateCard("claude-haiku-5-5", undefined, AT);
    assert.equal(card.over, 100_000);
    assert.deepEqual(ratesAt(card, 99_000), pricingFor("claude-haiku-5-5"));
    assert.deepEqual([ratesAt(card, 120_000).inputPerM, ratesAt(card, 120_000).outputPerM, ratesAt(card, 120_000).cacheReadPerM], [0.5, 2.5, 0.05]);
});
test("web searches (usage.server_tool_use.web_search_requests): $10 per 1,000 on Claude, not under US-only; web fetch free", () => {
    const c = requestCost("claude-sonnet-5-5", usage({ server_tool_use: { web_search_requests: 3, web_fetch_requests: 2 } }), AT);
    near(c.modifiers.webSearchUsd, 0.03, "3 searches");
    assert.equal(c.modifiers.webSearches, 3);
    near(c.totalUsd, cost(2, 0.1, 10) + 0.03, "tokens + searches");
    near(c.totalUsd - c.promptUsd - c.outputUsd, 0.03, "not a token part");
    const us = requestCost("claude-sonnet-5-5", usage({ inference_geo: "us", server_tool_use: { web_search_requests: 3 } }), AT);
    near(us.totalUsd, cost(2, 0.1, 10) * 1.1 + 0.03, "the fee is not a token price");
    // Not recorded for other providers' models (OpenAI usage has no such field).
    assert.equal(requestCost("gpt-5.5", usage({ server_tool_use: { web_search_requests: 3 } }), AT).modifiers.webSearchUsd, 0);
});
test("OpenAI over 272k input tokens: 2x input, cached input and writes, 1.5x output, on the models with a long-context column", () => {
    const short = usage({ cache_read_input_tokens: 261_000 }); // 272,000: not over
    const long = usage({ cache_read_input_tokens: 262_000 }); // 273,000
    const at = (u, inp, read, out) => (1_000 * inp + 10_000 * 1.25 * inp + Number(u.cache_read_input_tokens) * read + 2_000 * out) / 1e6;
    const fiveMin = (u) => ({ ...u, cache_creation: null });
    // Page values, short then long: gpt-5.5 $5/$30/$0.50 -> $10/$45/$1; gpt-6-astra $10/$50/$1 -> $20/$75/$2; gpt-5.4 $2.50/$15/$0.25 -> $5/$22.50/$0.50.
    for (const [m, s, l] of [
        ["gpt-5.5", [5, 0.5, 30], [10, 1, 45]], ["gpt-6-astra", [10, 1, 50], [20, 2, 75]], ["gpt-5.4", [2.5, 0.25, 15], [5, 0.5, 22.5]],
        ["gpt-6.1-sol", [2, 0.1, 10], [4, 0.2, 15]], ["gpt-5.6-terra", [2, 0.2, 12], [4, 0.4, 18]], ["gpt-5.4-pro", [30, 30, 180], [60, 60, 270]],
    ]) {
        near(requestCost(m, fiveMin(short), AT).totalUsd, at(short, s[0], s[1], s[2]), `${m} at 272k`);
        const c = requestCost(m, fiveMin(long), AT);
        near(c.totalUsd, at(long, l[0], l[1], l[2]), `${m} over 272k`);
        near(c.modifiers.longUsd, at(long, l[0], l[1], l[2]) - at(long, s[0], s[1], s[2]), `${m}: the tier's part`);
    }
    // No long-context column on the page: no tier.
    for (const m of ["gpt-5.4-mini", "gpt-5.2", "gpt-6-cyber", "gpt-5-codex"])
        assert.equal(requestCost(m, fiveMin(long), AT).modifiers.longUsd, 0, m);
});
test("Gemini 3.1 Pro and 2.5 Pro over 200k prompt tokens", () => {
    const long = { input_tokens: 150_000, cache_read_input_tokens: 60_000, output_tokens: 1_000 };
    near(requestCost("gemini-3.1-pro-preview", long, AT).totalUsd, (150_000 * 4 + 60_000 * 0.4 + 1_000 * 18) / 1e6, "3.1 Pro over 200k");
    near(requestCost("gemini-2.5-pro", long, AT).totalUsd, (150_000 * 2.5 + 60_000 * 0.25 + 1_000 * 15) / 1e6, "2.5 Pro over 200k");
    const short = { input_tokens: 140_000, cache_read_input_tokens: 60_000, output_tokens: 1_000 };
    near(requestCost("gemini-3.1-pro-preview", short, AT).totalUsd, (140_000 * 2 + 60_000 * 0.2 + 1_000 * 12) / 1e6, "3.1 Pro at 200k");
    // Flash has no tier.
    assert.equal(requestCost("gemini-3.8-flash", long, AT).modifiers.longUsd, 0);
});
test("prices that end on a day: the row before it, past it the page's next price (or the old one) as an estimate saying the day", () => {
    // 100k in, 100k out: under every long-prompt tier.
    const u = { input_tokens: 100_000, output_tokens: 100_000 };
    const day = (s) => Date.parse(`${s}T00:00:00Z`);
    for (const [model, on, before, after] of [
        // OpenAI: "GPT-5.6 Sol's promotional pricing is available until November 30, 2026"; nothing said of what follows.
        ["gpt-5.6-sol", "2026-12-01", 2.4, 2.4],
        ["gpt-5.6", "2026-12-01", 2.4, 2.4],
        // Google: "$2.00 through November 30, 2026. $4.00 starting December 1, 2026" (and $10 -> $20 output).
        ["gemini-4-argon", "2026-12-01", 1.2, 2.4],
        // "$0.75 through December 31, 2026. $1.50 starting January 1, 2027" ($3.75 -> $7.50 output).
        ["gemini-3.8-flash", "2027-01-01", 0.45, 0.9],
        ["gemini-3.6-flash", "2027-01-01", 0.45, 0.9],
        // gemini-2.5-pro routes to 3.8 Flash from December 1, 2026, at its rates.
        ["gemini-2.5-pro", "2026-12-01", 1.125, 0.45],
    ]) {
        assert.deepEqual(priceChange(model)?.on, on, model);
        const was = requestCost(model, u, day(on) - 1);
        near(was.totalUsd, before, `${model} the moment before`);
        assert.equal(was.estimated, undefined, model);
        assert.equal(was.changedOn, undefined, model);
        const now = requestCost(model, u, day(on));
        near(now.totalUsd, after, `${model} from ${on}`);
        assert.equal(now.estimated, true, model);
        assert.equal(now.changedOn, on, model);
        assert.equal(rateCard(model, undefined, day(on) + 86_400_000).changedOn, on);
    }
    // Routed to Flash: no Pro tier after the day.
    assert.equal(rateCard("gemini-2.5-pro", undefined, day("2026-12-01")).over, undefined);
    assert.equal(rateCard("gemini-2.5-pro", undefined, day("2026-11-30")).over, 200_000);
    // ... and billed as 3.8 Flash is from then on: its own price doubles on January 1, 2027, so a routed request's does too.
    const routed = requestCost("gemini-2.5-pro", u, day("2027-01-01"));
    near(routed.totalUsd, requestCost("gemini-3.8-flash", u, day("2027-01-01")).totalUsd, "gemini-2.5-pro routed, in 2027");
    near(routed.totalUsd, 0.9, "gemini-2.5-pro routed, in 2027");
    assert.equal(routed.changedOn, "2027-01-01");
    assert.equal(routed.estimated, true);
    // A row with no end date never expires; Sonnet 5's scheduled increase was called off.
    for (const m of ["claude-sonnet-5", "gpt-6-astra-law", "gemini-2.5-flash"]) {
        assert.equal(priceChange(m), undefined, m);
        assert.equal(requestCost(m, u, Date.UTC(2030, 0, 1)).estimated, undefined, m);
    }
    assert.equal(priceChangedText([["gemini-4-argon", "2026-12-01"], ["gpt-5.6-sol", "2026-12-01"], ["gemini-3.8-flash", "2027-01-01"]]), "gemini-4-argon, gpt-5.6-sol: price changed on 2026-12-01; gemini-3.8-flash: price changed on 2027-01-01; a newer context-doctor knows the new one");
});
test("a family fallback is an estimate; its US-only still applies (an unknown Claude version is a new one)", () => {
    const c = requestCost("claude-opus-9", usage({ inference_geo: "us" }), AT);
    assert.equal(c.estimated, true);
    assert.equal(c.changedOn, undefined);
    near(c.totalUsd, cost(5, 0.5, 25) * 1.1, "family row, US-only");
});
