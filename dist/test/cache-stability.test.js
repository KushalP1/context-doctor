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
import { optimizeConversation } from "../optimize.js";
/** Grow a tool-heavy conversation one turn at a time, as a live agent would. */
function invalidationsOver(strategies, turnCount = 25) {
    const conversation = [];
    let previous = null;
    let invalidations = 0;
    for (let i = 0; i < turnCount; i++) {
        conversation.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Read", input: { file_path: `/app/f${i}.ts` } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `line of file ${i} `.repeat(200) }] });
        const result = optimizeConversation(JSON.stringify({ model: "claude-sonnet-5", messages: JSON.parse(JSON.stringify(conversation)) }), { strategies });
        const current = result.conversation.messages.map((m) => JSON.stringify(m));
        if (previous) {
            // The cache survives only if every message already sent comes back identical.
            if (previous.some((m, k) => m !== current[k]))
                invalidations++;
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
    const conversation = Array.from({ length: 40 }, (_, i) => i % 2
        ? { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `payload ${i} `.repeat(300) }] }
        : { role: "assistant", content: [{ type: "tool_use", id: `t${i + 1}`, name: "Read", input: { file_path: `/f${i}.ts` } }] });
    const result = optimizeConversation(JSON.stringify({ messages: conversation }), {
        strategies: ["trim-tool-results"],
    });
    // 20 tool results; the quantized boundary must still reach the large majority.
    assert.ok(result.applied.length >= 12, `expected most results trimmed, got ${result.applied.length}`);
    assert.ok(result.tokensAfter < result.tokensBefore * 0.6, "and the context must actually shrink");
});
test("dedupe never replaces the turn the model is answering", () => {
    const doc = "Here is the contract text that matters. ".repeat(30);
    const messages = [
        { role: "user", content: doc },
        ...Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i}` })),
        { role: "user", content: doc }, // the question being asked right now
    ];
    const result = optimizeConversation(JSON.stringify({ model: "claude-sonnet-5", messages }), {
        strategies: ["dedupe"],
    });
    const last = result.conversation.messages.at(-1);
    assert.ok(!String(last?.content).includes("context-doctor"), "the live turn must reach the model intact, not as a pointer to an older copy");
});
test("dedupe still removes duplicates once they are history", () => {
    const doc = "Here is the contract text that matters. ".repeat(30);
    const messages = [
        { role: "user", content: doc },
        { role: "assistant", content: "ok" },
        { role: "user", content: doc }, // a genuine older duplicate
        ...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i}` })),
    ];
    const result = optimizeConversation(JSON.stringify({ messages }), { strategies: ["dedupe"] });
    assert.equal(result.applied.length, 1, "protecting the tail must not disable dedupe entirely");
    assert.ok(result.tokensAfter < result.tokensBefore, "and it must still save tokens");
});
test("optimization never makes a message bigger than it was", () => {
    // A tool result only just over the budget: the truncation notice can weigh
    // more than the text it replaces. Measured on a real session as 2,941 -> 2,947.
    const justOver = "x".repeat(301 * 4);
    const messages = [
        ...Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i}` })),
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: justOver }] },
        ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `later ${i}` })),
    ];
    const result = optimizeConversation(JSON.stringify({ messages }), {
        strategies: ["trim-tool-results", "trim-tool-calls"],
        maxToolResultTokens: 300,
    });
    assert.ok(result.tokensAfter <= result.tokensBefore, `optimizing grew the context: ${result.tokensBefore} -> ${result.tokensAfter}`);
});
test("prune-history never leaves a tool result without its call", () => {
    // The kept tail can contain a tool_result whose tool_use sits in the pruned
    // half — not only at the boundary. Both APIs reject that conversation.
    const messages = [];
    for (let i = 0; i < 40; i++) {
        messages.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Read", input: { file_path: `/f${i}` } }] });
        messages.push({ role: "assistant", content: "some prose between the call and its result" });
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `result ${i} ${"y".repeat(200)}` }] });
    }
    const result = optimizeConversation(JSON.stringify({ messages }), { strategies: ["prune-history"] });
    const kept = result.conversation.messages;
    const calls = new Set();
    for (const m of kept) {
        if (!Array.isArray(m.content))
            continue;
        for (const b of m.content)
            if (b?.type === "tool_use" && b.id)
                calls.add(b.id);
    }
    for (const m of kept) {
        if (!Array.isArray(m.content))
            continue;
        for (const b of m.content) {
            if (b?.type === "tool_result") {
                assert.ok(b.tool_use_id && calls.has(b.tool_use_id), `orphaned tool_result ${b.tool_use_id} survived pruning`);
            }
        }
        assert.ok(!Array.isArray(m.content) || m.content.length > 0, "no message may be left with empty content");
    }
});
test("a larger trim step trades stale content for fewer cache invalidations", () => {
    // The measured trade-off this option exists for, pinned so the default and
    // the knob keep meaning what the docs say.
    const invalidationsWithStep = (step, turns) => {
        const conversation = [];
        let previous = null;
        let invalidations = 0;
        for (let i = 0; i < turns; i++) {
            conversation.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Read", input: { file_path: `/f${i}` } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `line ${i} `.repeat(200) }] });
            const result = optimizeConversation(JSON.stringify({ messages: JSON.parse(JSON.stringify(conversation)) }), {
                strategies: ["trim-tool-results"],
                trimBoundaryStep: step,
            });
            const current = result.conversation.messages.map((m) => JSON.stringify(m));
            if (previous && previous.some((m, k) => m !== current[k]))
                invalidations++;
            previous = current;
        }
        return invalidations;
    };
    const ten = invalidationsWithStep(10, 120);
    const twenty = invalidationsWithStep(20, 120);
    assert.ok(twenty < ten, `step 20 must invalidate less often than step 10 (got ${twenty} vs ${ten})`);
    // An invalid step falls back to the default rather than disabling trimming.
    const fallback = optimizeConversation(JSON.stringify({ messages: Array.from({ length: 40 }, (_, i) => i % 2
            ? { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `p ${i} `.repeat(300) }] }
            : { role: "assistant", content: [{ type: "tool_use", id: `t${i + 1}`, name: "Read", input: { file_path: "/x" } }] }) }), { strategies: ["trim-tool-results"], trimBoundaryStep: -5 });
    assert.ok(fallback.applied.length > 0, "a nonsense step must not silently turn trimming off");
});
test("trim-tool-calls leaves a Write alone when the model later Edits that file blind", () => {
    const big = "line of code\n".repeat(1500);
    const filler = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i}` }));
    const base = [
        { role: "assistant", content: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: "/app/a.ts", content: big } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "w1", content: "ok" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "w2", name: "Write", input: { file_path: "/app/b.ts", content: big } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "w2", content: "ok" }] },
        ...filler,
    ];
    // a.ts is Edited later with no Read in between: the model is relying on its
    // own Write input. b.ts is never touched again.
    const withBlindEdit = [
        ...base,
        { role: "assistant", content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/app/a.ts", old_string: "line of code", new_string: "changed" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "e1", content: "ok" }] },
        ...filler,
    ];
    const r = optimizeConversation(JSON.stringify({ messages: withBlindEdit }), { strategies: ["trim-tool-calls"] });
    const out = r.conversation.messages;
    assert.equal(out[0].content[0].input.content.length, big.length, "the Write the Edit depends on is kept intact");
    assert.ok(out[2].content[0].input.content.length < big.length, "the Write nobody touches again is trimmed");
    // Same shape, but the model Reads a.ts before editing: now it is safe to trim.
    const withRead = [
        ...base,
        { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "/app/a.ts" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: big }] },
        { role: "assistant", content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/app/a.ts", old_string: "line of code", new_string: "changed" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "e1", content: "ok" }] },
        ...filler,
    ];
    const r2 = optimizeConversation(JSON.stringify({ messages: withRead }), { strategies: ["trim-tool-calls"] });
    assert.ok(r2.conversation.messages[0].content[0].input.content.length < big.length, "a Write that was re-read before editing is trimmed");
});
