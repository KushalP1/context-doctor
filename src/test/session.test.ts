/**
 * Transcript parsing is streamed, not slurped. These tests pin the two things
 * that streaming can get wrong and a whole-file read cannot: chunk boundaries
 * landing mid-line and mid-UTF-8-sequence.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionFile } from "../session.js";

/** One transcript line in Claude Code's JSONL shape. */
function line(role: "user" | "assistant", text: string): string {
  return JSON.stringify({ type: role, message: { role, content: text, model: "claude-sonnet-5" } });
}

test("a transcript larger than the read chunk is parsed completely", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxdoc-session-"));
  const path = join(dir, "big.jsonl");
  // Chunks are 4MB; ~12MB of transcript crosses several boundaries, with
  // individual lines long enough to straddle one.
  const filler = "x".repeat(200_000);
  const lines: string[] = [];
  for (let i = 0; i < 60; i++) lines.push(line(i % 2 ? "assistant" : "user", `msg ${i} ${filler}`));
  writeFileSync(path, lines.join("\n") + "\n");

  const parsed = parseSessionFile(path);
  assert.equal(parsed.messageCount, 60, "no message may be lost at a chunk boundary");
  const conv = JSON.parse(parsed.conversationJson) as { messages: Array<{ content: string }> };
  assert.ok(conv.messages[0].content.startsWith("msg 0 "), "first message survives");
  assert.ok(conv.messages[59].content.startsWith("msg 59 "), "last message survives");
});

test("multi-byte characters split across chunks are not corrupted", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxdoc-utf8-"));
  const path = join(dir, "utf8.jsonl");
  // Pad so that the emoji lands near the 4MB mark, then assert it round-trips.
  const pad = "a".repeat(4 * 1024 * 1024 - 40);
  writeFileSync(path, line("user", pad) + "\n" + line("assistant", "héllo 🐢 wörld") + "\n");

  const conv = JSON.parse(parseSessionFile(path).conversationJson) as { messages: Array<{ content: string }> };
  assert.equal(conv.messages.at(-1)?.content, "héllo 🐢 wörld");
});

test("input that is not a conversation is flagged, not silently mis-profiled", async () => {
  const { parseConversation } = await import("../parse.js");

  assert.match(parseConversation("").parseWarning ?? "", /empty/i);
  assert.equal(parseConversation("").messages.length, 0, "empty input has no messages");
  assert.match(parseConversation('{"messages": [').parseWarning ?? "", /does not parse/i);
  assert.match(parseConversation('{"foo":1}').parseWarning ?? "", /no `messages` array/i);
  assert.match(parseConversation("[1,2,3]").parseWarning ?? "", /no element has a `role`/i);

  // The things that ARE conversations stay clean.
  assert.equal(parseConversation('{"messages":[{"role":"user","content":"hi"}]}').parseWarning, undefined);
  assert.equal(parseConversation('[{"role":"user","content":"hi"}]').parseWarning, undefined);
  assert.equal(parseConversation("just a raw prompt").parseWarning, undefined, "raw text is a supported input");
});

test("base64 detection does not fire on repetitive or hex-like text", async () => {
  const { hasBase64Blob, stripBase64Blobs } = await import("../blob.js");

  // The false positives that made `strip-base64` delete real content.
  assert.equal(hasBase64Blob("a".repeat(5000)), false, "a repeated character is not base64");
  assert.equal(hasBase64Blob("deadbeef".repeat(400)), false, "a long hex digest is not base64");
  assert.equal(hasBase64Blob("ab".repeat(3000)), false, "two alternating characters are not base64");

  // Genuine payloads still caught, and stripping leaves lookalikes alone.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let real = "";
  for (let i = 0; i < 1200; i++) real += alphabet[(i * 37 + (i % 7)) % 64];
  assert.equal(hasBase64Blob(real), true, "a real base64 payload is still detected");
  assert.equal(hasBase64Blob("data:image/png;base64," + "A".repeat(600)), true, "an explicit data: URI is definitive");

  assert.equal(stripBase64Blobs("x".repeat(5000)).length, 5000, "lookalike content is left untouched");
  assert.ok(stripBase64Blobs(`prefix ${real} suffix`).includes("base64 blob removed"));
});

