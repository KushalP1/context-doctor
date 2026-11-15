/**
 * The limits per weekly reset (ROADMAP F4): dollars and tokens per 1% of each
 * window, a planted 5x move found and dated, the split by entrypoint, a plan
 * with no 5-hour window (Ultra) everywhere the readings pass, the paste
 * block with nothing private in it, and the proxy as a recorder.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  HOW_TO_RECORD, limitsByReset, limitsReport, rateLimitsFromHeaders, readClaudeReadings, recordLimits, renderLimits, renderLimitsReport, reportModel, resetWindowsOf, slopeChanges,
  type LimitReading, type UsagePoint,
} from "../limits.js";
import { modMeasure, statusLineRateLimits } from "../modmeasure.js";
import { startProxy } from "../proxy.js";
import { sandboxEnv, withSandboxHome } from "./sandbox.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR, WEEK = 7 * DAY;
const T0 = Date.parse("2026-10-20T08:00:00Z");

interface WindowSpec {
  /** API-equivalent dollars per 1% of the week, per entrypoint (a key missing: the first's). */
  usdPerPct: number;
  version?: string;
  /** From this stretch on, 1% costs this instead (a move inside the window). */
  changeAt?: { stretch: number; usdPerPct: number };
}

/**
 * Weekly windows back to back from `start`: in each, `stretches` half-hours of
 * use (three requests each, $3-$15 a stretch), a reading after each in 0.1%
 * steps, the % rising by each stretch's dollars over the window's $ per 1%
 * (times `drain` for an entrypoint that drains faster), with noise.
 */
function weeks(specs: WindowSpec[], o: { start?: number; stretches?: number; noise?: number; seed?: number; entrypoints?: Record<string, number>; model?: string; cacheReadOnly?: boolean } = {}) {
  const start = o.start ?? T0, stretches = o.stretches ?? 40, noise = o.noise ?? 0.05;
  const eps = Object.entries(o.entrypoints ?? { "claude-desktop": 1 });
  let seed = o.seed ?? 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const readings: LimitReading[] = [];
  const usage: UsagePoint[] = [];
  specs.forEach((w, k) => {
    const ws = start + k * WEEK, reset = ws + WEEK;
    let t = ws + HOUR, pct = 0;
    const read = () => readings.push({ ts: t, app: "claude", window: "seven_day", pct: Math.round(pct * 10) / 10, resetsAt: reset, windowMs: WEEK, source: "mod" });
    read();
    for (let s = 0; s < stretches; s++) {
      const rate = w.changeAt && s >= w.changeAt.stretch ? w.changeAt.usdPerPct : w.usdPerPct;
      let rise = 0;
      for (let i = 0; i < 3; i++) {
        const usd = 1 + 4 * rand();
        const [ep, drain] = eps[Math.floor(rand() * eps.length)];
        // cacheReadOnly: tokens Opus 5.5 prices at exactly `usd` ($0.20 per 1M cache reads), for transcripts priced by requestCost.
        const tok = o.cacheReadOnly ? { input: 0, read: Math.round((usd / 0.2) * 1e6), write: 0, output: 0 } : { input: 1000, read: Math.round(usd * 400_000), write: 10_000, output: 2_000 };
        usage.push({ ts: t + (5 + 5 * i) * MIN, app: "claude", model: o.model ?? "claude-opus-5-5", ...tok, usd, entrypoint: ep, version: w.version ?? "2.1.321" });
        rise += (usd / rate) * drain;
      }
      pct += rise * (1 + noise * (rand() - 0.5));
      t += 30 * MIN;
      read();
    }
  });
  return { readings, usage };
}

