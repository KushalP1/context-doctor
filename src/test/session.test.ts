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
