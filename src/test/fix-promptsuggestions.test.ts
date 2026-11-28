/**
 * J5: prompt suggestions as a `fix` lever. A fixture session whose Claude
 * Code cost record counts two suggestions' instructions beyond the
 * transcript (2 x 506 input tokens) after two turn ends: the lever's dollars
 * by hand; `promptSuggestionEnabled: false` applied and undone byte for byte
 * in a temporary home; a value already set is the user's; what would
 * override it is named; and what it saved since.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFix, fixOverrides, measurePromptSuggestions, overlaps, planFixes, promptSuggestionsSavedSince, promptSuggestionsState, readFixRecords, renderFixPlan, savedSince, undoFixes, type FixInputs } from "../fix.js";
import { clearScanMemo } from "../scan.js";
import { withSandboxHome } from "./sandbox.js";

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const SID = "f1000000-0000-4000-8000-00000000j501";
const iso = (t: number) => new Date(t).toISOString();
const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

// A turn's end: 2 input, 300k read, 900 written at 1 hour, 145 out. Under 10k with its input and output, so a suggestion may follow.
const END_USAGE = { input_tokens: 2, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 900, cache_creation: { ephemeral_1h_input_tokens: 900, ephemeral_5m_input_tokens: 0 }, output_tokens: 145 };
// By hand, each suggestion (sidecost.ts): 506 input at $4, the turn's whole prompt (2 + 300,000 + 900) read at $0.20, its 145-token reply
// written at 1 hour ($8), 15 output at $20 (Opus 5.5, per million).
const ONE = (506 * 4 + 300_902 * 0.2 + 145 * 8 + 15 * 20) / 1e6;

function writeSession(home: string, opts: { room: number; t0?: number; costState?: boolean; name?: string }): string {
  const dir = join(home, ".claude", "projects", "-work-app");
  mkdirSync(dir, { recursive: true });
  const t0 = opts.t0 ?? NOW - 2 * 3_600_000;
  const sid = opts.name ?? SID;
  const end = (at: number, id: string) => ({ type: "assistant", uuid: `a-${id}`, sessionId: sid, timestamp: iso(at), version: "2.1.331", entrypoint: "claude-desktop", message: { id, model: "claude-opus-5-5", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: END_USAGE } });
  const rows: unknown[] = [
    { type: "user", uuid: "u-0", sessionId: sid, timestamp: iso(t0), message: { role: "user", content: "go" } },
    end(t0 + 1000, `msg_${sid}_1`),
    { type: "user", uuid: "u-1", sessionId: sid, timestamp: iso(t0 + 50_000), message: { role: "user", content: "more" } },
    end(t0 + 60_000, `msg_${sid}_2`),
  ];
  if (opts.costState !== false) {
    rows.push({
      type: "cost-state", sessionId: sid, totalCostUSD: 1, startTime: t0 - 500,
      // Two requests' input as ours counts it (2 each), and `room` suggestions' instructions beyond it.
      modelUsage: { "claude-opus-5-5": { inputTokens: 4 + opts.room * 506, outputTokens: 290, cacheReadInputTokens: 600_000, cacheCreationInputTokens: 1800, cacheCreationEphemeral1hInputTokens: 1800, cacheCreationEphemeral5mInputTokens: 0, webSearchRequests: 0, costUSD: 1 } },
    });
  }
  const path = join(dir, `${sid}.jsonl`);
  writeFileSync(path, jsonl(rows));
  utimesSync(path, (t0 + 120_000) / 1000, (t0 + 120_000) / 1000);
  return path;
}

async function inHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "cd-j5-"));
  const real = Date.now;
  const saved = process.env.CONTEXT_DOCTOR_CACHE_DIR;
  process.env.CONTEXT_DOCTOR_CACHE_DIR = join(home, ".cache-cd");
  Date.now = () => NOW;
  clearScanMemo();
  try {
    return await withSandboxHome(home, () => fn(home));
  } finally {
    Date.now = real;
    if (saved === undefined) delete process.env.CONTEXT_DOCTOR_CACHE_DIR;
    else process.env.CONTEXT_DOCTOR_CACHE_DIR = saved;
    clearScanMemo();
    rmSync(home, { recursive: true, force: true });
  }
}

const base: FixInputs = { days: 30, billedUsd: 1000 };

test("the lever's dollars by hand: as many suggestions as Claude Code's extra input has room for, each priced as the turn it followed", async () => {
  await inHome((home) => {
    writeSession(home, { room: 2 });
    const est = measurePromptSuggestions(30, NOW);
    assert.deepEqual({ n: est.n, turnEnds: est.turnEnds, sessions: est.sessions, compared: est.compared }, { n: 2, turnEnds: 2, sessions: 1, compared: 1 });
    near(est.usd, 2 * ONE, "two suggestions");
  });
  // Room for one of the two turn ends: half of them, priced at their average.
  await inHome((home) => {
    writeSession(home, { room: 1 });
    const est = measurePromptSuggestions(30, NOW);
    assert.equal(est.n, 1);
    near(est.usd, ONE, "one suggestion");
  });
  // No cost record: nothing counted, nothing guessed.
  await inHome((home) => {
    writeSession(home, { room: 2, costState: false });
    const est = measurePromptSuggestions(30, NOW);
    assert.deepEqual(est, { n: 0, usd: 0, turnEnds: 0, sessions: 0, compared: 0 });
  });
});

test("the plan offers it with its quality line, among the fixes that cost nothing in quality, and names what overlaps", () => {
  const sg = { n: 390, usd: 30.02, turnEnds: 1200, sessions: 23, compared: 71 };
  const [f] = planFixes({ ...base, promptSuggestions: sg });
  assert.equal(f.id, "prompt-suggestions");
  assert.equal(f.state, "available");
  assert.equal(f.savedUsd, 30.02);
  assert.equal(f.value, false);
  assert.equal(f.quality, "the grey suggested next message goes away; nothing else changes");
  assert.equal(f.qualityFree, true);
  assert.match(f.basis, /about 390 suggestions in 23 sessions/);
  assert.match(f.basis, /an estimate/);
  assert.match(f.change, /promptSuggestionEnabled = false/);
  // No Claude Code install is named as too old: the key is in every binary checked.
  const old = planFixes({ ...base, promptSuggestions: sg, claudeCodeInstalls: [{ path: "/x/claude", version: "2.1.62", source: "cli" }] });
  assert.equal(old[0].tooOld, undefined);
  // Under a dollar: not offered.
  assert.deepEqual(planFixes({ ...base, promptSuggestions: { ...sg, usd: 0.4 } }), []);
  const text = renderFixPlan(30, 1000, [f], []);
  assert.match(text, /Prompt suggestions off\s+\$30\.02/);
  assert.match(text, /\[prompt-suggestions\]/);
  const cw = planFixes({ ...base, promptSuggestions: sg, compactWindow: { window: 400_000, savedUsd: 500, savedShare: 0.5, compactionsPerWeek: 9, nowPerWeek: 3 } });
  assert.deepEqual(overlaps(cw), ["prompt-suggestions and compact-window: each suggestion re-reads the conversation, which compacting earlier keeps smaller."]);
});

test("a value already there is the user's: off is applied, on is left alone; the variable read as true, or a project's key, overrides", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-j5-state-"));
  const cwd = join(home, "proj");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  const env = { HOME: home, USERPROFILE: home } as NodeJS.ProcessEnv;
  try {
    assert.deepEqual(promptSuggestionsState({ home, cwd, env }), {});
    const off = promptSuggestionsState({ home, cwd, env: { ...env, CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false" } }).set!;
    assert.equal(off.off, true);
    const applied = planFixes({ ...base, promptSuggestions: { n: 10, usd: 5, turnEnds: 10, sessions: 1, compared: 1 }, promptSuggestionsSet: off });
    assert.equal(applied[0].state, "applied");
    writeFileSync(join(home, ".claude", "settings.json"), '{ "promptSuggestionEnabled": true }\n');
    const mine = promptSuggestionsState({ home, cwd, env }).set!;
    assert.deepEqual({ value: mine.value, off: mine.off }, { value: "true", off: false });
    const left = planFixes({ ...base, promptSuggestions: { n: 10, usd: 5, turnEnds: 10, sessions: 1, compared: 1 }, promptSuggestionsSet: mine });
    assert.equal(left[0].state, "not-here");
    assert.match(left[0].note!, /left as you set it \(they cost about \$5\.00 in 30 days, an estimate\)/);
    // Overrides: the variable read as true wins over the setting; so does a project's key.
    assert.deepEqual(fixOverrides("prompt-suggestions", { home, cwd, env }), []);
    assert.match(fixOverrides("prompt-suggestions", { home, cwd, env: { ...env, CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "1" } }).join(), /CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1/);
    writeFileSync(join(cwd, ".claude", "settings.json"), '{ "promptSuggestionEnabled": true }\n');
    assert.match(fixOverrides("prompt-suggestions", { home, cwd, env }).join(), /promptSuggestionEnabled true in .*proj/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("--apply then undo leaves settings.json byte for byte; with no settings.json, undo removes the file it made", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-j5-rt-"));
  try {
    mkdirSync(join(home, ".claude"));
    const settings = join(home, ".claude", "settings.json");
    const original = '{\r\n\t"model": "opus",\r\n\t"theme": "caf\\u00e9",\r\n\t"env": { "A": "1" }\r\n}\r\n';
    writeFileSync(settings, original);
    const [f] = planFixes({ ...base, promptSuggestions: { n: 2, usd: 2, turnEnds: 4, sessions: 1, compared: 1 } });
    const r = await applyFix(f, { home, now: 1_000, env: { HOME: home } }, { suggestedShare: 0.5 });
    assert.equal(r.ok, true, r.lines.join("\n"));
    assert.equal(JSON.parse(readFileSync(settings, "utf8")).promptSuggestionEnabled, false);
    const [rec] = readFixRecords(home);
    assert.deepEqual({ id: rec.id, value: rec.value, hadPrevious: rec.hadPrevious, suggestedShare: rec.suggestedShare }, { id: "prompt-suggestions", value: false, hadPrevious: false, suggestedShare: 0.5 });
    // Applying again changes nothing.
    assert.match((await applyFix(f, { home, now: 2_000, env: { HOME: home } })).lines[0], /already false/);
    await undoFixes(undefined, { home });
    assert.equal(readFileSync(settings, "utf8"), original);
    assert.deepEqual(readFixRecords(home), []);
    // No settings.json before: undo takes away the one apply made.
    rmSync(settings);
    assert.equal((await applyFix(f, { home, now: 3_000, env: { HOME: home } })).ok, true);
    assert.ok(existsSync(settings));
    await undoFixes(["prompt-suggestions"], { home });
    assert.ok(!existsSync(settings));
    // The user's own true is refused, not overwritten.
    writeFileSync(settings, '{"promptSuggestionEnabled":true}');
    const refused = await applyFix(f, { home, now: 4_000, env: { HOME: home } });
    assert.equal(refused.ok, false);
    assert.equal(readFileSync(settings, "utf8"), '{"promptSuggestionEnabled":true}');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("since: the turn ends after it was applied, at the share that sent a suggestion before", async () => {
  await inHome((home) => {
    const at = NOW - 3 * 3_600_000;
    const path = writeSession(home, { room: 0, t0: NOW - 2 * 3_600_000, costState: false });
    const s = promptSuggestionsSavedSince(at, 0.5, [path]);
    assert.equal(s.turnEnds, 2);
    near(s.usd, 0.5 * 2 * ONE, "half of two");
    const [r] = savedSince([{ id: "prompt-suggestions", at, value: false, suggestedShare: 0.5 }], { paths: [path] });
    near(r.savedUsd!, ONE, "since");
    assert.match(r.detail, /2 turn ends since, 50% of which sent a suggestion before/);
    assert.equal(savedSince([{ id: "prompt-suggestions", at: NOW, value: false, suggestedShare: 0.5 }], { paths: [path] })[0].detail, "no turn ended since");
  });
});
