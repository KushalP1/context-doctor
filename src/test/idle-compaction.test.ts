/**
 * Claude Code's native idle compaction (2.1.290+) and SessionStart's resume
 * verdict. Pinned: the cold-resume offer is silent after an idle compaction
 * and when Claude Code is about to compact the prompt itself; it uses
 * Claude Code's own verdict and price on a resume; `compactions` and
 * `compact-window` tell idle compactions apart, and the replay keeps a
 * simulated session that idle compaction would not have touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { autoCompactsAt, detectColdResume, idleCompactMinTokens, IDLE_COMPACT_NOTICE, resumeVerdict, withResumeVerdict } from "../coldresume.js";
import { compactionQuality, renderCompactionQuality } from "../compactquality.js";
import { estimateCompactWindows, renderCompactWindows } from "../compactwindow.js";
import { sandboxEnv } from "./sandbox.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const HOUR = 3_600_000;
const T0 = Date.parse("2026-09-01T10:00:00Z");

const reply = (at: number, prompt: number, i: number, model = "claude-opus-5") => ({
  type: "assistant", timestamp: new Date(at).toISOString(),
  message: { id: `m${i}`, model, content: [{ type: "text", text: "ok" }], usage: { input_tokens: 5, cache_read_input_tokens: prompt - 5, cache_creation_input_tokens: 0, output_tokens: 10 } },
});
const prompt = (at: number, text = "next") => ({ type: "user", timestamp: new Date(at).toISOString(), message: { role: "user", content: text } });
/** What 2.1.299 writes when it compacts a quiet session: boundary (trigger "auto"), summary, notice. */
const idleCompaction = (at: number, uuid = "b-idle") => [
  { type: "system", subtype: "compact_boundary", uuid, timestamp: new Date(at).toISOString(), content: "Conversation compacted", compactMetadata: { trigger: "auto", preTokens: 400_000 } },
  { type: "user", isCompactSummary: true, timestamp: new Date(at).toISOString(), message: { role: "user", content: "This session is being continued..." } },
  { type: "system", subtype: "informational", level: "notice", timestamp: new Date(at + 10).toISOString(), content: "Compacted while idle, before the prompt cache expired" },
];

function write(rows: unknown[], pad = 0): string {
  const dir = mkdtempSync(join(tmpdir(), "cd-idle-"));
  const p = join(dir, "s.jsonl");
  writeFileSync(p, [prompt(T0 - 1000, "x".repeat(pad)), ...rows].map((l) => JSON.stringify(l)).join("\n"));
  return p;
}

function runHook(home: string, input: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [cliPath, "hook"], { env: { ...sandboxEnv(home), CONTEXT_DOCTOR_HOOK_STATE: join(home, "state.json") } }, (err, out) => (err ? reject(err) : resolve(out)));
    child.stdin!.end(JSON.stringify(input));
  });
}

test("the notice text is the one in the binary, and the minimum follows the environment as Claude Code reads it", () => {
  assert.equal(IDLE_COMPACT_NOTICE, "Compacted while idle");
  assert.equal(idleCompactMinTokens({}), 200_000);
  assert.equal(idleCompactMinTokens({ CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: "150000" }), 150_000);
  assert.equal(idleCompactMinTokens({ CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: "20000" }), 100_000, "floored at 100k");
});

test("no cold-resume offer after an idle compaction, however long the session then sits", () => {
  const p = write([reply(T0, 400_000, 0), ...idleCompaction(T0 + 54 * 60_000)]);
  assert.equal(detectColdResume(p, T0 + 5 * HOUR), undefined);
  // Without the compaction, the same session is a cold resume.
  assert.ok(detectColdResume(write([reply(T0, 400_000, 0)]), T0 + 5 * HOUR));
});

test("what idle compaction skips is still offered: a 5-minute cache, and a session under its threshold", () => {
  const fiveMin = { ...reply(T0, 180_000, 0), message: { ...reply(T0, 180_000, 0).message, usage: { input_tokens: 5, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 79_995, cache_creation: { ephemeral_5m_input_tokens: 79_995, ephemeral_1h_input_tokens: 0 }, output_tokens: 10 } } };
  const c = detectColdResume(write([fiveMin]), T0 + 20 * 60_000);
  assert.ok(c, "20 minutes on a 5-minute cache is cold; idle compaction never acts on it");
  assert.ok(c!.tokens < idleCompactMinTokens({}), "and 180k is under idle compaction's 200k");
});

test("Claude Code compacting this prompt itself: no offer at its window, an offer below it", () => {
  const home = mkdtempSync(join(tmpdir(), "cd-idle-home-"));
  assert.equal(autoCompactsAt("claude-opus-5", home, {}), 1_000_000);
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ autoCompactWindow: 400_000 }));
  assert.equal(autoCompactsAt("claude-opus-5", home, {}), 400_000, "the autoCompactWindow setting");
  assert.equal(autoCompactsAt("claude-opus-5", home, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300000" }), 300_000, "the environment wins");
  assert.equal(autoCompactsAt("claude-opus-5", home, { DISABLE_AUTO_COMPACT: "1" }), undefined, "auto-compaction off: it never compacts by itself");
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ autoCompactEnabled: false }));
  assert.equal(autoCompactsAt("claude-opus-5", home, {}), undefined);
});

