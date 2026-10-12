/**
 * The optimizer edits one block at a time.
 *
 * Until 0.31 a strategy rewrote a whole message as one string and put it back
 * into the first block: a message holding two parallel tool results and a
 * note from the user came out with both outputs under the first call's id,
 * "[removed]" under the second and the note gone. That ran by default in the
 * optimizing proxy, on live requests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { optimizeConversation } from "../optimize.js";
const big = (tag, n = 8000) => `${tag} `.repeat(Math.ceil(n / (tag.length + 1))).slice(0, n);
/** A history long enough that message 1 sits before the trim boundary. */
function padded(messages) {
    const tail = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i}` }));
    return [...messages, ...tail];
}
test("trim-tool-results trims each parallel result on its own and keeps the user's note", () => {
    const messages = padded([
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "a" } }, { type: "tool_use", id: "t2", name: "Bash", input: { command: "b" } }] },
        {
            role: "user",
            content: [
                { type: "tool_result", tool_use_id: "t1", content: big("alpha") },
                { type: "tool_result", tool_use_id: "t2", content: "short beta output" },
                { type: "text", text: "IMPORTANT USER NOTE: deploy to staging only" },
            ],
        },
    ]);
    const r = optimizeConversation(JSON.stringify({ messages }), { strategies: ["trim-tool-results"] });
    const out = r.conversation.messages[1].content;
    assert.equal(out.length, 3, "same blocks in, same blocks out");
    assert.equal(out[0].tool_use_id, "t1");
    assert.match(out[0].content, /^alpha alpha/);
    assert.match(out[0].content, /trimmed \d+ chars/);
    assert.doesNotMatch(out[0].content, /beta/, "the other call's output never moves under this id");
    assert.equal(out[1].tool_use_id, "t2");
    assert.equal(out[1].content, "short beta output");
    assert.deepEqual(out[2], { type: "text", text: "IMPORTANT USER NOTE: deploy to staging only" });
    assert.ok(r.tokensAfter < r.tokensBefore);
});
test("a tool result's images stay when its text is trimmed", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
    const messages = padded([
        { role: "assistant", content: [{ type: "tool_use", id: "s1", name: "screenshot", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "s1", content: [{ type: "text", text: big("page") }, image] }] },
    ]);
    const r = optimizeConversation(JSON.stringify({ messages }), { strategies: ["trim-tool-results"] });
    const parts = r.conversation.messages[1].content[0].content;
    assert.equal(parts.length, 2);
    assert.match(parts[0].text, /trimmed/);
    assert.deepEqual(parts[1], image);
});
test("strip-base64 cleans a tool call's input in place and never moves it into a text block", () => {
    // Bytes that look like an encoded image (the detector ignores one-letter runs).
    const blob = Buffer.from(Array.from({ length: 6000 }, (_, i) => (i * 7919 + 13) % 256)).toString("base64");
    const messages = [
        { role: "user", content: "upload it" },
        { role: "assistant", content: [{ type: "text", text: "Uploading now." }, { type: "tool_use", id: "u1", name: "upload", input: { name: "x.png", data: blob } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: "ok" }] },
    ];
    const r = optimizeConversation(JSON.stringify({ messages }), { strategies: ["strip-base64"] });
    const out = r.conversation.messages[1].content;
    assert.deepEqual(out[0], { type: "text", text: "Uploading now." });
    assert.equal(out[1].input.name, "x.png");
    assert.ok(!out[1].input.data.includes(blob.slice(0, 200)), "the blob is gone from the input");
    assert.ok(r.tokensAfter < r.tokensBefore, "the reported saving is real");
    assert.equal(r.applied.length, 1);
});
test("dedupe never claims a saving that grows the conversation", () => {
    const file = big("const x = 1;", 2000);
    const write = (id) => ({ role: "assistant", content: [{ type: "tool_use", id, name: "Write", input: { file_path: "/a.ts", content: file } }] });
    const done = (id) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "written" }] });
    const messages = padded([{ role: "user", content: "go" }, write("w1"), done("w1"), write("w2"), done("w2")]);
    const r = optimizeConversation(JSON.stringify({ messages }), { strategies: ["dedupe"] });
    assert.ok(r.tokensAfter <= r.tokensBefore);
    const second = r.conversation.messages[3].content;
    assert.equal(second.length, 1, "no text block added to a tool call");
    assert.equal(second[0].type, "tool_use");
});
test("dedupe treats indentation as content", () => {
    const before = "def f(x):\n    if x:\n        return 1\n    return 0\n".repeat(10);
    const after = "def f(x):\n    if x:\n        return 1\n        return 0\n".repeat(10);
    const messages = padded([{ role: "user", content: before }, { role: "assistant", content: "fixed" }, { role: "user", content: after }]);
    const r = optimizeConversation(JSON.stringify({ messages }), { strategies: ["dedupe"] });
    assert.equal(r.applied.length, 0);
    assert.equal(r.conversation.messages[2].content, after);
});
test("dedupe replaces only the repeated block, by message index", () => {
    const doc = big("manual", 2000);
    const messages = padded([
        { role: "user", content: doc },
        { role: "assistant", content: "read it" },
        { role: "user", content: [{ type: "text", text: doc }, { type: "text", text: "what changed?" }] },
    ]);
    const r = optimizeConversation(JSON.stringify({ messages }), { strategies: ["dedupe"] });
    const out = r.conversation.messages[2].content;
    assert.match(out[0].text, /identical to message #0/);
    assert.equal(out[1].text, "what changed?");
});
test("trim-tool-calls keeps OpenAI arguments valid JSON", () => {
    const messages = padded([
        { role: "user", content: "write the file" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: big("line", 4000) }) } }] },
        { role: "tool", tool_call_id: "c1", content: "ok" },
    ]);
    const r = optimizeConversation(JSON.stringify({ messages }), { strategies: ["trim-tool-calls"] });
    const args = r.conversation.messages[1].tool_calls[0].function.arguments;
    const parsed = JSON.parse(args);
    assert.equal(parsed.path, "a.txt");
    assert.match(parsed.content, /more chars trimmed/);
    assert.equal(r.applied.length, 1);
});
test("trim-tool-results trims an OpenAI tool message", () => {
    const messages = padded([
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "ls", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: big("file", 6000) },
    ]);
    const r = optimizeConversation(JSON.stringify({ messages }), { strategies: ["trim-tool-results"] });
    assert.match(r.conversation.messages[1].content, /trimmed \d+ chars/);
});
test("prune-history keeps an OpenAI system prompt", () => {
    const messages = [
        { role: "system", content: "Never issue refunds over $50." },
        ...Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i} ${big("x", 200)}` })),
    ];
    const r = optimizeConversation(JSON.stringify({ messages }), { strategies: ["prune-history"] });
    const out = r.conversation.messages;
    assert.deepEqual(out[0], { role: "system", content: "Never issue refunds over $50." });
    assert.match(out[1].content, /earlier messages .* pruned/);
    assert.equal(r.applied[0].messageIndex, 1);
});
test("a JSON null is an input error, not a crash", () => {
    assert.throws(() => optimizeConversation("null"), /No `messages` array/);
});
