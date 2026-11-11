/**
 * `subagents`' payback weighs a subagent against its parent as the parent
 * ran when it launched it: a session that moved to another model later
 * (Claude Code 2.1.321 moved saved Fable 5.1 picks to the `fable` alias,
 * Fable 5.2) is priced on the model it was on then, not its last one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subagentPayback } from "../subagentpay.js";

const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);

test("a subagent is weighed against the parent's model at its launch, not the session's last model", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-subpay-parent-"));
  try {
    const t0 = Date.now() - 3_600_000;
    const iso = (t: number) => new Date(t).toISOString();
    const reply = (id: string, model: string, at: number, usage: Record<string, number>, side = false) => JSON.stringify({ type: "assistant", uuid: id, timestamp: iso(at), ...(side ? { isSidechain: true } : {}), message: { id, model, usage } });
    const parent = join(dir, "s1.jsonl");
    // On Fable 5.1 with a 200k context when the subagent starts; on Opus 5.5 afterwards.
    writeFileSync(parent, [
      reply("p1", "claude-fable-5-1", t0, { input_tokens: 0, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 0, output_tokens: 10 }),
      reply("p2", "claude-opus-5-5", t0 + 600_000, { input_tokens: 0, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 0, output_tokens: 10 }),
    ].join("\n") + "\n");
    mkdirSync(join(dir, "s1", "subagents"), { recursive: true });
    // One Sonnet 5.5 step: 1k uncached, 100 out ($0.003); its startup context is that 1k.
    writeFileSync(join(dir, "s1", "subagents", "agent-a1.jsonl"), [
      JSON.stringify({ type: "user", isSidechain: true, timestamp: iso(t0 + 60_000), message: { role: "user", content: "look" } }),
      reply("s1", "claude-sonnet-5-5", t0 + 60_000, { input_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 100 }, true),
    ].join("\n") + "\n");
    const [a] = subagentPayback(1, [parent]).subagents;
    near(a.costUsd, (1_000 * 2 + 100 * 10) / 1e6, "its bill");
    // At Fable 5.1 ($10 in, reads $0.25): the work beyond its startup write (1k x 1.25 x $2) at 10/2, plus 200k re-read once.
    const work = ((1_000 * 2 + 100 * 10) / 1e6 - (1_000 * 1.25 * 2) / 1e6) * (10 / 2);
    near(a.inParentUsd, work + (200_000 * 0.25) / 1e6, "in the parent, on Fable 5.1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
