/** cache-plan: breakpoints at the ends of the stable parts and the conversation, priced, applied. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planCache, renderCachePlan } from "../cacheplan.js";
const doc = "Reference material the agent consults on every step. ".repeat(400);
function request(turns) {
    const messages = [];
    for (let i = 0; i < turns; i++) {
        messages.push({ role: "user", content: `question ${i} ` + "detail ".repeat(50) });
        messages.push({ role: "assistant", content: [{ type: "text", text: `answer ${i} ` + "words ".repeat(50) }] });
    }
    messages.push({ role: "user", content: "the newest question" });
    return {
        model: "claude-sonnet-5",
        max_tokens: 1024,
        tools: [{ name: "search", description: "Search the docs", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
        system: "You are a support agent.\n\n" + doc,
        messages,
    };
}
test("places breakpoints at the end of system and of the conversation, skipping a tool prefix under the minimum", () => {
    const { plan } = planCache(request(3), 10);
    assert.deepEqual(plan.plan.map((b) => b.at), ["system[0]", "top level (automatic)"], "the conversation's end by automatic caching");
    assert.deepEqual(planCache(request(3), 10, undefined, { explicit: true }).plan.plan.map((b) => b.at), ["system[0]", "messages[6].content[0]"], "--explicit: a block-level one");
    assert.ok(plan.usdWith < plan.usdWithout * 0.3, "the same request ten times costs far less with the plan");
    assert.match(renderCachePlan(plan), /Place cache_control on \(2 of 4 allowed\)/);
});
test("a conversation longer than the 20-block lookback gets a middle anchor; never more than 4 breakpoints", () => {
    const { plan } = planCache(request(15), 5);
    assert.equal(plan.plan.length, 3);
    assert.ok(plan.plan.some((b) => /anchor/.test(b.why)));
});
test("apply writes exactly the planned breakpoints, converting a string system prompt to a block", () => {
    const r = request(3);
    r.messages[1].content[0].cache_control = { type: "ephemeral" }; // a stray one the plan replaces
    const { plan, apply } = planCache(r);
    const out = apply();
    const marked = JSON.stringify(out).match(/cache_control/g).length;
    assert.equal(marked, plan.plan.length);
    assert.ok(Array.isArray(out.system) && out.system[0].cache_control);
    assert.deepEqual(out.cache_control, { type: "ephemeral" }, "the conversation's end: one top-level field");
    assert.equal(typeof out.messages.at(-1).content, "string", "nothing placed on the last block itself");
    const explicit = planCache(request(3), 10, undefined, { explicit: true }).apply();
    assert.equal(explicit.cache_control, undefined);
    assert.ok(explicit.messages.at(-1).content[0].cache_control);
});
test("automatic caching already in the request: counted as a slot, kept, and its 400s named", () => {
    const r = { ...request(3), cache_control: { type: "ephemeral", ttl: "1h" } };
    const { plan, apply } = planCache(r, 10, undefined, { explicit: true });
    assert.deepEqual(plan.existing, ["top level (automatic)"]);
    assert.ok(plan.plan.some((b) => b.automatic), "an app's top-level cache_control is kept even with --explicit");
    assert.deepEqual(apply().cache_control, { type: "ephemeral", ttl: "1h" });
    // Four block breakpoints plus the top-level one: five slots.
    const five = { ...request(3), cache_control: { type: "ephemeral" } };
    for (const i of [1, 3, 5])
        five.messages[i].content[0].cache_control = { type: "ephemeral" };
    five.system = [{ type: "text", text: five.system, cache_control: { type: "ephemeral" } }];
    assert.match(planCache(five).plan.notes.join(" "), /takes a slot of its own.*400/);
    // The last block at another TTL than the top level.
    const clash = { ...request(3), cache_control: { type: "ephemeral" } };
    clash.messages[6] = { role: "user", content: [{ type: "text", text: "q", cache_control: { type: "ephemeral", ttl: "1h" } }] };
    assert.match(planCache(clash).plan.notes.join(" "), /differs from the top-level one.*400/);
});
test("Bedrock's legacy integration gets block-level breakpoints; current Bedrock models get automatic caching", () => {
    const legacy = planCache(request(3), 10, "anthropic.claude-opus-4-6-v1:0").plan;
    assert.ok(!legacy.plan.some((b) => b.automatic) && legacy.plan.some((b) => /^messages/.test(b.at)));
    assert.ok(planCache(request(3), 10, "us.anthropic.claude-opus-5-5").plan.plan.some((b) => b.automatic));
    const told = planCache({ ...request(3), cache_control: { type: "ephemeral" } }, 10, "anthropic.claude-sonnet-4-5-20250929-v1:0").plan;
    assert.match(told.notes.join(" "), /legacy integration .* 400/);
});
test("a request whose only breakpoint is the conversation's end is told automatic caching is all it needs", () => {
    const r = { model: "claude-opus-5-5", messages: [{ role: "user", content: "long question ".repeat(400) }] };
    const { plan } = planCache(r);
    assert.deepEqual(plan.plan.map((b) => b.at), ["top level (automatic)"]);
    assert.match(plan.notes.join(" "), /Automatic caching is all this request needs/);
    assert.match(renderCachePlan(plan), /"cache_control": \{"type": "ephemeral"\} beside "model"/);
});
test("reads are priced at the model's own rate: 0.05x on Opus 5.5, 0.1x on Sonnet 5", () => {
    const opus = planCache(request(3), 10, "claude-opus-5-5").plan;
    assert.ok(Math.abs(opus.readMultiplier - 0.05) < 1e-9);
    assert.match(renderCachePlan(opus), /read at 0\.05x/);
    assert.ok(Math.abs(planCache(request(3), 10).plan.readMultiplier - 0.1) < 1e-9);
});
test("the lookback counts a run of tool_use or tool_result blocks as one position", () => {
    // 12 turns of [one tool_use x3] / [three tool_results]: 72 blocks, 24 positions + the opener.
    const messages = [{ role: "user", content: "start " + "detail ".repeat(400) }];
    for (let t = 0; t < 12; t++) {
        messages.push({ role: "assistant", content: [0, 1, 2].map((k) => ({ type: "tool_use", id: `t${t}${k}`, name: "read", input: { path: `f${k}` } })) });
        messages.push({ role: "user", content: [0, 1, 2].map((k) => ({ type: "tool_result", tool_use_id: `t${t}${k}`, content: "ok" })) });
    }
    const { plan } = planCache({ model: "claude-opus-5-5", messages });
    assert.ok(plan.plan.some((b) => /anchor/.test(b.why)), "25 positions: past the 20-position lookback");
    const short = messages.slice(0, 17); // 8 turns: 17 positions, 49 blocks
    assert.ok(!planCache({ model: "claude-opus-5-5", messages: short }).plan.plan.some((b) => /anchor/.test(b.why)), "49 blocks but 17 positions: no anchor needed");
});
test("small requests and OpenAI requests get advice, not breakpoints", () => {
    const small = planCache({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }).plan;
    assert.equal(small.plan.length, 0);
    assert.match(small.notes.join(" "), /under the 1.0k minimum/);
    const oa = planCache({ model: "gpt-5", messages: [{ role: "system", content: doc }, { role: "user", content: "q" }] }).plan;
    assert.equal(oa.provider, "openai");
    assert.match(oa.notes.join(" "), /prompt_cache_key/);
});
test("a Gemini request gets Gemini caching advice, not an Anthropic plan of ~0 tokens", async () => {
    const { planCache, renderCachePlan } = await import("../cacheplan.js");
    const doc = "Section of the shared handbook about deployment, rollbacks and on-call rotations. ".repeat(400);
    const req = { model: "gemini-3.6-flash", systemInstruction: { parts: [{ text: "Answer from the handbook." }] }, contents: [{ role: "user", parts: [{ text: doc }, { text: "How do rollbacks work?" }] }] };
    const { plan } = planCache(req, 10);
    assert.equal(plan.provider, "gemini");
    assert.ok(plan.totalTokens > 4000, String(plan.totalTokens));
    assert.equal(plan.plan.length, 0);
    const out = renderCachePlan(plan);
    assert.match(out, /^CACHE PLAN[\s\S]*Gemini request for gemini-3\.6-flash/);
    assert.match(out, /implicitly/);
    assert.match(out, /cachedContent/);
    assert.doesNotMatch(out, /cache_control/);
});
test("planCache().apply() returns a planned copy and leaves the caller's request untouched", async () => {
    const { planCache } = await import("../cacheplan.js");
    const req = { model: "claude-sonnet-5", system: "You are a careful assistant. ".repeat(300), messages: [{ role: "user", content: "hi ".repeat(800) }] };
    const before = JSON.stringify(req);
    const planned = planCache(req, 10).apply();
    assert.equal(JSON.stringify(req), before, "caller's object unchanged");
    assert.notEqual(JSON.stringify(planned), before, "the copy carries the breakpoints");
});
