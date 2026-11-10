/**
 * The guard against new models: every Claude model a source names (Claude
 * Code's binary, its CHANGELOG, the price page) has a price of its own, or
 * scripts/check-models.mjs fails. On 0.45, Claude Code 2.1.321's catalog
 * named claude-fable-5-2 and claude-mythos-5-2, which the table priced by the
 * family row.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeModelIds, unpricedClaudeIds } from "../modelids.js";

test("the ids a text names: Bedrock ids, first-party ids from version 4, display names; not app ids or old aliases", () => {
  const text = [
    // As in the binary's catalog (strings output).
    "us.anthropic.claude-opus-4-1-20250805-v1:0 anthropic.claude-fable-5-2 global.anthropic.claude-sonnet-4-6-v1 anthropic.claude-3-5-haiku-20241022-v1:0",
    "com.anthropic.claude-code com.anthropic.claude-code-url-handler",
    "\u0000claude-fable-5-2\u0000claude-opus-4-0\u0000claude-haiku-3-5\u0000claude-sonnet-3-7\u0000claude-mythos-preview\u0000claude-opus-5-5-20261001\u0000",
    // As the price page and the CHANGELOG write them.
    "| Claude Fable 5.2 | $8 / MTok |  Claude Opus 4.1 ([retired]) and Claude Mythos Preview. Added Claude Sonnet 5.5.",
  ].join("\n");
  assert.deepEqual(claudeModelIds(text), [
    "claude-3-5-haiku", "claude-fable-5-2", "claude-opus-4", "claude-opus-4-1", "claude-opus-5-5", "claude-sonnet-4-6", "claude-sonnet-5-5",
  ]);
  assert.deepEqual(unpricedClaudeIds(text), []);
});

test("a model with no price of its own is named: a new version, in any spelling", () => {
  assert.deepEqual(unpricedClaudeIds("Added Claude Opus 5.7 as the default Opus model"), ["claude-opus-5-7"]);
  assert.deepEqual(unpricedClaudeIds("us.anthropic.claude-sonnet-6-v1:0"), ["claude-sonnet-6"]);
  assert.deepEqual(unpricedClaudeIds("model: claude-haiku-6-1."), ["claude-haiku-6-1"]);
});

test("scripts/check-models.mjs: exit 0 when every model is priced, 1 naming the ones that are not, 2 on an unreadable source", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-models-"));
  try {
    const priced = join(dir, "priced.txt");
    const fresh = join(dir, "fresh.bin");
    writeFileSync(priced, "Claude Fable 5.2 and claude-opus-5-5");
    writeFileSync(fresh, Buffer.concat([Buffer.from([0, 255, 1]), Buffer.from("anthropic.claude-fable-5-2\u0000anthropic.claude-opus-6\u0000")]));
    const run = (...args: string[]) => spawnSync(process.execPath, [join("scripts", "check-models.mjs"), ...args], { encoding: "utf8" });
    const ok = run("--file", priced);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /all 2 Claude models priced/);
    const bad = run("--file", priced, "--binary", fresh);
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /1 of 2 Claude models have no price of their own in src\/pricing\.ts: claude-opus-6/);
    assert.equal(run("--file", join(dir, "missing.txt")).status, 2);
    assert.equal(run("--nope").status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
