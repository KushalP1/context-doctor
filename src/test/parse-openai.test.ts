/** parse: OpenAI media blocks are attachments, JSON scalars are raw prompts, "developer" is the system prompt. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConversation } from "../parse.js";
import { profileConversation } from "../profile.js";

const b64 = "iVBORw0KGgo" + "A".repeat(300_000);

test("an OpenAI image data URL counts as an image, not ~100k tokens of base64", () => {
  const conv = {
    model: "gpt-4o",
    messages: [{ role: "user", content: [{ type: "text", text: "What is in this picture?" }, { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } }] }],
  };
  const parsed = parseConversation(JSON.stringify(conv));
  assert.equal(parsed.messages[0].hasBinary, true);
  assert.ok(!parsed.messages[0].text.includes("AAAA"));
  const p = profileConversation(parsed, "gpt-4o");
  assert.ok(p.totalTokens < 100, `${p.totalTokens} tokens`);
  assert.ok(!p.findings.some((f) => f.id === "base64_blob" || f.id === "near_window_limit"));
});

test("Responses and Chat Completions media blocks (input_image, input_audio, file, input_file) are attachments too", () => {
  const blocks = [
    { type: "input_image", image_url: `data:image/png;base64,${b64}` },
    { type: "input_audio", input_audio: { data: b64, format: "wav" } },
    { type: "file", file: { filename: "a.pdf", file_data: `data:application/pdf;base64,${b64}` } },
    { type: "input_file", filename: "a.pdf", file_data: `data:application/pdf;base64,${b64}` },
  ];
  for (const block of blocks) {
    const m = parseConversation(JSON.stringify({ messages: [{ role: "user", content: [block] }] })).messages[0];
    assert.equal(m.hasBinary, true, block.type);
    assert.ok(m.text.length < 20, `${block.type}: ${m.text.length} chars`);
  }
});

test("a raw prompt that happens to be valid JSON is still a raw prompt, and null does not throw", () => {
  for (const input of ["null", "2024", '"Summarize this text please"', "true"]) {
    const c = parseConversation(input);
    assert.equal(c.sourceFormat, "text", input);
    assert.equal(c.parseWarning, undefined, input);
    assert.deepEqual(c.messages.map((m) => [m.kind, m.text]), [["user", input]]);
  }
});

test("OpenAI's developer role is the system prompt", () => {
  const c = parseConversation(JSON.stringify({ messages: [{ role: "developer", content: "Be terse." }, { role: "user", content: "hi" }] }));
  assert.equal(c.messages[0].kind, "system");
  assert.equal(c.messages[0].role, "developer");
});