test("hook: silent on a cold session past a smaller auto-compact window (Claude Code compacts it first), offers below it", async () => {
  const small = mkdtempSync(join(tmpdir(), "cd-idle-hook-"));
  mkdirSync(join(small, ".claude"));
  writeFileSync(join(small, ".claude", "settings.json"), JSON.stringify({ autoCompactWindow: 300_000 }));
  const p = write([reply(T0, 400_000, 0)], 300_000);
  assert.equal((await runHook(small, { session_id: "past", transcript_path: p, hook_event_name: "UserPromptSubmit" })).trim(), "");
  const home = mkdtempSync(join(tmpdir(), "cd-idle-hook-"));
  const note = await runHook(home, { session_id: "below", transcript_path: p, hook_event_name: "UserPromptSubmit" });
  assert.match(note, /longer than the prompt cache lasts/);
  assert.match(note, /if the conversation was compacted just before this message, say nothing about it/);
});

test("SessionStart on a resume: Claude Code's 'still warm' silences the offer; its price replaces list price", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-idle-ss-"));
  const p = write([reply(T0, 400_000, 0)], 300_000);
  const secs = Math.round((Date.now() - T0) / 1000);
  const ss = (sid: string, expired: boolean) => runHook(home, { session_id: sid, transcript_path: p, hook_event_name: "SessionStart", source: "resume", seconds_since_last_response: secs, context_tokens: 400_010, prompt_cache_likely_expired: expired, estimated_cache_write_usd: 4.0123 });
  assert.equal((await ss("warm", false)).trim(), "", "SessionStart itself prints nothing");
  assert.equal((await runHook(home, { session_id: "warm", transcript_path: p, hook_event_name: "UserPromptSubmit" })).trim(), "");
  await ss("cold", true);
  const out = JSON.parse(await runHook(home, { session_id: "cold", transcript_path: p, hook_event_name: "UserPromptSubmit" }));
  assert.match(out.systemMessage, /~\$4\.01 by Claude Code's estimate/);
});

test("a resume verdict: matched by reply time, a warm one lapses after five minutes, startups are ignored", () => {
  const now = T0 + 2 * HOUR;
  const v = resumeVerdict({ hook_event_name: "SessionStart", source: "resume", seconds_since_last_response: 7200, prompt_cache_likely_expired: false }, now)!;
  assert.equal(v.replyAt, T0);
  const c = { idleMs: 2 * HOUR, tokens: 400_000, lastReplyAt: T0 };
  assert.equal(withResumeVerdict(c, v, now + 60_000), undefined, "warm a minute later: no offer");
  assert.equal(withResumeVerdict(c, v, now + 10 * 60_000), c, "ten minutes later the transcript decides again");
  const other = { ...c, lastReplyAt: T0 + HOUR };
  assert.equal(withResumeVerdict(other, v, now), other, "another idle period: not this verdict");
  assert.equal(resumeVerdict({ hook_event_name: "SessionStart", source: "startup" }), undefined);
});

test("compactions: an idle compaction is counted and named as one", () => {
  const rows: unknown[] = [];
  const start = Date.now() - 2 * 86_400_000;
  for (let i = 0; i < 8; i++) rows.push(reply(start + i * 60_000, 300_000 + i * 1000, i), prompt(start + i * 60_000 + 1000));
  rows.push(...idleCompaction(start + 70 * 60_000));
  for (let i = 8; i < 16; i++) rows.push(prompt(start + 3 * HOUR + i * 60_000 - 1000), reply(start + 3 * HOUR + i * 60_000, 80_000 + i * 1000, i));
  const q = compactionQuality(30, [write(rows)]);
  assert.equal(q.compactions, 1);
  assert.equal(q.idle, 1);
  assert.match(renderCompactionQuality(q, 30), /1 of them were Claude Code's idle compactions/);
});

test("compact-window: a session the smaller window kept under the idle threshold keeps its context through the real idle compaction", () => {
  const start = Date.now() - 2 * 86_400_000;
  const rows: unknown[] = [];
  // 30 warm requests growing to ~450k, an idle compaction, then 30 more from ~80k.
  for (let i = 0; i < 30; i++) rows.push(reply(start + i * 60_000, 160_000 + i * 10_000, i));
  const idleAt = start + 30 * 60_000 + 54 * 60_000;
  const after: unknown[] = [];
  for (let i = 30; i < 60; i++) after.push(reply(idleAt + 2 * HOUR + i * 60_000, 80_000 + (i - 30) * 3_000, i));
  const withNotice = write([...rows, ...idleCompaction(idleAt), ...after]);
  const asAuto = write([...rows, ...idleCompaction(idleAt).slice(0, 2), ...after]);
  const a = estimateCompactWindows([200_000], 30, [withNotice]);
  const b = estimateCompactWindows([200_000], 30, [asAuto]);
  assert.equal(a.actualCompactions, 1);
  assert.equal(a.idleCompactions, 1);
  assert.equal(b.idleCompactions, 0);
  // The 200k window compacts at 194k and leaves ~75k-190k, under idle
  // compaction's 200k: the simulated session is not compacted there, so it
  // carries more context afterwards and saves less than a snap would claim.
  assert.ok(a.estimates[0].savedUsd < b.estimates[0].savedUsd, `${a.estimates[0].savedUsd} vs ${b.estimates[0].savedUsd}`);
  assert.match(renderCompactWindows(a), /1 while idle/);
});

test("the plugin declares the SessionStart hook", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const manifest = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
  assert.match(manifest.hooks.SessionStart[0].hooks[0].command, /dist\/cli\.js" hook$/);
});
