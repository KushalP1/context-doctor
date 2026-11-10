/**
 * Claude Fable 5.2 and Mythos 5.2 against the price page as read on
 * 2026-11-10 (platform.claude.com/docs/en/about-claude/pricing.md):
 * "Model pricing" $8 input, $10 5-minute writes, $16 1-hour writes, $0.20
 * cache hits (0.025x), $40 output; "Fast mode pricing" $16 / $80, caching
 * multipliers and data residency on top; "Data residency pricing" 1.1x for
 * Claude 4.6 and later. Before these rows `claude-fable-5-2` fell to the
 * Fable/Mythos family fallback ($10 / $50, reads $1): reads five times too
 * high, and labelled an estimate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CACHE_WRITE_1H, CACHE_WRITE_5M, hasKnownPrice, knownPricingFor, pricingFor, requestCost } from "../pricing.js";
const near = (a, b, what = "") => assert.ok(Math.abs(a - b) < 1e-12, `${what}: ${a} vs ${b}`);
const AT = Date.UTC(2026, 10, 10, 12);
/** 1k uncached, 4k written at 5 minutes, 6k at 1 hour, 50k read, 2k out. */
const usage = (extra = {}) => ({
    input_tokens: 1_000, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 50_000, output_tokens: 2_000,
    cache_creation: { ephemeral_5m_input_tokens: 4_000, ephemeral_1h_input_tokens: 6_000 }, ...extra,
});
/** By hand, from the page's columns: input, 5-minute writes, 1-hour writes, reads, output (USD per 1M). */
const byHand = (inp, w5, w1, read, out) => (1_000 * inp + 4_000 * w5 + 6_000 * w1 + 50_000 * read + 2_000 * out) / 1e6;
const IDS = [
    "claude-fable-5-2", "claude-mythos-5-2",
    // The spellings the claude() helper reads as one version: dated, [1m], Bedrock, Vertex.
    "claude-fable-5-2-20261101", "claude-fable-5-2[1m]", "anthropic.claude-fable-5-2", "us.anthropic.claude-mythos-5-2-v1:0", "claude-fable-5-2@20261101",
];
test("Fable 5.2 and Mythos 5.2: each column of the page's row, a price of their own (not the family fallback)", () => {
    for (const id of IDS) {
        const p = knownPricingFor(id);
        assert.deepEqual(p && [p.inputPerM, p.outputPerM, p.cacheReadPerM], [8, 40, 0.2], id);
        assert.equal(hasKnownPrice(id), true, id);
        // The page's write columns are the multipliers of $8: $10 and $16.
        assert.equal(p.inputPerM * CACHE_WRITE_5M, 10, id);
        assert.equal(p.inputPerM * CACHE_WRITE_1H, 16, id);
        const c = requestCost(id, usage(), AT);
        near(c.totalUsd, byHand(8, 10, 16, 0.2, 40), id);
        assert.equal(c.estimated, undefined, `${id} is not an estimate`);
    }
    // Neither takes another version's row, nor does another version take theirs.
    for (const [other, expected] of [["claude-fable-5", [10, 50, 1]], ["claude-fable-5-1", [10, 50, 0.25]], ["claude-mythos-5-1", [10, 50, 0.25]]]) {
        const p = pricingFor(other);
        assert.deepEqual([p.inputPerM, p.outputPerM, p.cacheReadPerM], expected, other);
    }
    for (const other of ["claude-fable-5-20", "claude-fable-5-21", "claude-opus-5-2"])
        assert.notDeepEqual(knownPricingFor(other)?.inputPerM, 8, other);
});
test("Fable 5.2 fast mode: $16 / $80, writes and reads at their multipliers of $16; US-only 1.1x on top", () => {
    for (const id of ["claude-fable-5-2", "claude-mythos-5-2"]) {
        const fast = requestCost(id, usage({ speed: "fast" }), AT);
        near(fast.totalUsd, byHand(16, 20, 32, 0.4, 80), `${id} fast`);
        near(fast.modifiers.fastUsd, byHand(16, 20, 32, 0.4, 80) - byHand(8, 10, 16, 0.2, 40), `${id} fast part`);
        const us = requestCost(id, usage({ inference_geo: "us" }), AT);
        near(us.totalUsd, byHand(8, 10, 16, 0.2, 40) * 1.1, `${id} US-only`);
        const both = requestCost(id, usage({ speed: "fast", inference_geo: "us" }), AT);
        near(both.totalUsd, byHand(16, 20, 32, 0.4, 80) * 1.1, `${id} fast + US-only`);
    }
    // No long-context tier: a 900k prompt bills at the same rates.
    const big = requestCost("claude-fable-5-2", { input_tokens: 900_000, output_tokens: 0 }, AT);
    near(big.totalUsd, 900_000 * 8 / 1e6, "900k prompt");
    assert.equal(big.modifiers.longUsd, 0);
});
test("the same month on Fable 5.1, on Fable 5.2, and on 5.2 as 0.45 priced it (the family fallback)", () => {
    // 2.83B read, 105M written at 1 hour, 4.5M output: the shape of the author's month (ROADMAP, K1).
    const month = { input_tokens: 0, cache_read_input_tokens: 2.83e9, cache_creation_input_tokens: 105e6, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 105e6 }, output_tokens: 4.5e6 };
    const on51 = requestCost("claude-fable-5-1", month, AT).totalUsd;
    const on52 = requestCost("claude-fable-5-2", month, AT).totalUsd;
    const asFallback = requestCost("claude-fable-9", month, AT);
    near(on52, on51 * 0.8, "0.8x Fable 5.1 on every column");
    assert.equal(asFallback.estimated, true);
    assert.ok(asFallback.totalUsd > on52 * 2, `the fallback ${asFallback.totalUsd} against ${on52}`);
});
