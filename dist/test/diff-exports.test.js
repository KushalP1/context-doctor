/**
 * `diff` reads every input `session` reads. ChatGPT's conversations.json (and
 * Gemini chats) are .json, not .jsonl; read as a plain conversation they were
 * one message of raw text, so a 10-message export diffed as "5 → 5 tokens".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDiff } from "../diff.js";
function chatGptExport(messages) {
    const mapping = Object.fromEntries(Array.from({ length: messages }, (_, i) => [
        `m${i}`,
        { id: `m${i}`, message: { author: { role: i % 2 ? "assistant" : "user" }, content: { content_type: "text", parts: ["word ".repeat(300) + i] }, create_time: i } },
    ]));
    return JSON.stringify([{ title: "Export", update_time: 1, default_model_slug: "gpt-5", mapping }]);
}
test("diff profiles ChatGPT exports as conversations, not as one blob of JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxdoc-diffexport-"));
    writeFileSync(join(dir, "before.json"), chatGptExport(10));
    writeFileSync(join(dir, "after.json"), chatGptExport(4));
    const out = renderDiff(join(dir, "before.json"), join(dir, "after.json"));
    assert.match(out, /Messages: 10 → 4/);
    assert.match(out, /Net improvement/, "six fewer 300-word messages is a reduction");
});
test("plain conversation JSON still diffs as before", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxdoc-diffplain-"));
    const conv = (n) => JSON.stringify({ messages: Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i} `.repeat(50) })) }, null, 2);
    writeFileSync(join(dir, "a.json"), conv(6));
    writeFileSync(join(dir, "b.json"), conv(2));
    assert.match(renderDiff(join(dir, "a.json"), join(dir, "b.json")), /Messages: 6 → 2/);
});