test("a planted 5x move at a reset is found, dated at that reset and reported; the steady windows are not", () => {
  // Four weekly windows (three resets): $25 per 1% for two, then $5 from the reset of 2026-11-03 08:00 UTC.
  const { readings, usage } = weeks([{ usdPerPct: 25 }, { usdPerPct: 25 }, { usdPerPct: 5, version: "2.1.325" }, { usdPerPct: 5, version: "2.1.325" }]);
  const now = T0 + 4 * WEEK - DAY;
  const ws = resetWindowsOf(readings, usage, { now });
  assert.equal(ws.length, 4);
  for (const [i, want] of [25, 25, 5, 5].entries()) {
    assert.ok(Math.abs(ws[i].usdPerPct! - want) / want < 0.08, `window ${i}: $${ws[i].usdPerPct} per 1%, want $${want}`);
    assert.equal(ws[i].why, undefined, ws[i].why);
    assert.ok(ws[i].relSe! < 0.05, String(ws[i].relSe));
  }
  assert.equal(ws[3].current, true);
  assert.equal(ws[0].start, T0);
  assert.ok(ws[2].tokensPerPct! < ws[0].tokensPerPct! / 4, "tokens per 1% move with it");
  const changes = slopeChanges(ws, usage, readings);
  assert.equal(changes.length, 1, JSON.stringify(changes));
  const c = changes[0];
  assert.equal(c.kind, "reset");
  assert.equal(c.at, Date.parse("2026-11-03T08:00:00Z"));
  assert.ok(Math.abs(c.factor - 0.2) < 0.03, String(c.factor));
  assert.deepEqual([c.versionsBefore, c.versionsAfter], [["2.1.321"], ["2.1.325"]]);

  const report = { days: 30, now, claudeLog: "x", claudeReadings: readings.length, codexReadings: 0, windows: [], fits: [], resets: ws, changes, claudeWindows: ["seven_day"], claudeSources: { mod: readings.length } };
  const block = renderLimitsReport(report);
  assert.match(block, /at the reset of 2026-11-03 08:00 UTC: 1% went from \$2\d\.\d\d to \$[45]\.\d\d of API-equivalent use \(5\.\dx less use per 1%: the limit drains faster\)/);
  assert.match(block, /Claude Code 2\.1\.321 before, 2\.1\.325 after/);
  assert.match(block, /| Claude 2026-10-20 to 2026-10-27 | /);
  assert.match(block, /weekly only \(no 5-hour window in the readings\)/);
  assert.match(block, /Claude Code versions: 2\.1\.321, 2\.1\.325/);
  assert.match(renderLimits(report), /What 1% buys moved:\n  Claude weekly, at the reset of 2026-11-03 08:00 UTC/);
});

test("steady windows with noise report no move; a 5x move inside a window is dated at its stretch", () => {
  const steady = weeks([{ usdPerPct: 20 }, { usdPerPct: 21 }, { usdPerPct: 19 }], { noise: 0.3, seed: 3 });
  const sw = resetWindowsOf(steady.readings, steady.usage, { now: T0 + 3 * WEEK });
  assert.deepEqual(slopeChanges(sw, steady.usage, steady.readings), []);
  assert.match(renderLimits({ days: 30, now: T0 + 3 * WEEK, claudeLog: "x", claudeReadings: 1, codexReadings: 0, windows: [], fits: [], resets: sw, changes: [], claudeWindows: ["seven_day"], claudeSources: {} }), /held steady/);

  // claude-code#108272: 1% from ~$30 to ~$6 within one week.
  const inside = weeks([{ usdPerPct: 30, changeAt: { stretch: 24, usdPerPct: 6 } }], { seed: 5 });
  const iw = resetWindowsOf(inside.readings, inside.usage, { now: T0 + 2 * DAY });
  const moves = slopeChanges(iw, inside.usage, inside.readings);
  assert.equal(moves.length, 1, JSON.stringify(moves));
  assert.equal(moves[0].kind, "within");
  const planted = T0 + HOUR + 24 * 30 * MIN;
  assert.ok(Math.abs(moves[0].at - planted) <= 30 * MIN, `${new Date(moves[0].at).toISOString()} against ${new Date(planted).toISOString()}`);
  assert.ok(Math.abs(moves[0].factor - 0.2) < 0.04, String(moves[0].factor));
});

