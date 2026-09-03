/**
 * Optimization must not destroy the prompt cache it is trying to save money on.
 *
 * Caches match a byte-identical prefix, so editing any message in the middle
 * invalidates everything after it. A trim boundary of `length - keepRecent`
 * moves by one every turn, rewriting the message that just aged out — which
 * costs the 1.25x cache-write price on the whole prefix, every turn, to save a
 * few hundred tokens. On this fixture that was 22 of 24 turns.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { optimizeConversation, StrategyId } from "../optimize.js";

/** Grow a tool-heavy conversation one turn at a time, as a live agent would. */
function invalidationsOver(strategies: StrategyId[], turnCount = 25): number {
  const conversation: unknown[] = [];
  let previous: string[] | null = null;
  let invalidations = 0;

  for (let i = 0; i < turnCount; i++) {
    conversation.push(
      { role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Read", input: { file_path: `/app/f${i}.ts` } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `line of file ${i} `.repeat(200) }] }
    );
    const result = optimizeConversation(
      JSON.stringify({ model: "claude-sonnet-5", messages: JSON.parse(JSON.stringify(conversation)) }),
      { strategies }
    );
    const current = (result.conversation as { messages: unknown[] }).messages.map((m) => JSON.stringify(m));
    if (previous) {
      // The cache survives only if every message already sent comes back identical.
      if (previous.some((m, k) => m !== current[k])) invalidations++;
    }
    previous = current;
  }
  return invalidations;
}

test("content-only strategies never disturb the cached prefix", () => {
  assert.equal(invalidationsOver(["dedupe"]), 0, "dedupe depends on content, not position");
  assert.equal(invalidationsOver(["strip-base64"]), 0, "strip-base64 depends on content, not position");
});

test("the trim boundary holds still long enough for the cache to pay off", () => {
  // Measured on this fixture: the per-turn boundary invalidated 22 of 24 turns.
  // Quantizing brings it to 8 — the early turns, before there is enough history
  // to quantize against, still move the boundary each time. The assertion is
  // set at the observed value plus headroom, not at an aspiration.
  const withTrimming = invalidationsOver(["dedupe", "trim-tool-results", "strip-base64"]);
  assert.ok(withTrimming <= 10, `cache should survive most turns, got ${withTrimming}/24 invalidated`);
  assert.ok(withTrimming < 22, "must beat the per-turn boundary this replaced");
});

test("trimming still actually saves tokens", () => {
  // Cache stability must not have been bought by quietly doing nothing.
  const conversation = Array.from({ length: 40 }, (_, i) =>
    i % 2
      ? { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `payload ${i} `.repeat(300) }] }
      : { role: "assistant", content: [{ type: "tool_use", id: `t${i + 1}`, name: "Read", input: { file_path: `/f${i}.ts` } }] }
  );
  const result = optimizeConversation(JSON.stringify({ messages: conversation }), {
    strategies: ["trim-tool-results"],
  });
  // 20 tool results; the quantized boundary must still reach the large majority.
  assert.ok(result.applied.length >= 12, `expected most results trimmed, got ${result.applied.length}`);
  assert.ok(result.tokensAfter < result.tokensBefore * 0.6, "and the context must actually shrink");
});
