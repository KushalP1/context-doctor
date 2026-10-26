/**
 * Cleared ids and sizes belong to one conversation. OpenAI-compatible
 * clients number tool calls call_0, call_1… in every conversation; with a
 * global map, conversation B (new, warm) had A's clearings applied to its
 * own results on its first request and A's sizes reported for them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoClearer } from "../autoclear.js";
const CLEARED = /^\[context-doctor: old tool output cleared/;
const big = (tag, lines = 1500) => `${tag}\n` + "const value = compute(input, options); // step\n".repeat(lines);
/** An OpenAI chat conversation with `n` shell rounds, ids call_0… */
function chat(first, n, tag) {
    const messages = [{ role: "system", content: "You are an agent." }, { role: "user", content: first }];
    for (let i = 0; i < n; i++) {
        messages.push({ role: "assistant", content: null, tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "shell", arguments: `{"cmd":"cat ${tag}${i}"}` } }] });
        messages.push({ role: "tool", tool_call_id: `call_${i}`, content: big(`${tag}${i}`) });
    }
    messages.push({ role: "assistant", content: "ok" });
    return { model: "gpt-5", messages };
}
test("a new warm conversation reusing call ids gets none of another conversation's clearings", () => {
    const c = new AutoClearer({ unseenIsWarm: true });
    const HOUR = 3_600_000;
    // A: seen, then cold a day later (an OpenAI cache can live 24 hours), so its old results are cleared.
    c.apply(chat("conversation A", 1, "a"), 0);
    const a = chat("conversation A", 8, "a");
    const ra = c.apply(a, 25 * HOUR + 1);
    assert.ok(ra.newlyCleared > 0, ra.reason);
    assert.ok(ra.newIds.includes("call_0"));
    // B: brand new (unseen = warm), same call ids, different content.
    const b = chat("conversation B", 8, "b");
    const rb = c.apply(b, 25 * HOUR + 2_000);
    assert.equal(rb.changed, false, rb.reason);
    assert.equal(rb.tokensRemoved, 0);
    assert.ok(b.messages.filter((m) => m.role === "tool").every((m) => !CLEARED.test(m.content)));
    assert.notEqual(ra.conversation, rb.conversation);
});
test("state persists per conversation; an old global-format state file is ignored safely", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-autoclear-scope-"));
    const statePath = join(dir, "state.json");
    const HOUR = 3_600_000;
    const c = new AutoClearer({ statePath });
    c.apply(chat("conversation A", 1, "a"), 0);
    const r = c.apply(chat("conversation A", 8, "a"), 25 * HOUR);
    assert.ok(r.newlyCleared > 0);
    c.flush();
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    assert.ok(Array.isArray(saved.clearedByConversation) && saved.clearedByConversation[0].length === 3);
    assert.equal(saved.cleared, undefined);
    // Restarted: A's clearings still apply to A (warm, 10 s later), not to B.
    const again = new AutoClearer({ statePath, unseenIsWarm: true });
    const a2 = chat("conversation A", 9, "a");
    const ra = again.apply(a2, 25 * HOUR + 10_000);
    assert.ok(ra.changed && ra.appliedIds.includes("call_0"), ra.reason);
    const b = chat("conversation B", 9, "b");
    assert.equal(again.apply(b, 25 * HOUR + 11_000).changed, false);
    // forget() with a conversation drops that conversation's clearing only.
    again.forget(["call_0"], ra.conversation);
    const a3 = chat("conversation A", 9, "a");
    const r3 = again.apply(a3, 25 * HOUR + 12_000);
    assert.ok(!r3.appliedIds.includes("call_0"));
    // 0.34's format: global ids. Loaded without error; nothing is applied from it.
    const old = join(dir, "old.json");
    writeFileSync(old, JSON.stringify({ cleared: [["call_0", 9000], ["call_1", 9000]], convs: [["k", 1, 2]], rejectsEdits: ["acct"] }));
    const legacy = new AutoClearer({ statePath: old, unseenIsWarm: true });
    assert.equal(legacy.rejectsEdits("acct"), true, "the rest of the file still loads");
    const fresh = chat("conversation C", 9, "c");
    assert.equal(legacy.apply(fresh, 5_000).changed, false);
    writeFileSync(old, JSON.stringify({ clearedByConversation: [null, ["x"], [1, 2, 3]], convs: "nope" }));
    assert.doesNotThrow(() => new AutoClearer({ statePath: old }));
});
