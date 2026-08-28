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
  // The trimmed tool_result must KEEP its block type and tool_use_id — the
  // Anthropic API rejects a tool_use with no matching tool_result.
  const toolResultMsg = out.messages[2].content as Array<Record<string, unknown>>;
  assert.equal(toolResultMsg[0].type, "tool_result");
  assert.equal(toolResultMsg[0].tool_use_id, "t1");
  assert.ok((toolResultMsg[0].content as string).length < 1000, "tool_result content was trimmed");
  // And the tool_use block on the assistant side is untouched.
  const assistantMsg = out.messages[1].content as Array<Record<string, unknown>>;
  assert.equal(assistantMsg[0].type, "tool_use");
});

test("prune-history never leaves an orphaned tool result at the head of the tail", () => {
  // Build a conversation where the naive prune boundary would land exactly on
  // a tool-result message (its tool_use call falling in the pruned half).
  const filler = "some earlier discussion that will be pruned away. ".repeat(20);
  const conv = JSON.stringify({
    messages: [
      ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `${i} ${filler}` })),
      { role: "assistant", content: [{ type: "tool_use", id: "tX", name: "search", input: { q: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tX", content: "results here" }] }, // naive boundary lands HERE
      { role: "assistant", content: "Summary of results." },
      { role: "user", content: "thanks" },
      { role: "assistant", content: "welcome" },
    ],
  });
  const result = optimizeConversation(conv, { strategies: ["prune-history"], keepRecent: 4 });
  const out = result.conversation as { messages: Array<{ role: string; content: unknown }> };
  // First kept message after the stub must NOT be a tool result.
  const firstKept = out.messages[1].content;
  const isToolResult = Array.isArray(firstKept) && (firstKept as any[]).some((b) => b?.type === "tool_result");
  assert.equal(isToolResult, false, "tail must not start with an orphaned tool_result");
  assert.ok(result.applied.some((c) => c.strategy === "prune-history"), "pruning still happened");
});

test("near-duplicate detection catches same doc with different lead-ins", () => {
  // Varied clauses (not a repeated sentence) — like a real document.
  const doc = Array.from(
    { length: 30 },
    (_, i) => `Clause ${i} of the pricing policy covers refund scenario ${i} where the customer holds receipt series ${i * 7} under regional rule ${i % 5}.`
  ).join(" ");
  const conv = JSON.stringify({
    messages: [
      { role: "user", content: "Here is our policy document for you to review:\n" + doc },
      { role: "assistant", content: "Understood, thanks for sharing the policy." },
      { role: "user", content: "Sharing the policy doc again with a totally different intro so exact hashing misses it:\n" + doc },
    ],
  });
  const profile = profileConversation(parseConversation(conv));
  const near = profile.findings.find((f) => f.id === "near_duplicate");
  assert.ok(near, "near_duplicate finding expected");
  assert.deepEqual(near!.messages, [0, 2]);
  assert.ok(near!.estSavings > 50);
});

test("raw text input still profiles", () => {
  const profile = profileConversation(parseConversation("just some prompt text"));
  assert.equal(profile.messageCount, 1);
  assert.ok(profile.totalTokens > 0);
});

test("compacted history is excluded from live context", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { parseSessionFile } = await import("../session.js");

  const dir = mkdtempSync(join(tmpdir(), "ctxdoc-compact-"));
  const file = join(dir, "s.jsonl");
  const line = (role: string, content: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: role, message: { role, content }, ...extra }) + "\n";

  writeFileSync(
    file,
    line("user", "old question one") +
      line("assistant", "old answer one") +
      line("user", "old question two") +
      // Compaction boundary: everything above is replaced by this summary.
      line("user", "Summary of the earlier conversation.", { isCompactSummary: true }) +
      line("assistant", "continuing after compaction") +
      line("user", "a live follow-up")
  );

  const parsed = parseSessionFile(file);
  assert.equal(parsed.compactedAway, 3, "three pre-compaction messages dropped");
  assert.equal(parsed.messageCount, 3, "summary + the two live turns remain");
  const conv = JSON.parse(parsed.conversationJson) as { messages: Array<{ content: string }> };
  assert.match(conv.messages[0].content, /Summary of the earlier/);
  assert.ok(!parsed.conversationJson.includes("old question one"), "pre-compaction turns are not counted");
});

