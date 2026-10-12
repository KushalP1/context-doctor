/** subagents: a subagent's bill against the same work done in the parent, from the transcripts. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subagentPayback } from "../subagentpay.js";
import { realModel } from "../tokens.js";

// Relative to now: subagents count by their own start time, and a fixed date
// would fall out of the 30-day window a month after it was written.
const day = Date.now() - 2 * 86_400_000;
const at = (min: number) => new Date(day + min * 60_000).toISOString();
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

test("the comparison: work at the parent's price, parent context per step, and the carried reads", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-sub-"));
  const parent = join(dir, "s1.jsonl");
  const usage = (n: number) => ({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: n, output_tokens: 0 });
  writeFileSync(parent, jsonl([
    { type: "assistant", timestamp: at(0), message: { id: "p1", model: "claude-sonnet-5", usage: usage(100_000), content: [{ type: "tool_use", id: "toolu_X", name: "Task", input: {} }] } },
    { type: "user", timestamp: at(30), message: { content: [{ type: "tool_result", tool_use_id: "toolu_X", content: "short summary" }] } },
    ...[31, 32, 33, 34, 35].map((m, i) => ({ type: "assistant", timestamp: at(m), message: { id: `p${i + 2}`, model: "claude-sonnet-5", usage: usage(100_100), content: [] } })),
    { type: "assistant", timestamp: at(36), message: { id: "syn", model: "<synthetic>", usage: usage(0), content: [] } },
  ]));
  const sub = join(dir, "s1", "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "agent-abc.meta.json"), JSON.stringify({ agentType: "Explore", description: "Find the config", toolUseId: "toolu_X" }));
  writeFileSync(join(sub, "agent-abc.jsonl"), jsonl([
    { type: "user", isSidechain: true, timestamp: at(1), message: { content: "Find the config" } },
    ...[0, 1, 2, 3].map((i) => ({ type: "assistant", isSidechain: true, timestamp: at(2 + i), message: { id: `s${i}`, model: "claude-sonnet-5", usage: { input_tokens: 0, cache_creation_input_tokens: i === 0 ? 10_000 : 0, cache_read_input_tokens: i === 0 ? 0 : 10_000, output_tokens: 0 } } })),
    { type: "user", isSidechain: true, timestamp: at(3), message: { content: [{ type: "tool_result", tool_use_id: "r1", content: "config line\n".repeat(4000) }] } },
  ]));
  const r = subagentPayback(30, [parent]);
  assert.equal(r.subagents.length, 1);
  const a = r.subagents[0];
  assert.equal(a.steps, 4);
  assert.equal(a.parentContextTokens, 100_000);
  assert.equal(a.laterRequests, 5);
  // Sonnet 5: 10k written at 1.25 x $2/M, then 3 x 10k read at $0.20/M.
  const bill = (10_000 * 2.5 + 30_000 * 0.2) / 1e6;
  assert.ok(Math.abs(a.costUsd - bill) < 1e-12);
  // In the parent: the work minus the subagent's own 10k startup (all of it here), the parent's 100k per step, the carried reads
  // (written once at the parent's write price, 1.25x with no writes recorded, then read by 5 later requests).
  const rideAlong = (100_000 * 4 * 0.2) / 1e6;
  const carried = ((a.readTokens - a.returnedTokens) * (1.25 * 2 + 5 * 0.2)) / 1e6;
  assert.ok(Math.abs(a.inParentUsd - (rideAlong + carried)) < 1e-9, `${a.inParentUsd} vs ${rideAlong + carried}`);
  assert.ok(a.netUsd > 0);
});

test("realModel skips Claude Code's <synthetic> placeholder", () => {
  assert.equal(realModel("<synthetic>"), undefined);
  assert.equal(realModel("claude-opus-5"), "claude-opus-5");
  assert.equal(realModel(undefined), undefined);
});
