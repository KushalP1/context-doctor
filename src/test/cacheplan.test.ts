/** cache-plan: breakpoints at the ends of the stable parts and the conversation, priced, applied. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { planCache, renderCachePlan } from "../cacheplan.js";

const doc = "Reference material the agent consults on every step. ".repeat(400);

function request(turns: number) {
  const messages: any[] = [];
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
  assert.deepEqual(plan.plan.map((b) => b.at), ["system[0]", "messages[6].content[0]"]);
  assert.ok(plan.usdWith! < plan.usdWithout! * 0.3, "the same request ten times costs far less with the plan");
  assert.match(renderCachePlan(plan), /Place cache_control on \(2 of 4 allowed\)/);
});

test("a conversation longer than the 20-block lookback gets a middle anchor; never more than 4 breakpoints", () => {
  const { plan } = planCache(request(15), 5);
  assert.equal(plan.plan.length, 3);
  assert.ok(plan.plan.some((b) => /anchor/.test(b.why)));
});

test("apply writes exactly the planned breakpoints, converting a string system prompt to a block", () => {
  const r = request(3);
  (r.messages[1].content[0] as any).cache_control = { type: "ephemeral" }; // a stray one the plan replaces
  const { plan, apply } = planCache(r);
  const out = apply();
  const marked = JSON.stringify(out).match(/cache_control/g)!.length;
  assert.equal(marked, plan.plan.length);
  assert.ok(Array.isArray(out.system) && out.system[0].cache_control);
  assert.ok(out.messages.at(-1).content[0].cache_control);
});

test("small requests and OpenAI requests get advice, not breakpoints", () => {
  const small = planCache({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }).plan;
  assert.equal(small.plan.length, 0);
  assert.match(small.notes.join(" "), /under the 1.0k minimum/);
  const oa = planCache({ model: "gpt-5", messages: [{ role: "system", content: doc }, { role: "user", content: "q" }] }).plan;
  assert.equal(oa.provider, "openai");
  assert.match(oa.notes.join(" "), /prompt_cache_key/);
});
