/**
 * Prices per Claude version (Anthropic's list, October 2026) and the one
 * helper every report prices recorded usage with: cache writes by TTL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheWriteSplit, pricingFor, usageCost, writeMultiplier } from "../pricing.js";
const price = (model) => {
    const p = pricingFor(model);
    return p ? [p.inputPerM, p.outputPerM, p.cacheReadPerM] : undefined;
};
test("each Claude version at its own price; a major and its minor release never match each other", () => {
    assert.deepEqual(price("claude-fable-5-1"), [10, 50, 0.25]);
    assert.deepEqual(price("claude-mythos-5-1"), [10, 50, 0.25]);
    assert.deepEqual(price("claude-fable-5"), [10, 50, 1]);
    assert.deepEqual(price("claude-mythos-5"), [10, 50, 1]);
    assert.deepEqual(price("claude-opus-5-5"), [4, 20, 0.2]);
    assert.deepEqual(price("claude-opus-5"), [5, 25, 0.5]);
    for (const m of ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5-20251101"])
        assert.deepEqual(price(m), [5, 25, 0.5], m);
    for (const m of ["claude-opus-4-1-20250805", "claude-opus-4-20250514", "claude-3-opus-20240229"])
        assert.deepEqual(price(m), [15, 75, 1.5], m);
    assert.deepEqual(price("claude-sonnet-5-5"), [2, 10, 0.2]);
    assert.deepEqual(price("claude-sonnet-5"), [2, 10, 0.2]);
    for (const m of ["claude-sonnet-4-6", "claude-sonnet-4-5-20250929", "claude-sonnet-4-20250514", "claude-3-7-sonnet-20250219", "claude-3-5-sonnet-20241022"])
        assert.deepEqual(price(m), [3, 15, 0.3], m);
    assert.deepEqual(price("claude-haiku-5-5"), [0.1, 0.5, 0.01]);
    assert.deepEqual(price("claude-haiku-4-5-20251001"), [1, 5, 0.1]);
    assert.deepEqual(price("claude-3-5-haiku-20241022"), [0.8, 4, 0.08]);
    assert.deepEqual(price("claude-3-haiku-20240307"), [0.25, 1.25, 0.03]);
});
test("ids carry dates, [1m] and provider prefixes without changing the version they name", () => {
    assert.deepEqual(price("claude-opus-5-20260301"), [5, 25, 0.5], "a date is not a minor version");
    assert.deepEqual(price("claude-opus-5[1m]"), [5, 25, 0.5]);
    assert.deepEqual(price("claude-opus-5-5[1m]"), [4, 20, 0.2]);
    assert.deepEqual(price("claude-opus-5-5-20260801"), [4, 20, 0.2]);
    assert.deepEqual(price("claude-fable-5-1[1m]"), [10, 50, 0.25]);
    assert.deepEqual(price("claude-opus-4-5@20251101"), [5, 25, 0.5]);
    assert.deepEqual(price("us.anthropic.claude-sonnet-5-5"), [2, 10, 0.2]);
    assert.equal(pricingFor("<synthetic>"), undefined);
    // Non-Claude rows are untouched.
    assert.deepEqual(price("gpt-5"), [1.25, 10, 0.125]);
    assert.deepEqual(price("gemini-2.5-flash"), [0.1, 0.4, 0.025]);
});
test("usageCost prices recorded usage with cache writes by TTL", () => {
    const opus55 = pricingFor("claude-opus-5-5");
    const usage = {
        input_tokens: 1000,
        cache_creation_input_tokens: 10_000,
        cache_read_input_tokens: 100_000,
        output_tokens: 500,
        cache_creation: { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 8_000 },
    };
    const c = usageCost(usage, opus55);
    assert.ok(Math.abs(c.inputUsd - (1000 * 4) / 1e6) < 1e-12);
    // 2k at 1.25x and 8k at 2x of $4/M.
    assert.ok(Math.abs(c.writeUsd - ((2000 * 1.25 + 8000 * 2) * 4) / 1e6) < 1e-12);
    assert.ok(Math.abs(c.readUsd - (100_000 * 0.2) / 1e6) < 1e-12);
    assert.ok(Math.abs(c.outputUsd - (500 * 20) / 1e6) < 1e-12);
    assert.ok(Math.abs(c.promptUsd - (c.inputUsd + c.writeUsd + c.readUsd)) < 1e-12);
    assert.ok(Math.abs(c.totalUsd - (c.promptUsd + c.outputUsd)) < 1e-12);
    // Without the split (older transcripts) writes are 5-minute writes.
    const { cache_creation: _, ...noSplit } = usage;
    assert.deepEqual(cacheWriteSplit(noSplit), { fiveMinute: 10_000, oneHour: 0 });
    assert.ok(Math.abs(usageCost(noSplit, opus55).writeUsd - (10_000 * 1.25 * 4) / 1e6) < 1e-12);
    // Garbage counts as nothing, never NaN.
    assert.equal(usageCost({ input_tokens: "abc", cache_read_input_tokens: -5, cache_creation: null }, opus55).totalUsd, 0);
});
test("writeMultiplier: a session's mix of 5-minute and 1-hour writes, 1.25x when it wrote nothing", () => {
    assert.equal(writeMultiplier(0, 0), 1.25);
    assert.equal(writeMultiplier(100, 0), 1.25);
    assert.equal(writeMultiplier(0, 100), 2);
    assert.equal(writeMultiplier(1, 3), (1.25 + 3 * 2) / 4);
});
