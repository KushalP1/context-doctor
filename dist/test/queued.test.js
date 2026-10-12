/**
 * What the transcript records outside user/assistant rows but the model sees:
 * prompts typed while the agent worked (queued_command attachments) and the
 * messages a compaction keeps verbatim (compactMetadata.preservedMessages).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionFile } from "../session.js";
import { compactionQuality } from "../compactquality.js";
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
function write(rows) {
    const p = join(mkdtempSync(join(tmpdir(), "cd-queued-")), "s.jsonl");
    writeFileSync(p, jsonl(rows));
    return p;
}
const usage = { input_tokens: 10, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 100, output_tokens: 5 };
/** Shapes as Claude Code 2.1 writes them. */
const queued = (uuid, prompt, origin, commandMode = "prompt") => ({
    type: "attachment",
    uuid,
    isSidechain: false,
    attachment: { type: "queued_command", prompt, commandMode, ...(origin ? { origin } : {}) },
});
test("a prompt typed while the agent worked is a user turn; task notifications and subagent hand-backs are not", () => {
    const p = write([
        { type: "user", uuid: "u1", message: { role: "user", content: "migrate the users table" } },
        { type: "assistant", uuid: "a1", message: { id: "m1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "psql" } }], usage } },
        queued("q1", "no, use the staging database instead", { kind: "human" }),
        queued("q2", "<task-notification>build finished</task-notification>", { kind: "task-notification" }, "task-notification"),
        queued("q3", "[Subagent hand-back] report text", { kind: "peer", from: "abc" }),
        queued("q4", "and keep a backup", undefined),
        { type: "user", uuid: "u2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
        { type: "assistant", uuid: "a2", message: { id: "m2", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "switching" }], usage } },
    ]);
    const json = parseSessionFile(p).conversationJson;
    assert.match(json, /use the staging database instead/);
    assert.match(json, /and keep a backup/, "older lines carry no origin; their prompts were human");
    assert.doesNotMatch(json, /build finished/);
    assert.doesNotMatch(json, /Subagent hand-back/);
});
test("compactions: a correction typed while the agent worked counts", () => {
    const rows = [];
    let n = 0;
    const req = (path) => {
        const id = `m${n++}`;
        rows.push({ type: "assistant", uuid: `${id}-a`, message: { id, usage: { input_tokens: 1 }, content: [{ type: "tool_use", id: `${id}-t`, name: "Read", input: { file_path: path } }] } });
        rows.push({ type: "user", uuid: `${id}-u`, message: { content: [{ type: "tool_result", tool_use_id: `${id}-t`, content: "x".repeat(400) }] } });
    };
    for (let i = 0; i < 10; i++)
        req(`/w/f${i}.ts`);
    rows.push({ type: "system", subtype: "compact_boundary", uuid: "cb" });
    for (let i = 0; i < 3; i++)
        req(`/w/g${i}.ts`);
    rows.push(queued("q", "no, that's wrong", { kind: "human" }));
    for (let i = 3; i < 10; i++)
        req(`/w/g${i}.ts`);
    const q = compactionQuality(30, [write(rows)]);
    assert.equal(q.compactions, 1);
    assert.equal(q.after.userMsgs, 1);
    assert.equal(q.after.corrections, 1);
});
test("messages a compaction keeps verbatim stay in the live context", () => {
    const p = write([
        { type: "user", uuid: "u1", message: { role: "user", content: "first question" } },
        { type: "assistant", uuid: "a1", message: { id: "m1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "old answer" }], usage } },
        { type: "user", uuid: "k1", message: { role: "user", content: "KEPT question" } },
        { type: "assistant", uuid: "k2", message: { id: "m2", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "KEPT answer" }], usage } },
        { type: "system", subtype: "compact_boundary", uuid: "cb", compactMetadata: { trigger: "auto", preservedMessages: { anchorUuid: "sum", uuids: ["k1", "k2"], allUuids: ["k1", "gone", "k2"] } } },
        { type: "user", uuid: "sum", isCompactSummary: true, message: { role: "user", content: "Summary: the user asked questions." } },
        { type: "user", uuid: "u3", message: { role: "user", content: "after question" } },
        { type: "assistant", uuid: "a3", message: { id: "m3", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "after answer" }], usage } },
    ]);
    const parsed = parseSessionFile(p);
    const live = JSON.parse(parsed.conversationJson).messages;
    const text = (m) => JSON.stringify(m.content);
    assert.deepEqual(live.map((m) => [m.role, text(m).includes("Summary") ? "summary" : text(m).includes("KEPT q") ? "kept q" : text(m).includes("KEPT a") ? "kept a" : text(m).includes("after q") ? "after q" : text(m).includes("after a") ? "after a" : "?"]), [["user", "summary"], ["user", "kept q"], ["assistant", "kept a"], ["user", "after q"], ["assistant", "after a"]]);
    assert.doesNotMatch(parsed.conversationJson, /old answer|first question/);
    assert.equal(parsed.messageCount, 5);
    assert.equal(parsed.compactedAway, 2, "only the first question and its answer were compacted away");
    // The request after the compaction is positioned on the live array, after the kept messages.
    assert.deepEqual(parsed.usageSamples?.map((u) => u.index), [4]);
});
