/** Output share, reasoning share and polling: priced from recorded usage, Claude Code and Codex alike. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lensOverSessions, renderLens, sessionLens } from "../lens.js";

const at = (s: number) => new Date(Date.parse("2026-10-26T10:00:00Z") + s * 1000).toISOString();

function claudeSession(): string {
  const rows: string[] = [];
  const reply = (i: number, tool: { name: string; input: unknown } | undefined, thinking: number) => JSON.stringify({
    type: "assistant", timestamp: at(i * 10), uuid: `u${i}`,
    message: { id: `m${i}`, model: "claude-opus-5-5", role: "assistant",
      content: tool ? [{ type: "tool_use", id: `t${i}`, name: tool.name, input: tool.input }] : [{ type: "text", text: "done" }],
      usage: { input_tokens: 10, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0, output_tokens: 1_000, output_tokens_details: { thinking_tokens: thinking } } },
  });
  rows.push(reply(0, { name: "Bash", input: { command: "npm run build", run_in_background: true } }, 500));
  for (let i = 1; i <= 4; i++) rows.push(reply(i, { name: "BashOutput", input: { bash_id: "b1" } }, 0));
  rows.push(reply(5, undefined, 0));
  const dir = mkdtempSync(join(tmpdir(), "cd-lens-"));
  const p = join(dir, "s.jsonl");
  writeFileSync(p, rows.join("\n") + "\n");
  return p;
}

test("Claude Code: output and reasoning shares by model; three repeats of one BashOutput poll, each priced at its request", () => {
  const l = sessionLens(claudeSession());
  assert.equal(l.byModel.length, 1);
  const m = l.byModel[0];
  assert.equal(m.requests, 6);
  assert.equal(m.outputTokens, 6_000);
  assert.equal(m.reasoningTokens, 500);
  // Opus 5.5: $20/M out, $0.20/M read, $4/M in. Each request: 0.02 out + 0.02 read + 0.00004 in.
  assert.ok(Math.abs(m.outputUsd - 0.12) < 1e-9, String(m.outputUsd));
  assert.equal(l.polls.repeats, 3, "the first BashOutput is not a repeat");
  assert.equal(l.polls.byTool[0].tool, "BashOutput");
  assert.ok(Math.abs(l.polls.usd - 3 * (0.02 + 0.02 + 0.00004)) < 1e-9, String(l.polls.usd));
  assert.equal(l.polls.contextTokens, 3 * 100_010);
  const text = renderLens(l).join("\n");
  assert.match(text, /Output: 50% of \$0\.24; reasoning 8% of output tokens\./);
  assert.match(text, /3 repeated identical tool calls \(polling\)/);
  assert.match(text, /context-doctor ab/);
});

test("Codex: wait polls priced at the response that made them; reasoning_output_tokens read; a limits-only refresh is not a request", () => {
  const home = mkdtempSync(join(tmpdir(), "cd-lens-cx-"));
  const dir = join(home, ".codex", "sessions", "2026", "10", "26");
  mkdirSync(dir, { recursive: true });
  const rows = [JSON.stringify({ timestamp: at(0), type: "turn_context", payload: { model: "gpt-5.5" } })];
  let total = 0;
  for (let i = 0; i < 3; i++) {
    rows.push(JSON.stringify({ timestamp: at(i * 10 + 1), type: "response_item", payload: { type: "function_call", name: "wait", call_id: `c${i}`, arguments: '{"session_id":4,"timeout_ms":30000}' } }));
    total += 20_100;
    rows.push(JSON.stringify({ timestamp: at(i * 10 + 2), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: 20_000, cached_input_tokens: 18_000, output_tokens: 100, reasoning_output_tokens: 40 } } } }));
    rows.push(JSON.stringify({ timestamp: at(i * 10 + 3), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: 20_000, cached_input_tokens: 18_000, output_tokens: 100, reasoning_output_tokens: 40 } } } }));
  }
  const p = join(dir, "rollout-x.jsonl");
  writeFileSync(p, rows.join("\n") + "\n");
  const l = sessionLens(p);
  assert.equal(l.byModel[0].requests, 3, "the repeated token_count (same running total) is the same request");
  assert.equal(l.byModel[0].reasoningTokens, 120);
  assert.equal(l.polls.repeats, 2);
  assert.equal(l.polls.byTool[0].tool, "wait");
  assert.ok(l.polls.usd > 0);
  assert.equal(lensOverSessions(30, { paths: [p], now: Date.parse("2026-10-27T00:00:00Z") }).polls.repeats, 2);
  assert.equal(lensOverSessions(30, { paths: [p], now: Date.parse("2027-01-27T00:00:00Z") }).byModel.length, 0, "outside the period: nothing");
});
