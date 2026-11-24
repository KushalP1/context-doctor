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
import { fileURLToPath } from "node:url";
import { catalogModelIds, claudeModelIds, unpricedClaudeIds } from "../modelids.js";

/** The checkout: the suite runs from a folder of its own (scripts/test.mjs), so nothing is relative to the working folder. */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

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

test("a family the table does not know is named too (Fable and Mythos were new once); products, plans and test ids are not models", () => {
  // No family row prices these: every request would be unpriced, not an estimate.
  assert.deepEqual(unpricedClaudeIds("- Added Claude Aria 1 (`claude-aria-1`), now the default"), ["claude-aria-1"]);
  assert.deepEqual(unpricedClaudeIds("\u0000claude-quill-2-1-20270101\u0000"), ["claude-quill-2-1"]);
  // What the 2.1.321 binary, the CHANGELOG and the price page hold beside the models.
  const noise = "Claude Code 2.1.321 · Claude Code 2.0 · Claude Max 20x · Claude Pro 5 · Claude Desktop 1.2 · claude-eval-9 · claude-code-2 · Claude Tag 1";
  assert.deepEqual(claudeModelIds(noise), []);
});

test("scripts/check-models.mjs: exit 0 when every model is priced, 1 naming the ones that are not, 2 on an unreadable source", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-models-"));
  try {
    const priced = join(dir, "priced.txt");
    const fresh = join(dir, "fresh.bin");
    writeFileSync(priced, "Claude Fable 5.2 and claude-opus-5-5");
    writeFileSync(fresh, Buffer.concat([Buffer.from([0, 255, 1]), Buffer.from("anthropic.claude-fable-5-2\u0000anthropic.claude-opus-6\u0000")]));
    const run = (...args: string[]) => spawnSync(process.execPath, [join(repoRoot, "scripts", "check-models.mjs"), ...args], { encoding: "utf8" });
    const ok = run("--file", priced);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /all 2 Claude models priced/);
    const bad = run("--file", priced, "--binary", fresh);
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /1 of 2 Claude models have no price of their own in src\/pricing\.ts: claude-opus-6/);
    assert.equal(run("--file", join(dir, "missing.txt")).status, 2);
    // A page that cannot be fetched is a warning (an Actions annotation), not a failure; a model it can read still fails.
    const down = run("--url", "http://127.0.0.1:1/CHANGELOG.md", "--file", priced);
    assert.equal(down.status, 0, down.stdout + down.stderr);
    assert.match(down.stdout, /^::warning title=check-models::http:\/\/127\.0\.0\.1:1\/CHANGELOG\.md could not be fetched \(.+\); its models were not checked$/m);
    assert.match(down.stdout, /all 2 Claude models priced/);
    assert.equal(run("--url", "http://127.0.0.1:1/x", "--binary", fresh).status, 1);
    assert.equal(run("--nope").status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A model catalog in the shape Claude Code 2.1.331 reads (downloads.claude.ai/model-catalog/v1/catalog.json, version 5883, read 2026-11-24). */
function catalog(cc: string[], ccd: string[]): string {
  const surface = (ids: string[]) => ({ model_selector_state: {}, model_selector_config: [{ id: "default", models: ids.map((id) => ({ id, display_name: id })), settings_vocabulary: {}, provider_alias_targets: {} }] });
  return JSON.stringify({ schema_version: 1, version: 5883, issued_at: "2026-11-24T11:23:05Z", expires_at: "2026-12-01T11:23:05Z", key_id: "k", surfaces: { cc: surface(cc), ccd: surface(ccd), chat: {} } });
}

test("H6: Claude Code's model catalog: every surface's picker ids, with the catalog's version; another shape throws", () => {
  const c = catalogModelIds(catalog(["claude-opus-5-5", "claude-haiku-4-5-20251001"], ["claude-opus-5-5", "claude-fable-5-2"]));
  assert.deepEqual(c.ids, ["claude-fable-5-2", "claude-haiku-4-5-20251001", "claude-opus-5-5"]);
  assert.equal(c.about, "catalog version 5883, issued 2026-11-24, expires 2026-12-01; surfaces cc, ccd, chat");
  assert.throws(() => catalogModelIds(JSON.stringify({ models: [] })), /no surfaces/);
  assert.throws(() => catalogModelIds("<html>"));
});

test("H6: check-models.mjs --catalog passes when every catalog id is priced and fails naming one that is not (the Desktop app's surface too)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-catalog-"));
  try {
    const run = (...args: string[]) => spawnSync(process.execPath, [join(repoRoot, "scripts", "check-models.mjs"), ...args], { encoding: "utf8" });
    // The 14 ids in catalog 5883's cc surface (2026-11-24): all priced.
    const today = ["claude-fable-5", "claude-fable-5-1", "claude-fable-5-2", "claude-haiku-4-5-20251001", "claude-haiku-5-5", "claude-opus-4-1-20250805", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-4-6", "claude-sonnet-5", "claude-sonnet-5-5"];
    const good = join(dir, "good.json");
    writeFileSync(good, catalog(today, today));
    const ok = run("--catalog", good);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /\(catalog version 5883, issued 2026-11-24, expires 2026-12-01; surfaces cc, ccd, chat\): all 14 Claude models priced/);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, catalog(today, [...today, "claude-quill-6"]));
    const no = run("--catalog", bad);
    assert.equal(no.status, 1, no.stdout + no.stderr);
    assert.match(no.stdout, /1 of 15 Claude models have no price of their own in src\/pricing\.ts: claude-quill-6/);
    // Another shape is a warning, as for a page whose layout changed; an unreadable file is exit 2.
    const odd = join(dir, "odd.json");
    writeFileSync(odd, "{}");
    const w = run("--catalog", odd);
    assert.equal(w.status, 0, w.stdout + w.stderr);
    assert.match(w.stdout, /^::warning title=check-models::.*could not be parsed \(no surfaces object\)/m);
    assert.equal(run("--catalog", join(dir, "missing.json")).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
