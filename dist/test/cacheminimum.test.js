/**
 * The smallest prefix Anthropic caches depends on the model, and not
 * monotonically: 512 tokens on the 5.x generation, 1,024 on Opus 4.8 and
 * most Sonnets, 2,048 on Opus 4.7 and Haiku 3.5, 4,096 on Opus 4.6/4.5 and
 * Haiku 4.5. A blanket "1,024, 2,048 on Haiku" told a Haiku 5.5 app its
 * prompt was too small to cache and an Opus 4.6 app to add breakpoints that
 * could never hit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { minCacheableTokens, planCache } from "../cacheplan.js";
import { pricingFor } from "../pricing.js";
import { startProxy } from "../proxy.js";
import http from "node:http";
test("minimum cacheable prefix per model, dated, Bedrock and Vertex ids included", () => {
    const cases = [
        ["claude-opus-5-5", 512], ["claude-opus-5", 512], ["claude-fable-5", 512], ["claude-fable-5-1", 512],
        ["claude-mythos-5", 512], ["claude-mythos-5-1", 512], ["claude-sonnet-5-5", 512], ["claude-haiku-5-5", 512],
        ["claude-opus-4-8", 1024], ["claude-sonnet-5", 1024], ["claude-sonnet-4-6", 1024], ["claude-sonnet-4-5-20250929", 1024],
        ["claude-opus-4-1-20250805", 1024], ["claude-opus-4-20250514", 1024], ["claude-opus-4-0", 1024], ["claude-sonnet-4-20250514", 1024],
        ["claude-opus-4-7", 2048], ["claude-3-5-haiku-20241022", 2048], ["claude-mythos-preview", 2048],
        ["claude-opus-4-6", 4096], ["claude-opus-4-5-20251101", 4096], ["claude-haiku-4-5", 4096], ["claude-haiku-4-5-20251001", 4096],
        ["anthropic.claude-opus-4-5-20251101-v1:0", 4096], ["us.anthropic.claude-sonnet-5-5", 512], ["claude-opus-4-5@20251101", 4096],
    ];
    for (const [model, min] of cases)
        assert.equal(minCacheableTokens(model), min, model);
    assert.equal(minCacheableTokens(undefined), 1024, "unknown: the most common minimum");
    assert.equal(minCacheableTokens("claude-sonnet-9-9"), 1024);
});
test("cache-plan uses the model's own minimum: under 1k tokens caches on Haiku 5.5, ~3k does not on Opus 4.6", () => {
    const req = (model, words) => ({ model, system: "policy text ".repeat(words), messages: [{ role: "user", content: "q" }] });
    const haiku = planCache(req("claude-haiku-5-5", 160)).plan;
    assert.equal(haiku.minCacheable, 512);
    assert.ok(haiku.totalTokens < 1024 && haiku.plan.length > 0, `~${haiku.totalTokens} tokens is over Haiku 5.5's 512 minimum`);
    const opus46 = planCache(req("claude-opus-4-6", 650)).plan;
    assert.ok(opus46.totalTokens > 2048, `~${opus46.totalTokens} tokens`);
    assert.equal(opus46.minCacheable, 4096);
    assert.equal(opus46.plan.length, 0, `~${opus46.totalTokens} tokens is under Opus 4.6's 4,096 minimum`);
});
test("cache-plan prices a 1-hour TTL at 2x and writes the breakpoints it priced with that TTL", () => {
    const sys = "policy text ".repeat(3000);
    const long = planCache({ model: "claude-sonnet-5", system: [{ type: "text", text: sys, cache_control: { type: "ephemeral", ttl: "1h" } }], messages: [{ role: "user", content: "q" }] }, 10);
    const short = planCache({ model: "claude-sonnet-5", system: [{ type: "text", text: sys, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: "q" }] }, 10);
    const per = pricingFor("claude-sonnet-5").inputPerM / 1e6;
    // usdWith = first call (cached part written, rest at input) + 9 later calls (cached part read at 0.1x).
    const writeMult = (p) => {
        const rest = p.totalTokens - p.cachedTokens;
        return (p.usdWith - rest * per - 9 * (p.cachedTokens * 0.1 + rest) * per) / (p.cachedTokens * per);
    };
    assert.ok(Math.abs(writeMult(long.plan) - 2) < 1e-6, "1h writes cost 2x input");
    assert.ok(Math.abs(writeMult(short.plan) - 1.25) < 1e-6, "5-minute writes cost 1.25x input");
    const out = long.apply();
    assert.match(JSON.stringify(out), /"ttl":"1h"/, "the saved request keeps the 1-hour TTL it was priced at");
    assert.doesNotMatch(JSON.stringify(short.apply()), /"ttl"/);
});
test("the proxy's cache advisor uses the model's minimum too", async () => {
    const up = http.createServer((q, r) => { q.resume(); q.on("end", () => { r.setHeader("content-type", "application/json"); r.end("{}"); }); });
    await new Promise((r) => up.listen(0, "127.0.0.1", r));
    const px = startProxy({ port: 0, anthropicUpstream: `http://127.0.0.1:${up.address().port}` });
    await new Promise((r) => px.once("listening", r));
    const base = `http://127.0.0.1:${px.address().port}`;
    try {
        const send = (model, words) => fetch(`${base}/v1/messages`, {
            method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model, system: "policy text ".repeat(words), messages: [{ role: "user", content: "q" }] }),
        }).then((r) => r.text());
        await send("claude-opus-4-6", 600); // ~3k tokens: over the old 1,024, under Opus 4.6's 4,096
        await send("claude-haiku-5-5", 150); // ~750 tokens: under the old 1,024, over Haiku 5.5's 512
        const advice = (await fetch(`${base}/stats`).then((r) => r.json())).advice.join("\n");
        assert.doesNotMatch(advice, /claude-opus-4-6 without cache_control/);
        assert.match(advice, /claude-haiku-5-5 without cache_control/);
    }
    finally {
        px.close();
        up.close();
    }
});
