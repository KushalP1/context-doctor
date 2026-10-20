/** Similar messages are one finding per cluster, counted once, and the report's sums never pass the context. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConversation } from "../parse.js";
import { profileConversation } from "../profile.js";
import { renderProfile } from "../report.js";

const base = "The deployment pipeline builds the image, runs the integration suite, pushes to the registry and then rolls out region by region with health checks between each wave. ".repeat(12);

test("40 similar messages are one finding, not 780 pairs, and recovery stays below the context", () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `Variant ${i}: ${base} note ${i}` }));
  const p = profileConversation(parseConversation(JSON.stringify({ messages })), "claude-sonnet-5");
  const near = p.findings.filter((f) => f.id === "near_duplicate");
  assert.equal(near.length, 1);
  assert.equal(near[0].messages.length, 40);
  assert.ok(near[0].estSavings < p.totalTokens, `${near[0].estSavings} < ${p.totalTokens}`);
  assert.ok(p.totalEstSavings <= p.totalTokens * 0.9);
  assert.match(near[0].message, /^40 messages are ~\d+% similar/);
  const out = renderProfile(p);
  assert.match(out, /Findings \(2\)/);
});

test("two unrelated groups of similar messages are two findings; a pair keeps the pair wording", () => {
  const other = "Quarterly revenue grew in every region while churn fell and hiring stayed flat across engineering and sales teams this year. ".repeat(12);
  const messages = [
    { role: "user", content: `A1 ${base}` },
    { role: "assistant", content: `A2 ${base}` },
    { role: "user", content: `A3 ${base}` },
    { role: "assistant", content: `B1 ${other}` },
    { role: "user", content: `B2 ${other}` },
  ];
  const p = profileConversation(parseConversation(JSON.stringify({ messages })), "claude-sonnet-5");
  const near = p.findings.filter((f) => f.id === "near_duplicate");
  assert.equal(near.length, 2);
  const pair = near.find((f) => f.messages.length === 2)!;
  assert.deepEqual(pair.messages, [3, 4]);
  assert.match(pair.message, /^Messages #3 and #4 are ~\d+% similar/);
});

test("the report's 'more of the same kind' never claims more than the total recovery", () => {
  // Many exact duplicates of a big paste: per-finding savings sum far past the context.
  const doc = "row | value | note\n".repeat(400);
  const messages = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: doc }));
  const p = profileConversation(parseConversation(JSON.stringify({ messages })), "claude-sonnet-5");
  const out = renderProfile(p);
  const m = /up to ~([\d.]+k?) more recoverable/.exec(out);
  assert.ok(m, out);
  const n = m[1].endsWith("k") ? parseFloat(m[1]) * 1000 : Number(m[1]);
  assert.ok(n <= p.totalEstSavings * 1.05, `${n} <= ${p.totalEstSavings}`);
});