test("the split by entrypoint finds `claude -p` draining 1.8x per dollar, where the stretches tell them apart", () => {
  const { readings, usage } = weeks([{ usdPerPct: 25 }], { stretches: 60, noise: 0.05, entrypoints: { cli: 1, "sdk-cli": 1.8 } });
  const [w] = resetWindowsOf(readings, usage, { now: T0 + DAY });
  const by = Object.fromEntries(w.byEntrypoint.map((e) => [e.key, e]));
  assert.ok(by.cli && by["sdk-cli"], JSON.stringify(w.byEntrypoint));
  assert.ok(Math.abs(by.cli.usdPerPct! - 25) / 25 < 0.2, String(by.cli.usdPerPct));
  const ratio = by.cli.usdPerPct! / by["sdk-cli"].usdPerPct!;
  assert.ok(Math.abs(ratio - 1.8) < 0.4, String(ratio));
  const block = renderLimitsReport({ days: 30, now: T0 + DAY, claudeLog: "x", claudeReadings: readings.length, codexReadings: 0, windows: [], fits: [], resets: [w], changes: [], claudeWindows: ["seven_day", "five_hour"], claudeSources: {} });
  assert.match(block, /by entrypoint: sdk-cli \$1\d\.\d\d ±\d+%, cli \$2\d\.\d\d ±\d+% per 1% \(sdk-cli drains 1\.\dx per dollar against cli\)/);
  assert.match(block, /Claude windows read: weekly and 5-hour/);
  // A thin window gets no figure, and says why.
  const thin = weeks([{ usdPerPct: 25 }], { stretches: 2 });
  const [tw] = resetWindowsOf(thin.readings, thin.usage, { now: T0 + DAY });
  assert.equal(tw.usdPerPct, undefined);
  assert.match(tw.why!, /stretch/);
});

test("a model id that is a cloud resource never reaches a report", () => {
  assert.equal(reportModel("claude-opus-5-5"), "claude-opus-5-5");
  assert.equal(reportModel("claude-opus-5-5[1m]"), "claude-opus-5-5[1m]");
  assert.equal(reportModel("us.anthropic.claude-sonnet-5-v1:0"), "us.anthropic.claude-sonnet-5-v1:0");
  assert.equal(reportModel("arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc"), "custom model id");
  assert.equal(reportModel("/Users/someone/models/x"), "custom model id");
  assert.equal(reportModel(undefined), "unknown");
});

test("a plan with no 5-hour window (Ultra): the status line, the mod and the proxy write the weekly window alone, and limits reads it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-ultra-"));
  const log = join(dir, "limits.jsonl");
  // The status line's input on Ultra: rate_limits with seven_day only (or five_hour null).
  assert.equal(recordLimits({ seven_day: { used_percentage: 12.3, resets_at: T0 / 1000 + DAY / 1000 } }, T0, log, "statusline"), 1);
  assert.equal(recordLimits({ five_hour: null, seven_day: { used_percentage: 12.9, resets_at: T0 / 1000 + DAY / 1000 } }, T0 + 2 * MIN, log, "statusline"), 1);
  // The mod's: rateLimits with no five_hour kind.
  assert.deepEqual(statusLineRateLimits([{ kind: "seven_day", percentUsed: 13, resetsAt: new Date(T0 + DAY).toISOString() }]), { seven_day: { used_percentage: 13, resets_at: (T0 + DAY) / 1000 } });
  // The proxy's: only the 7d headers.
  const headers = new Map([["anthropic-ratelimit-unified-7d-utilization", "0.135"], ["anthropic-ratelimit-unified-7d-reset", String((T0 + DAY) / 1000)]]);
  assert.deepEqual(rateLimitsFromHeaders((n) => headers.get(n)), { seven_day: { used_percentage: 13.5, resets_at: (T0 + DAY) / 1000 } });
  assert.equal(rateLimitsFromHeaders(() => null), undefined);
  assert.equal(recordLimits(rateLimitsFromHeaders((n) => headers.get(n)), T0 + 4 * MIN, log, "proxy"), 1);
  const rs = readClaudeReadings(0, log);
  assert.deepEqual(rs.map((r) => [r.window, r.pct, r.source]), [["seven_day", 12.3, "statusline"], ["seven_day", 12.9, "statusline"], ["seven_day", 13.5, "proxy"]]);
  const r = limitsReport(30, { now: T0 + 5 * MIN, logPath: log, claudeOnly: true, claudePaths: [] });
  assert.deepEqual(r.claudeWindows, ["seven_day"]);
  assert.deepEqual(r.windows.map((w) => w.window), ["seven_day"]);
  assert.deepEqual(r.claudeSources, { statusline: 2, proxy: 1 });
  const text = renderLimits(r);
  assert.match(text, /Claude weekly: 14% used/);
  assert.match(text, /No 5-hour window in Claude's readings: a plan without one \(Ultra\)/);
  assert.ok(!/Claude 5-hour/.test(text));
  assert.match(renderLimitsReport(r), /Now: weekly 14%\./);
  assert.equal(limitsByReset(30, { now: T0 + 5 * MIN, logPath: log, claudeOnly: true, claudePaths: [] }).noFiveHour, true);

  // modMeasure itself, in a throwaway home: only the weekly line.
  const home = mkdtempSync(join(tmpdir(), "cd-ultra-mod-"));
  mkdirSync(join(home, ".claude"));
  await withSandboxHome(home, () => {
    modMeasure({ rateLimits: [{ kind: "seven_day", percentUsed: 40, resetsAt: new Date(T0 + DAY).toISOString() }] }, T0, {});
  });
  const lines = readFileSync(join(home, ".claude", ".context-doctor-limits.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.w, l.pct, l.src]), [["seven_day", 40, "mod"]]);

  // The status line command end to end, sandboxed.
  const home2 = mkdtempSync(join(tmpdir(), "cd-ultra-sl-"));
  mkdirSync(join(home2, ".claude"));
  const input = { model: { id: "claude-opus-5-5" }, context_window: { context_window_size: 1_000_000, current_usage: { input_tokens: 100_000 } }, rate_limits: { seven_day: { used_percentage: 41.2, resets_at: 1_900_500_000 } } };
  const sl = spawnSync(process.execPath, [cliPath, "statusline"], { input: JSON.stringify(input), env: sandboxEnv(home2), encoding: "utf8" });
  assert.equal(sl.status, 0);
  assert.match(sl.stdout, /ctx 100k/);
  const slLines = readFileSync(join(home2, ".claude", ".context-doctor-limits.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(slLines.map((l) => [l.w, l.pct, l.src]), [["seven_day", 41.2, "statusline"]]);
});

test("the proxy writes the plan's windows from Anthropic's rate-limit headers, and none when told not to", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-proxy-limits-"));
  const log = join(dir, "limits.jsonl");
  const reset = Math.round(Date.now() / 1000) + 3 * 86400;
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.setHeader("anthropic-ratelimit-unified-7d-utilization", "0.172");
      res.setHeader("anthropic-ratelimit-unified-7d-reset", String(reset));
      res.end('{"usage":{"input_tokens":1,"output_tokens":1}}');
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const proxy = startProxy({ port: 0, anthropicUpstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, limitsLogPath: log });
  await new Promise<void>((r) => proxy.once("listening", () => r()));
  const post = () => new Promise<number>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: (proxy.address() as AddressInfo).port, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }));
  });
  try {
    assert.equal(await post(), 200);
    for (let i = 0; i < 50 && !existsSync(log); i++) await new Promise((r) => setTimeout(r, 20));
    const rows = readClaudeReadings(0, log);
    assert.deepEqual(rows.map((r) => [r.window, r.pct, r.resetsAt, r.source]), [["seven_day", 17.2, reset * 1000, "proxy"]]);
    process.env.CONTEXT_DOCTOR_NO_LIMITS_LOG = "1";
    writeFileSync(log, "");
    assert.equal(await post(), 200);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(readFileSync(log, "utf8"), "");
  } finally {
    delete process.env.CONTEXT_DOCTOR_NO_LIMITS_LOG;
    proxy.close();
    upstream.close();
  }
});