test("a session without compaction keeps every message", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { parseSessionFile } = await import("../session.js");

  const dir = mkdtempSync(join(tmpdir(), "ctxdoc-nocompact-"));
  const file = join(dir, "s.jsonl");
  writeFileSync(
    file,
    JSON.stringify({ type: "user", message: { role: "user", content: "one" } }) + "\n" +
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "two" } }) + "\n"
  );
  const parsed = parseSessionFile(file);
  assert.equal(parsed.compactedAway, 0);
  assert.equal(parsed.messageCount, 2);
});

test("savings are a union, never a double-counted sum", () => {
  // One message is simultaneously an oversized tool result AND a duplicate of
  // an earlier one: two findings, but the tokens can only be saved once.
  const bulk = "row of data ".repeat(1200);
  const conv = JSON.stringify({
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "query", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: bulk }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "query", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: bulk }] },
    ],
  });
  const profile = profileConversation(parseConversation(conv));
  const naiveSum = profile.findings.reduce((a, f) => a + f.estSavings, 0);

  assert.ok(profile.findings.length >= 2, "several findings touch the same tokens");
  assert.ok(profile.totalEstSavings < naiveSum, "union is smaller than the naive sum");
  assert.ok(profile.totalEstSavings <= profile.totalTokens, "never claims more than exists");
});

test("reported savings never exceed 90% of the context", () => {
  const dupe = "identical block of policy text that repeats verbatim. ".repeat(30);
  const conv = JSON.stringify({
    messages: Array.from({ length: 10 }, () => ({ role: "user", content: dupe })),
  });
  const profile = profileConversation(parseConversation(conv));
  assert.ok(profile.totalEstSavings <= Math.round(profile.totalTokens * 0.9) + 1);
});

test("API-reported token counts are captured as ground truth", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { parseSessionFile } = await import("../session.js");

  const dir = mkdtempSync(join(tmpdir(), "ctxdoc-usage-"));
  const file = join(dir, "s.jsonl");
  writeFileSync(
    file,
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n" +
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: "hello",
          model: "claude-sonnet-5",
          // The real request was mostly cache reads — all three fields count.
          usage: { input_tokens: 1200, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 800 },
        },
      }) + "\n"
  );

  const parsed = parseSessionFile(file);
  assert.equal(parsed.reportedInputTokens, 42_000, "sums input + cache read + cache creation");
  assert.equal(parsed.model, "claude-sonnet-5");
});

test("a transcript without usage reports no measured figure", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { parseSessionFile } = await import("../session.js");

  const dir = mkdtempSync(join(tmpdir(), "ctxdoc-nousage-"));
  const file = join(dir, "s.jsonl");
  writeFileSync(file, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
  assert.equal(parseSessionFile(file).reportedInputTokens, undefined);
});

test("flags a file read repeatedly, each copy still in context", () => {
  const fileBody = "export function handler() { /* body */ }\n".repeat(200);
  const messages: unknown[] = [];
  for (let i = 0; i < 3; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `r${i}`, name: "Read", input: { file_path: "/src/api/handler.ts" } }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `r${i}`, content: fileBody }] });
  }
  const profile = profileConversation(parseConversation(JSON.stringify({ messages })));
  const finding = profile.findings.find((f) => f.id === "repeated_file_read");
  assert.ok(finding, "repeated read should be flagged");
  assert.match(finding!.message, /handler\.ts was read 3 times/);
  assert.ok(finding!.estSavings > 0);
});

test("a file read once is not flagged", () => {
  const conv = JSON.stringify({
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "/src/a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: "contents ".repeat(400) }] },
    ],
  });
  const profile = profileConversation(parseConversation(conv));
  assert.equal(profile.findings.some((f) => f.id === "repeated_file_read"), false);
});

test("flags large failed tool output retained verbatim", () => {
  const trace = "Traceback (most recent call last):\n  File \"app.py\", line 42, in handler\n" + "    frame detail\n".repeat(400);
  const conv = JSON.stringify({
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "python app.py" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: trace }] },
    ],
  });
  const profile = profileConversation(parseConversation(conv));
  const finding = profile.findings.find((f) => f.id === "retained_error_output");
  assert.ok(finding, "failed output should be flagged");
  assert.match(finding!.suggestion, /one line that identifies the failure/);
});

test("successful tool output is not mistaken for an error", () => {
  const conv = JSON.stringify({
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file listing line\n".repeat(400) }] },
    ],
  });
  const profile = profileConversation(parseConversation(conv));
  assert.equal(profile.findings.some((f) => f.id === "retained_error_output"), false);
});
