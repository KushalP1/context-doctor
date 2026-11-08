/**
 * compact-window: Claude Code's native autoCompactWindow setting, measured on
 * the user's own history. Pinned: size parsing, the settings round trip
 * (other settings untouched, backup kept), and the replay on a known session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentCompactWindow, estimateCompactWindows, parseWindow, renderCompactWindows, setCompactWindow } from "../compactwindow.js";

test("parseWindow understands 400k, 0.4m and plain numbers", () => {
  assert.equal(parseWindow("400k"), 400_000);
  assert.equal(parseWindow("0.4m"), 400_000);
  assert.equal(parseWindow("250000"), 250_000);
  assert.equal(parseWindow("lots"), undefined);
});

test("set and remove autoCompactWindow without touching other settings", () => {
  const home = mkdtempSync(join(tmpdir(), "cd-acw-"));
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark", hooks: { Stop: [] } }));
  setCompactWindow(400_000, home);
  const after = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(after, { theme: "dark", hooks: { Stop: [] }, autoCompactWindow: 400_000 });
  assert.ok(existsSync(join(home, ".claude", "settings.json.context-doctor.backup")));
  assert.equal(currentCompactWindow(home), 400_000);
  setCompactWindow(undefined, home);
  assert.equal(currentCompactWindow(home), undefined);
  assert.throws(() => setCompactWindow(50_000, home), /between/);
});

test("replay: a session growing to 900k saves with a 400k window and compacts where expected", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-acw-replay-"));
  const p = join(dir, "s.jsonl");
  const start = Date.now() - 86_400_000;
  const lines: unknown[] = [];
  // 60 requests, one a minute (warm cache), context growing 100k -> ~900k.
  for (let i = 0; i < 60; i++) {
    const prompt = 100_000 + i * 13_500;
    lines.push({ type: "assistant", timestamp: new Date(start + i * 60_000).toISOString(), message: { id: `m${i}`, model: "claude-opus-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 5, cache_read_input_tokens: prompt - 5, cache_creation_input_tokens: 0, output_tokens: 10 } } });
  }
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"));
  const r = estimateCompactWindows([400_000, 1_000_000], 30, [p]);
  assert.equal(r.sessions, 1);
  const [w400, w1m] = r.estimates;
  assert.ok(w400.savedUsd > 0, "compacting at ~388k beats re-reading up to 900k");
  assert.ok(w400.compactions >= 2, `expected repeated compactions, got ${w400.compactions}`);
  assert.equal(w1m.compactions, 0, "a 1M window never triggers on a 900k session");
  assert.ok(Math.abs(w1m.savedUsd) < 1e-9, "and changes nothing");
});

test("replay: a window that keeps Haiku 5.5 prompts under 100k prices each simulated request at the lower tier", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-acw-tier-"));
  const start = Date.now() - 86_400_000;
  /** 40 requests a minute apart, context growing 60k -> ~255k, on `model`. */
  const session = (model: string) => {
    const p = join(dir, `${model}.jsonl`);
    const lines = Array.from({ length: 40 }, (_, i) => ({ type: "assistant", timestamp: new Date(start + i * 60_000).toISOString(), message: { id: `${model}-${i}`, model, content: [{ type: "text", text: "ok" }], usage: { input_tokens: 5, cache_read_input_tokens: 60_000 + i * 5_000 - 5, cache_creation_input_tokens: 0, output_tokens: 10 } } }));
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"));
    return p;
  };
  // Haiku 4.5 has one rate at every length: the share saved is the replay's alone.
  const flat = estimateCompactWindows([100_000], 30, [session("claude-haiku-4-5")]).estimates[0];
  // Haiku 5.5 bills a prompt over 100k at 5x (Anthropic's page, read 2026-11-08): compacting under it saves that too.
  const tiered = estimateCompactWindows([100_000], 30, [session("claude-haiku-5-5")]).estimates[0];
  assert.ok(flat.compactions > 0 && tiered.compactions === flat.compactions, "the same compactions");
  assert.ok(tiered.savedPct > flat.savedPct + 0.2, `the tier's saving counted: ${tiered.savedPct} vs ${flat.savedPct}`);
  // As billed: the 28 requests over 100k at $0.05 a million read, the rest at $0.01.
  const reads = Array.from({ length: 40 }, (_, i) => 60_000 + i * 5_000 - 5);
  const billed = reads.reduce((s, r) => s + (r + 5 > 100_000 ? 5 * 0.5 + r * 0.05 : 5 * 0.1 + r * 0.01), 0) / 1e6;
  assert.ok(Math.abs(tiered.baselineUsd - billed) < 1e-9, `${tiered.baselineUsd} vs ${billed}`);
});

test("render: the current window is shown even with no history to replay", () => {
  const empty = estimateCompactWindows([400_000], 30, []);
  const text = renderCompactWindows(empty, 250_000);
  assert.match(text, /Now: 250k/);
  assert.match(text, /No sessions with 10\+ requests/);
  assert.match(renderCompactWindows(empty), /Now: not set/);
  // The file it is set in follows CLAUDE_CONFIG_DIR, as Claude Code does.
  const dir = mkdtempSync(join(tmpdir(), "cd-cw-config-"));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    assert.ok(renderCompactWindows(empty, 250_000).includes(`Now: 250k (set in ${join(dir, "settings.json")})`), renderCompactWindows(empty, 250_000));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});