test("limits with no readings says in one line how to get them, and --report says the same", () => {
  const home = mkdtempSync(join(tmpdir(), "cd-limits-none-"));
  const r = spawnSync(process.execPath, [cliPath, "limits"], { env: sandboxEnv(home), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split("\n").find((l) => l.startsWith("No limit readings yet."))!;
  assert.equal(line, `No limit readings yet. ${HOW_TO_RECORD}`);
  assert.match(line, /context-doctor install.*mod.*context-doctor autopilot on/);
  const rep = spawnSync(process.execPath, [cliPath, "limits", "--report"], { env: sandboxEnv(home), encoding: "utf8" });
  assert.equal(rep.status, 0, rep.stderr);
  assert.equal(rep.stdout.trim(), `No limit readings yet. ${HOW_TO_RECORD}`);
  const both = spawnSync(process.execPath, [cliPath, "limits", "--report", "--json"], { env: sandboxEnv(home), encoding: "utf8" });
  assert.notEqual(both.status, 0);
});

/** Claude Code transcripts holding `usage`, with prompts, a working folder, ids and an ARN model: everything a report must leave out. */
function writeTranscripts(home: string, usage: UsagePoint[], secret: { prompt: string; folder: string; sid: string }): void {
  const cwd = join(home, "work", secret.folder);
  const proj = join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(proj, { recursive: true });
  const rows: string[] = [];
  const base = (p: UsagePoint) => ({ cwd, sessionId: secret.sid, version: p.version, entrypoint: p.entrypoint, gitBranch: `feature/${secret.folder}` });
  usage.forEach((p, i) => {
    const ts = new Date(p.ts).toISOString();
    rows.push(JSON.stringify({ ...base(p), type: "user", uuid: `${secret.sid}-u${i}`, timestamp: new Date(p.ts - 2000).toISOString(), message: { role: "user", content: `${secret.prompt} ${i}` } }));
    const model = i % 50 === 7 ? "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/zz" : p.model;
    rows.push(JSON.stringify({ ...base(p), type: "assistant", uuid: `${secret.sid}-a${i}`, timestamp: ts, message: { id: `msg_${secret.sid}_${i}`, model, role: "assistant", content: [{ type: "text", text: `answer about ${secret.prompt}` }], usage: { input_tokens: p.input, cache_read_input_tokens: p.read, cache_creation_input_tokens: p.write, output_tokens: p.output } } }));
  });
  const file = join(proj, `${secret.sid}.jsonl`);
  writeFileSync(file, rows.join("\n") + "\n");
  const last = usage[usage.length - 1].ts / 1000;
  utimesSync(file, last, last);
}

test("limits --report on a real-shaped history: the move found and dated, nothing private in it", () => {
  const home = mkdtempSync(join(tmpdir(), "cd-limits-report-"));
  // Two finished weeks and the current one, ending a day from now: $20 per 1%, then $4 (5x) at the second reset.
  const now = Date.now();
  const start = Math.floor((now - 3 * WEEK + DAY) / MIN) * MIN;
  const { readings, usage } = weeks([{ usdPerPct: 20 }, { usdPerPct: 20 }, { usdPerPct: 4, version: "2.1.325" }], { start, stretches: 24, entrypoints: { "claude-desktop": 1, cli: 1 }, cacheReadOnly: true });
  const live = readings.filter((r) => r.ts <= now - HOUR);
  const used = usage.filter((p) => p.ts <= live[live.length - 1].ts);
  const secret = { prompt: "PRIVATE-PROMPT-zebra-giraffe", folder: "SECRETPROJ-acme", sid: "5f0c1d2e-aaaa-4bbb-8ccc-0123456789ab" };
  writeTranscripts(home, used, secret);
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".context-doctor-limits.jsonl"), live.map((r) => JSON.stringify({ ts: r.ts, app: "claude", w: r.window, pct: r.pct, reset: Math.round(r.resetsAt! / 1000), src: "mod" })).join("\n") + "\n");
  const env = { ...sandboxEnv(home), CONTEXT_DOCTOR_CACHE_DIR: join(home, "cache") };
  const r = spawnSync(process.execPath, [cliPath, "limits", "--report"], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const block = r.stdout;
  const reset2 = new Date(start + 2 * WEEK).toISOString().slice(0, 16).replace("T", " ");
  assert.match(block, new RegExp(`at the reset of ${reset2} UTC: 1% went from \\$(19|20|21)\\.\\d\\d to \\$[34]\\.\\d\\d`), block);
  assert.match(block, /claude-desktop \d+%, cli \d+%|cli \d+%, claude-desktop \d+%/);
  assert.match(block, /Claude Code versions: 2\.1\.321, 2\.1\.325/);
  assert.match(block, /\| Claude \d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d \| /);
  // Nothing private: no prompt or answer text, no folder or path, no session, message or row id, no account number.
  for (const bad of [secret.prompt, "zebra", secret.folder, "SECRETPROJ", secret.sid, "5f0c1d2e", "msg_", home, "feature", "123456789012", "arn:"]) {
    assert.ok(!block.includes(bad), `the report holds "${bad}"`);
  }
  assert.ok(!/[\\/]/.test(block.replace(/ \/ /g, "")), `a path-like slash in:\n${block}`);
  // The full report and --json carry the same windows.
  const json = JSON.parse(spawnSync(process.execPath, [cliPath, "limits", "--json"], { env, encoding: "utf8" }).stdout);
  assert.equal(json.resets.length, 3);
  assert.equal(json.changes.length, 1);
  assert.equal(json.changes[0].kind, "reset");
  assert.deepEqual(json.claudeWindows, ["seven_day"]);
  const text = spawnSync(process.execPath, [cliPath, "limits"], { env, encoding: "utf8" }).stdout;
  assert.match(text, /Each weekly \(or longer\) window, reset to reset: API-equivalent use per 1%/);
  assert.match(text, /No 5-hour window in Claude's readings/);
});
