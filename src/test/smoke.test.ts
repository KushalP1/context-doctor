/** Smoke tests: parse → profile → optimize roundtrip for both provider formats. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConversation } from "../parse.js";
import { profileConversation } from "../profile.js";
import { optimizeConversation } from "../optimize.js";

// Large enough to clear the profiler's 2000-token oversized-tool-result threshold.
const bigText = "Sunny, 18C. ".repeat(900);

const openaiConv = JSON.stringify({
  messages: [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "weather in SF?" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }] },
    { role: "tool", tool_call_id: "c1", content: bigText },
    { role: "assistant", content: "It is sunny and 18C in SF." },
  ],
});

const anthropicConv = JSON.stringify({
  system: "You are helpful.",
  messages: [
    { role: "user", content: "weather in SF?" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "SF" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: bigText }] },
    { role: "assistant", content: "Sunny and 18C." },
  ],
});

test("parses OpenAI format and classifies tool plumbing", () => {
  const conv = parseConversation(openaiConv);
  assert.equal(conv.sourceFormat, "openai");
  assert.equal(conv.messages.filter((m) => m.kind === "tool_result").length, 1);
  assert.equal(conv.messages.filter((m) => m.kind === "tool_call").length, 1);
});

test("parses Anthropic format including external system prompt", () => {
  const conv = parseConversation(anthropicConv);
  assert.equal(conv.sourceFormat, "anthropic");
  assert.equal(conv.messages[0].kind, "system");
  assert.ok(conv.messages.some((m) => m.toolName === "get_weather"));
});

test("profiler flags oversized tool results", () => {
  const profile = profileConversation(parseConversation(openaiConv), "gpt-4o");
  assert.ok(profile.totalTokens > 500);
  assert.equal(profile.contextWindow, 128_000);
  assert.ok(profile.findings.some((f) => f.id === "large_tool_result"));
});

test("optimizer trims stale tool results and reports savings", () => {
  const result = optimizeConversation(openaiConv, { keepRecent: 1, maxToolResultTokens: 50 });
  assert.ok(result.tokensAfter < result.tokensBefore);
  assert.ok(result.applied.some((c) => c.strategy === "trim-tool-results"));
  // Output must remain valid JSON with the same message count.
  const out = result.conversation as { messages: unknown[] };
  assert.equal(out.messages.length, 5);
});

test("optimizer output for Anthropic format keeps block structure valid", () => {
  const result = optimizeConversation(anthropicConv, { keepRecent: 1, maxToolResultTokens: 50 });
  const out = result.conversation as { messages: Array<{ content: unknown }> };
  for (const m of out.messages) {
    assert.ok(typeof m.content === "string" || Array.isArray(m.content));
  }
});

test("raw text input still profiles", () => {
  const profile = profileConversation(parseConversation("just some prompt text"));
  assert.equal(profile.messageCount, 1);
  assert.ok(profile.totalTokens > 0);
});
