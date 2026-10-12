/**
 * Cold resume priced as billed: the rebuild and any re-write at the
 * session's own 5-minute/1-hour write mix (Claude Code's main thread writes
 * the 1-hour cache, at 2x input; 1.25x only when nothing records a split),
 * each request at its own model, and a forked session's copy of a resume
 * counted once in the savings report.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { coldResumeEvents, detectColdResume } from "../coldresume.js";
import { estimateSavings } from "../savings.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const HOUR = 3_600_000;
const T0 = Date.parse("2026-09-01T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

type Req = { at: number; prompt: number; write?: number; model?: string };
/** One assistant reply per request; `ttl` says how its cache writes were recorded. */
function rows(reqs: Req[], ttl: "1h" | "5m" | "none", tag = "r", pad = 0): unknown[] {
  const out: unknown[] = [{ type: "user", uuid: `${tag}-u`, timestamp: iso(reqs[0].at - 1000), message: { role: "user", content: "x".repeat(pad) || "go" } }];
  reqs.forEach((r, i) => {
    const write = Math.min(r.write ?? 0, r.prompt - 5);
    const usage: Record<string, unknown> = { input_tokens: 5, cache_read_input_tokens: r.prompt - 5 - write, cache_creation_input_tokens: write, output_tokens: 10 };
    if (ttl !== "none") usage.cache_creation = { ephemeral_5m_input_tokens: ttl === "5m" ? write : 0, ephemeral_1h_input_tokens: ttl === "1h" ? write : 0 };
    out.push({ type: "assistant", uuid: `${tag}-a${i}`, timestamp: iso(r.at), message: { id: `${tag}-m${i}`, model: r.model ?? "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "ok" }], usage } });
    out.push({ type: "user", uuid: `${tag}-n${i}`, timestamp: iso(r.at + 1000), message: { role: "user", content: "next" } });
  });
  return out;
}
function write(lines: unknown[], dir = mkdtempSync(join(tmpdir(), "cd-coldprice-")), name = "s.jsonl"): string {
  const p = join(dir, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

test("detect: the rebuild is quoted at the session's write mix, 1.25x with no recorded split", () => {
  const reqs: Req[] = [{ at: T0 - 60_000, prompt: 380_000, write: 380_000 }, { at: T0, prompt: 400_000, write: 20_000 }];
  // Opus 5.5: $4 in, $0.20 cache read.
  const oneHour = detectColdResume(write(rows(reqs, "1h")), T0 + 2 * HOUR)!;
  assert.ok(close(oneHour.resumeUsd!, (400_000 * 2 * 4) / 1e6), `1-hour writes at 2x: ${oneHour.resumeUsd}`);
  assert.ok(close(oneHour.perMessageUsd!, (400_000 * 0.2) / 1e6), "re-read at the model's own read rate");
  const unsplit = detectColdResume(write(rows(reqs, "none")), T0 + 2 * HOUR)!;
  assert.ok(close(unsplit.resumeUsd!, (400_000 * 1.25 * 4) / 1e6), `no split: 1.25x, ${unsplit.resumeUsd}`);
});

test("hook: the cold-resume notice and the expired-cache price use the session's own write mix", async () => {
  const p = write(rows([{ at: T0 - 60_000, prompt: 380_000, write: 380_000 }, { at: T0, prompt: 400_000, write: 20_000 }], "1h", "r", 300_000));
  const dir = mkdtempSync(join(tmpdir(), "cd-coldprice-hook-"));
  const out = await new Promise<string>((resolve, reject) => {
    const child = execFile(process.execPath, [cliPath, "hook"], { env: { ...process.env, CONTEXT_DOCTOR_HOOK_STATE: join(dir, "state.json") } }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    child.stdin!.end(JSON.stringify({ session_id: "coldprice-1", transcript_path: p }));
  });
  const parsed = JSON.parse(out);
  // 400k tokens written at 2x Opus 5.5's $4 input: $3.20, not the $2.00 of 1.25x.
  assert.match(parsed.systemMessage, /~\$3\.20 at list price/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /~\$3\.20 when the cache has expired/);
});

test("replay: each request at its own model, re-writes at the session's write mix", () => {
  // Opened on Haiku 4.5 ($1 in), resumed and continued on Opus 4.5 ($5 in, $0.50 read, $25 out); all writes 1-hour.
  const reqs: Req[] = [{ at: T0, prompt: 500_000, write: 500_000, model: "claude-haiku-4-5" }, { at: T0 + 2 * HOUR, prompt: 500_000, write: 500_000, model: "claude-opus-4-5" }];
  for (let i = 1; i <= 30; i++) reqs.push({ at: T0 + 2 * HOUR + i * 60_000, prompt: 500_000 + i * 2000, write: 2000, model: "claude-opus-4-5" });
  const [e] = coldResumeEvents(write(rows(reqs, "1h")));
  assert.equal(e.messagesAfter, 30);
  const saved = 30 * 455_000 * 0.5;
  const cost = 500_000 * 0.5 + 8000 * 25 + 2 * 45_000 * 5;
  assert.ok(close(e.netUsd, (saved - cost) / 1e6), `${e.netUsd} vs ${(saved - cost) / 1e6}`);
});

test("savings: a forked session's copy of a cold resume is counted once", () => {
  const t0 = Date.now() - 3 * 86_400_000;
  const parentReqs: Req[] = [{ at: t0, prompt: 300_000, write: 300_000 }, { at: t0 + 2 * HOUR, prompt: 300_000, write: 300_000 }];
  for (let i = 1; i <= 12; i++) parentReqs.push({ at: t0 + 2 * HOUR + i * 60_000, prompt: 300_000 + i * 1000, write: 1000 });
  const parentRows = rows(parentReqs, "1h", "p");
  const forkStart = t0 + 2 * HOUR + 20 * 60_000; // minutes after the parent's last reply: warm, no resume of its own
  const forkReqs: Req[] = Array.from({ length: 12 }, (_, i) => ({ at: forkStart + i * 60_000, prompt: 320_000 + i * 1000, write: 1000 }));
  const d = mkdtempSync(join(tmpdir(), "cd-coldprice-fork-"));
  const parent = write(parentRows, d, "parent.jsonl");
  const fork = write([...parentRows, ...rows(forkReqs, "1h", "f").slice(1)], d, "fork.jsonl");
  assert.equal(estimateSavings(30, {}, [parent]).coldResumes, 1);
  const pair = estimateSavings(30, {}, [parent, fork]);
  assert.equal(pair.coldResumes, 1, "the fork's copy of the parent's resume is the same resume");
  assert.equal(estimateSavings(30, {}, [fork, parent]).coldResumes, 1, "whichever file comes first");
});