test("trim-tool-calls shrinks completed calls without breaking their shape", async () => {
  const { optimizeConversation } = await import("../optimize.js");

  const bigFile = "line of html\n".repeat(4000);
  const conversation = JSON.stringify({
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "Write", input: { file_path: "/tmp/a.html", content: bigFile } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
      ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i}` })),
    ],
  });

  const base = optimizeConversation(conversation, { strategies: ["dedupe"] });
  const trimmed = optimizeConversation(conversation, { strategies: ["dedupe", "trim-tool-calls"] });
  assert.ok(trimmed.tokensAfter < base.tokensAfter / 2, "the inline file is the bulk of the context and must shrink");

  const block = (trimmed.conversation as any).messages[0].content[0];
  assert.equal(block.type, "tool_use");
  assert.equal(block.id, "tu_1", "the tool_use id must survive — the API pairs results by it");
  assert.equal(block.name, "Write");
  assert.equal(block.input.file_path, "/tmp/a.html", "short arguments are kept intact");
  assert.match(block.input.content, /chars trimmed/, "the cut is marked, not silent");

  // It is opt-in: the default strategy set must leave calls alone.
  const defaults = optimizeConversation(conversation, {});
  assert.equal((defaults.conversation as any).messages[0].content[0].input.content.length, bigFile.length);
});

test("malformed conversations degrade to a warning, never a stack trace", async () => {
  const { parseConversation } = await import("../parse.js");
  const { profileConversation } = await import("../profile.js");
  const { optimizeConversation } = await import("../optimize.js");

  // Shapes seen in truncated, hand-edited and third-party-exported files.
  const cases: Record<string, unknown> = {
    "null entry in messages": { messages: [null, { role: "user", content: "hi" }] },
    "messages is not an array": { messages: "nope" },
    "message without a role": { messages: [{ content: "hi" }] },
    "null tool_calls entry": { messages: [{ role: "assistant", tool_calls: [null] }] },
    "block without a type": { messages: [{ role: "user", content: [{ foo: "bar" }] }] },
    "numeric content": { messages: [{ role: "user", content: 42 }] },
  };
  for (const [name, value] of Object.entries(cases)) {
    const json = JSON.stringify(value);
    assert.doesNotThrow(() => profileConversation(parseConversation(json)), `profile: ${name}`);
    if (Array.isArray((value as { messages?: unknown }).messages)) {
      assert.doesNotThrow(
        () => optimizeConversation(json, { strategies: ["dedupe", "trim-tool-results", "trim-tool-calls", "strip-base64"] }),
        `optimize: ${name}`
      );
    }
  }
  // A non-array `messages` is malformed, not an empty chat — say which.
  assert.match(parseConversation('{"messages":"nope"}').parseWarning ?? "", /not an array/);
});

test("dropping malformed entries does not break prune-history", async () => {
  const { optimizeConversation } = await import("../optimize.js");

  // prune-history splices the messages array in place and the caller gets back
  // its own object, so entries must be removed from THAT array, not a copy.
  const messages: unknown[] = [null];
  for (let i = 0; i < 30; i++) messages.push({ role: i % 2 ? "assistant" : "user", content: `turn ${i} ${"x".repeat(400)}` });
  const result = optimizeConversation(JSON.stringify({ messages }), { strategies: ["prune-history"] });

  const out = (result.conversation as { messages: Array<{ content: string }> }).messages;
  assert.ok(out.length < 12, `history must actually shrink, got ${out.length}`);
  assert.match(String(out[0].content), /pruned/, "the stub replaces the pruned turns");
  assert.ok(result.tokensAfter < result.tokensBefore, "reported savings must reflect a real change");
});

test("files re-read through the shell are detected, command words are not", async () => {
  const { profileConversation } = await import("../profile.js");
  const { parseConversation } = await import("../parse.js");

  const bash = (command: string, i: number) => ({
    role: "assistant",
    content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command } }],
  });
  const result = (i: number) => ({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "file contents ".repeat(300) }],
  });

  const messages: unknown[] = [];
  let i = 0;
  // The same file dumped four times through the shell — invisible to a
  // detector that only understands read-style tools.
  for (; i < 4; i++) {
    messages.push(bash("cat /Users/kp/app/config.json", i), result(i));
  }
  // None of these is a repeated read of one file.
  messages.push(bash("cat > /tmp/out.txt << EOF\nhello\nEOF", i++));
  messages.push(bash("grep -r TODO /Users/kp/app", i++));
  messages.push(bash("cat /Users/kp/app/*.ts", i++));
  // The regression that made "echo" look like a file.
  for (let n = 0; n < 5; n++) messages.push(bash("head -20 /var/log/app.log; echo done", i++));

  const findings = profileConversation(parseConversation(JSON.stringify({ messages })))
    .findings.filter((f) => f.id === "repeated_file_read");
  const named = findings.map((f) => f.message);

  assert.equal(findings.length, 2, `expected config.json and app.log only, got: ${named.join(" | ")}`);
  assert.ok(named.some((m) => m.includes("config.json")), "shell reads count as reads");
  assert.ok(named.some((m) => m.includes("app.log")), "a path after flags is still the target");
  assert.ok(!named.some((m) => m.includes("echo")), "the next shell word is not a file");
  assert.ok(!named.some((m) => m.includes("*")), "a glob is not one repeated file");
});
