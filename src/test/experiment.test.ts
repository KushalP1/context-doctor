/**
 * The harness drives the `claude` CLI, which tests cannot call. A stub binary
 * stands in: it makes a change, emits the JSON shape `claude -p
 * --output-format json` returns, and behaves differently when forked from an
 * existing session, so both arms and the verdict are exercised end to end.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { claudeArgs, renderExperiment, runExperiment } from "../experiment.js";

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ctxdoc-exp-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git("add", ".");
  git("commit", "-q", "-m", "start");
  return dir;
}

/** A fake `claude` that edits the repo and reports usage; forked arm reports a fatter bill and breaks the check. */
function stubClaude(): string {
  // Outside the repo: the harness runs `git clean -fd` between arms, which
  // would otherwise delete the stub itself (as it should).
  const path = join(mkdtempSync(join(tmpdir(), "ctxdoc-stub-")), "claude-stub.sh");
  writeFileSync(
    path,
    `#!/bin/sh
forked=0
for a in "$@"; do [ "$a" = "--fork-session" ] && forked=1; done
if [ "$forked" = "1" ]; then
  echo "broken" > created.txt
  printf '%s' '{"type":"result","session_id":"sess-existing","total_cost_usd":0.42,"duration_ms":9000,"num_turns":5,"is_error":false,"result":"done","usage":{"input_tokens":900,"cache_read_input_tokens":60000,"cache_creation_input_tokens":4000,"output_tokens":500}}'
else
  echo "ok" > created.txt
  printf '%s' '{"type":"result","session_id":"sess-fresh","total_cost_usd":0.11,"duration_ms":4000,"num_turns":3,"is_error":false,"result":"done","usage":{"input_tokens":12000,"cache_read_input_tokens":0,"cache_creation_input_tokens":8000,"output_tokens":400}}'
fi
`
  );
  chmodSync(path, 0o755);
  return path;
}

test("both arms run from the same commit, the tree is reset, and the verdict weighs pass/fail", { skip: process.platform === "win32" && "sh stub" }, () => {
  const dir = gitRepo();
  const saved = { bin: process.env.CONTEXT_DOCTOR_CLAUDE_BIN, cc: process.env.CLAUDECODE };
  process.env.CONTEXT_DOCTOR_CLAUDE_BIN = stubClaude();
  delete process.env.CLAUDECODE; // the harness refuses inside Claude Code; the test is not Claude Code
  try {
    const opts = { task: "make created.txt", check: "grep -qx ok created.txt", existing: "sess-orig", budgetUsd: 0.5, cwd: dir };
    const result = runExperiment(opts);
    assert.equal(result.refused, undefined);
    assert.equal(result.arms.length, 2);

    const [fresh, existing] = result.arms;
    assert.equal(fresh.sessionId, "sess-fresh");
    assert.equal(existing.sessionId, "sess-existing");
    assert.equal(fresh.check?.passed, true, "fresh arm wrote 'ok' and the check passed");
    assert.equal(existing.check?.passed, false, "forked arm wrote 'broken' and the check failed");
    assert.equal(existing.cacheRead, 60000, "cache read is read from the JSON, not estimated");
    assert.ok(!existsSync(join(dir, "created.txt")), "the tree is reset to the start commit after the arms");

    const out = renderExperiment(result, opts);
    assert.match(out, /billed input\s+20k\s+65k/, "billed input = input + cache read + cache write, per arm");
    assert.match(out, /check\s+PASS\s+FAIL/);
    assert.match(out, /fresh was cheaper AND passed; existing failed/, "cheaper only counts if it also passed");
  } finally {
    if (saved.bin === undefined) delete process.env.CONTEXT_DOCTOR_CLAUDE_BIN; else process.env.CONTEXT_DOCTOR_CLAUDE_BIN = saved.bin;
    if (saved.cc !== undefined) process.env.CLAUDECODE = saved.cc;
  }
});

test("the harness refuses to spend money on a dirty tree or inside Claude Code", () => {
  const dir = gitRepo();
  writeFileSync(join(dir, "README.md"), "changed\n");
  const saved = process.env.CLAUDECODE;
  delete process.env.CLAUDECODE;
  try {
    const dirty = runExperiment({ task: "t", cwd: dir });
    assert.match(dirty.refused ?? "", /uncommitted changes/, "a real run on a dirty tree is refused");
    // A dry run only reports; it must not refuse for the same reason.
    const dry = runExperiment({ task: "t", cwd: dir, dryRun: true, existing: "abc" });
    assert.equal(dry.refused, undefined);
    assert.equal(dry.treeClean, false);
    const shown = renderExperiment(dry, { task: "t", existing: "abc", dryRun: true });
    assert.match(shown, /--resume abc --fork-session/, "the dry run shows the exact fork command");
    assert.match(shown, /tree is dirty right now/);

    process.env.CLAUDECODE = "1";
    assert.match(runExperiment({ task: "t", cwd: dir }).refused ?? "", /inside another Claude Code session/);
  } finally {
    if (saved === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = saved;
  }
  // Fork flags only ever appear on the existing arm.
  assert.ok(!claudeArgs({ task: "t", existing: "abc" }, "fresh").includes("--fork-session"));
  assert.ok(claudeArgs({ task: "t", existing: "abc" }, "existing").includes("--fork-session"));
});
