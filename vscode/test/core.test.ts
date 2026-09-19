import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextWindowFor, formatTokens, newestTranscript, projectDirFor, statusFor, statusForWorkspace, tailUsage } from "../src/core";

test("workspace folder maps to Claude Code's project directory the way Claude Code names it", () => {
  // Build the expected path with join: on Windows the separators are
  // backslashes, and a hardcoded POSIX string failed all three Windows CI jobs.
  const home = join("home", "u");
  const expected = (name: string) => join(home, ".claude", "projects", name);
  assert.equal(projectDirFor("/Users/kp/tech", home), expected("-Users-kp-tech"));
  assert.equal(projectDirFor("/Users/kp/tech/.claude/worktrees/x", home), expected("-Users-kp-tech--claude-worktrees-x"), "dots become dashes too");
  assert.equal(projectDirFor("/Users/kp/tech/Back-EndCRM", home), expected("-Users-kp-tech-Back-EndCRM"), "existing dashes survive");
  // A Windows workspace path flattens the same way.
  assert.equal(projectDirFor("C:\\Users\\kp\\tech", home), expected("C--Users-kp-tech"));
});

test("the newest transcript wins, and a folder with none reports why", () => {
  const home = mkdtempSync(join(tmpdir(), "cd-vsc-"));
  const ws = "/Users/kp/tech/proj";
  const dir = projectDirFor(ws, home);
  assert.equal(statusForWorkspace(ws, 70, home).reason, "no Claude Code session for this folder yet");

  mkdirSync(dir, { recursive: true });
  const older = join(dir, "old.jsonl");
  const newer = join(dir, "new.jsonl");
  const line = (tokens: number, read: number, model: string) =>
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "x", model, usage: { input_tokens: tokens - read, cache_read_input_tokens: read } } });
  writeFileSync(older, line(50_000, 0, "claude-sonnet-5") + "\n");
  writeFileSync(newer, `${JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })}\n${line(800_000, 780_000, "claude-opus-5")}\n{"partial`);
  utimesSync(older, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  assert.equal(newestTranscript(dir), newer);

  const usage = tailUsage(newer);
  assert.equal(usage?.tokens, 800_000, "a trailing partial line is skipped, the last usage is found");
  assert.ok(Math.abs((usage?.cacheShare ?? 0) - 0.975) < 0.001);

  const result = statusForWorkspace(ws, 70, home);
  assert.equal(result.transcript, newer);
  assert.match(result.status!.text, /ctx 800k · 80% · cache 98% \$\(warning\)/);
  assert.equal(result.status!.warn, true, "80% is above the 70% threshold");
  assert.match(result.status!.tooltip, /Above 70% of the window/);
  assert.equal(statusForWorkspace(ws, 90, home).status!.warn, false, "the threshold is the user's");
});

test("windows and formatting match the CLI", () => {
  assert.equal(contextWindowFor("claude-opus-5"), 1_000_000);
  assert.equal(contextWindowFor("claude-haiku-4-5"), 200_000);
  assert.equal(contextWindowFor("gpt-4o"), 128_000);
  assert.equal(contextWindowFor("made-up"), undefined);
  assert.equal(formatTokens(801_234), "801k");
  assert.equal(formatTokens(1_200_000), "1.2M");
  assert.equal(formatTokens(Number.NaN), "0");
  // Unknown window: the number without a percentage, and never a warning.
  const s = statusFor({ tokens: 5000, model: "made-up" }, 70);
  assert.match(s.text, /ctx 5\.0k$/);
  assert.equal(s.warn, false);
});
