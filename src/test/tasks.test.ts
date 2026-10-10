/** tasks: session cost from recorded usage, commits counted from the session's own successful git commit calls. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitCount, costPerTask, sessionCost } from "../tasks.js";

test("commitCount: chained commands, -C repos, no amends or dry runs", () => {
  assert.equal(commitCount('cd x && git add -A && git commit -q -m "a" && git push'), 1);
  assert.equal(commitCount('git -C /r commit -m a; git commit -m b'), 2);
  assert.equal(commitCount("git commit --amend --no-edit"), 0);
  assert.equal(commitCount("git commit --dry-run"), 0);
  assert.equal(commitCount("git log --grep commit"), 0);
  assert.equal(commitCount("echo git commit"), 0);
});

test("a session's cost is priced from its usage; failed commits do not count", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-tasks-"));
  const t = (m: number) => new Date(Date.now() - 3_600_000 + m * 60_000).toISOString();
  const lines = [
    { type: "assistant", cwd: "/w/app", timestamp: t(0), message: { id: "m1", model: "claude-sonnet-5", usage: { input_tokens: 1000, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 0, output_tokens: 500 }, content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "git add -A && git commit -m one" } }] } },
    { type: "user", cwd: "/w/app", timestamp: t(1), message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "[main abc1234] one" }] } },
    { type: "assistant", cwd: "/w/app", timestamp: t(2), message: { id: "m2", model: "claude-sonnet-5", usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 11_000, output_tokens: 100 }, content: [{ type: "tool_use", id: "b2", name: "Bash", input: { command: "git commit -m two" } }] } },
    { type: "user", cwd: "/w/app", timestamp: t(3), message: { content: [{ type: "tool_result", tool_use_id: "b2", is_error: true, content: "nothing to commit" }] } },
  ];
  const p = join(dir, "s.jsonl");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const s = sessionCost(p)!;
  assert.equal(s.commits, 1);
  assert.equal(s.requests, 2);
  // Sonnet: 1k input x $3 + 10k writes x $3.75 + 11k reads x $0.30 + 600 output x $15, per million.
  const expected = (1000 * 3 + 10_000 * 3.75 + 11_000 * 0.3 + 600 * 15) / 1e6;
  assert.ok(Math.abs(s.usd - expected) < 1e-12);
  const r = costPerTask(30, [p]);
  assert.equal(r.projects[0].commits, 1);
  assert.ok(Math.abs(r.projects[0].usdPerCommit! - expected) < 1e-12);
});
