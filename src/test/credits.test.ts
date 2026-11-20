/**
 * Past the plan's limit (ROADMAP G2): the API's usage-credits headers parsed
 * and kept in the limits ledger (also through the proxy), the extra-usage
 * flag read from `~/.claude.json`, requests after a window read 100%
 * counted as inferred, the API's own word taking precedence, and the words
 * `limits`, `spend` and `doctor` print. Every file in a throwaway home.
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
import { overageFromHeaders, readClaudeReadings, readOverageReadings, recordLimits, recordOverage, type LimitReading, type OverageReading } from "../limits.js";
import { creditsLines, creditsOf, creditsReport, episodeLine, extraUsageText, spentSpans, type CreditsEpisode } from "../credits.js";
import { readExtraUsage } from "../claudedir.js";
import { extraUsageCheck } from "../doctor.js";
import { creditsSplitLines, spendReport } from "../spend.js";
import { startProxy } from "../proxy.js";
import { requestCost } from "../pricing.js";
import { sandboxEnv } from "./sandbox.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T0 = Date.parse("2026-11-17T08:00:00Z");

test("the usage-credits headers: the four the proxy records, as given, and nothing from garbage", () => {
  const h = (m: Record<string, string>) => (n: string) => m[n];
  assert.deepEqual(overageFromHeaders(h({
    "anthropic-ratelimit-unified-overage-status": "allowed",
    "anthropic-ratelimit-unified-overage-in-use": "true",
    "anthropic-ratelimit-unified-overage-utilization": "0.4237",
    "anthropic-ratelimit-unified-overage-reset": "1798761600",
    "anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
  })), { status: "allowed", inUse: true, pct: 42.4, reset: 1798761600 });
  assert.deepEqual(overageFromHeaders(h({ "anthropic-ratelimit-unified-overage-in-use": "false" })), { inUse: false });
  assert.deepEqual(overageFromHeaders(h({ "anthropic-ratelimit-unified-overage-status": "rejected" })), { status: "rejected" });
  assert.equal(overageFromHeaders(h({})), undefined);
  assert.equal(overageFromHeaders(h({ "anthropic-ratelimit-unified-overage-in-use": "yes", "anthropic-ratelimit-unified-overage-status": "Allowed <b>", "anthropic-ratelimit-unified-overage-utilization": "x", "anthropic-ratelimit-unified-overage-reset": "-5" })), undefined);
});

test("credits readings go into the limits ledger as their own lines: a change at once, a moved share once a minute, a keepalive every 15 minutes", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-credits-log-"));
  const log = join(dir, "limits.jsonl");
  assert.equal(recordOverage(undefined, T0, log), 0);
  assert.equal(existsSync(log), false);
  assert.equal(recordLimits({ seven_day: { used_percentage: 99, resets_at: T0 / 1000 + DAY / 1000 } }, T0, log, "proxy"), 1);
  assert.equal(recordOverage({ status: "allowed", inUse: false }, T0, log), 1);
  assert.equal(recordOverage({ status: "allowed", inUse: false }, T0 + MIN, log), 0, "unchanged: nothing");
  assert.equal(recordOverage({ status: "allowed", inUse: true, pct: 1 }, T0 + 2 * MIN, log), 1, "credits now in use: at once");
  assert.equal(recordOverage({ status: "allowed", inUse: true, pct: 1.5 }, T0 + 2 * MIN + 10_000, log), 0, "a moved share within the minute waits");
  assert.equal(recordOverage({ status: "allowed", inUse: true, pct: 2 }, T0 + 4 * MIN, log), 1);
  assert.equal(recordOverage({ status: "allowed", inUse: true, pct: 2 }, T0 + 20 * MIN, log), 1, "a keepalive after 15 minutes");
  assert.equal(recordOverage({ status: "allowed_warning", inUse: true, pct: 2 }, T0 + 20 * MIN + 1000, log), 1, "a new status: at once");
  const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines[1], { ts: T0, app: "claude", w: "overage", status: "allowed", inUse: false, src: "proxy" });
  const ov = readOverageReadings(0, log);
  assert.deepEqual(ov.map((o) => [o.ts - T0, o.inUse, o.pct, o.status]), [[0, false, undefined, "allowed"], [2 * MIN, true, 1, "allowed"], [4 * MIN, true, 2, "allowed"], [20 * MIN, true, 2, "allowed"], [20 * MIN + 1000, true, 2, "allowed_warning"]]);
  // The window readers do not see them, and the window recorder is unmoved by them.
  assert.deepEqual(readClaudeReadings(0, log).map((r) => [r.window, r.pct]), [["seven_day", 99]]);
  assert.equal(recordLimits({ seven_day: { used_percentage: 99, resets_at: T0 / 1000 + DAY / 1000 } }, T0 + 21 * MIN, log, "proxy"), 1, "its own keepalive, by its own last line");
});

test("the proxy writes the credits headers a reply carries into the ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-credits-proxy-"));
  const log = join(dir, "limits.jsonl");
  const reset = Math.round((Date.now() + 3 * DAY) / 1000);
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.setHeader("anthropic-ratelimit-unified-7d-utilization", "1.0");
      res.setHeader("anthropic-ratelimit-unified-7d-reset", String(reset));
      res.setHeader("anthropic-ratelimit-unified-overage-status", "allowed");
      res.setHeader("anthropic-ratelimit-unified-overage-in-use", "true");
      res.setHeader("anthropic-ratelimit-unified-overage-utilization", "0.12");
      res.setHeader("anthropic-ratelimit-unified-overage-reset", "1798761600");
      res.end('{"usage":{"input_tokens":1,"output_tokens":1}}');
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const proxy = startProxy({ port: 0, anthropicUpstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, limitsLogPath: log });
  await new Promise<void>((r) => proxy.once("listening", () => r()));
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: (proxy.address() as AddressInfo).port, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end(JSON.stringify({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }));
    });
    assert.equal(status, 200);
    for (let i = 0; i < 50 && readOverageReadings(0, log).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(readOverageReadings(0, log).map((o) => [o.status, o.inUse, o.pct, o.resetsAt, o.source]), [["allowed", true, 12, 1798761600 * 1000, "proxy"]]);
    assert.deepEqual(readClaudeReadings(0, log).map((r) => [r.window, r.pct]), [["seven_day", 100]]);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test("the extra-usage flag is read from ~/.claude.json: on, off, held back, and nothing when it is not there", () => {
  const home = mkdtempSync(join(tmpdir(), "cd-credits-flag-"));
  const write = (j: unknown) => writeFileSync(join(home, ".claude.json"), JSON.stringify(j));
  assert.equal(readExtraUsage(home), undefined, "no file");
  write({ mcpServers: {} });
  assert.equal(readExtraUsage(home), undefined, "an API key: nothing said");
  write({ oauthAccount: { hasExtraUsageEnabled: true }, cachedExtraUsageDisabledReason: null });
  assert.deepEqual(readExtraUsage(home), { enabled: true, disabledReason: null });
  assert.match(extraUsageText(readExtraUsage(home))!.text, /^on: when a plan limit runs out, Claude Code keeps working and the requests are paid from usage credits, real money/);
  assert.deepEqual(extraUsageCheck(home), { label: "Extra usage", status: "ok", detail: extraUsageText(readExtraUsage(home))!.text });
  write({ oauthAccount: { hasExtraUsageEnabled: true }, cachedExtraUsageDisabledReason: "out_of_credits" });
  assert.match(extraUsageText(readExtraUsage(home))!.text, /^on, but the last reply said credits are not paying now \(out of credits\)/);
  write({ oauthAccount: { hasExtraUsageEnabled: false } });
  assert.deepEqual(readExtraUsage(home), { enabled: false });
  assert.equal(extraUsageText(readExtraUsage(home))!.text, "off: when a plan limit runs out, Claude Code stops until it resets; nothing is paid from usage credits");
  write({ oauthAccount: { hasExtraUsageEnabled: "yes" }, cachedExtraUsageDisabledReason: "<script>" });
  assert.equal(readExtraUsage(home), undefined, "values of the wrong shape are not read");
  writeFileSync(join(home, ".claude.json"), "{not json");
  assert.equal(readExtraUsage(home), undefined);
  assert.equal(extraUsageCheck(home), undefined);
});

/** Weekly readings: `pcts` an hour apart from T0, the window resetting at `reset`. */
const weekly = (pcts: number[], reset = T0 + 2 * DAY, source: LimitReading["source"] = "mod"): LimitReading[] =>
  pcts.map((pct, i) => ({ ts: T0 + i * HOUR, app: "claude", window: "seven_day", pct, resetsAt: reset, windowMs: 7 * DAY, source }));

test("a window that read 100% is spent until it resets; requests that still went through after it count as inferred", () => {
  const readings = weekly([97, 99, 100, 100]);
  assert.deepEqual(spentSpans(readings), [{ window: "seven_day", from: T0 + 2 * HOUR, to: T0 + 2 * DAY, resetsAt: T0 + 2 * DAY }]);
  // A 5-hour window at 100% and a weekly one under it; the next period starts low.
  const five: LimitReading[] = [100, 100, 3].map((pct, i) => ({ ts: T0 + i * HOUR, app: "claude", window: "five_hour", pct, resetsAt: T0 + (i < 2 ? 2 : 7) * HOUR, windowMs: 5 * HOUR }));
  assert.deepEqual(spentSpans(five).map((s) => [s.window, s.from - T0, s.to - T0]), [["five_hour", 0, 2 * HOUR]]);
  assert.deepEqual(spentSpans(weekly([10, 36, 36])), [], "peak 36%: nothing spent");

  const points = [0.5, 1.5, 2.5, 3, 30, 47, 49].map((h, i) => ({ ts: T0 + h * HOUR, usd: i + 1 }));
  const on = { readings, overage: [], extraUsage: { enabled: true }, now: T0 + 3 * HOUR + 30 * MIN };
  const c = creditsOf(points.filter((p) => p.ts <= on.now), on);
  assert.equal(c.requests, 2, "the requests at 2.5 h and 3 h: after the 100% reading, before the reset");
  assert.equal(c.usd, 3 + 4);
  assert.equal(c.inferred, 2);
  assert.equal(c.fromHeaders, 0);
  assert.deepEqual(c.episodes.map((e) => [e.window, e.ranOutAt - T0, e.resetsAt! - T0, e.current]), [["seven_day", 2 * HOUR, 2 * DAY, true]]);
  // Later, the whole period: through the reset, not after it.
  const all = creditsOf(points, { ...on, now: T0 + 3 * DAY });
  assert.equal(all.requests, 4);
  assert.equal(all.usd, 3 + 4 + 5 + 6);
  assert.equal(all.episodes[0].current, false);
  // Extra usage off: nothing inferred. Not known (an API key's file): inferred.
  assert.equal(creditsOf(points, { ...on, extraUsage: { enabled: false } }).requests, 0);
  assert.equal(creditsOf(points, { readings, overage: [], now: T0 + 3 * DAY }).requests, 4);
});

test("the API's own word comes first: in use counts with no 100% reading, not in use vetoes an inference", () => {
  const ov = (m: number, inUse: boolean): OverageReading => ({ ts: T0 + m * MIN, status: "allowed", inUse, source: "proxy" });
  const points = [10, 20, 40, 100, 400].map((m) => ({ ts: T0 + m * MIN, usd: 2 }));
  // In use from minute 5 (a keepalive at 20), not from 30: the requests at 10 and 20 count, the one at 40 does not.
  const overage = [ov(5, true), ov(20, true), ov(30, false)];
  const c = creditsOf(points, { readings: [], overage, now: T0 + 8 * HOUR });
  assert.deepEqual([c.requests, c.fromHeaders, c.inferred, c.usd], [2, 2, 0, 4]);
  assert.equal(c.episodes[0].window, undefined);
  assert.equal(c.episodes[0].ranOutAt, T0 + 5 * MIN);
  // A reading stands 16 minutes: the request at 100 minutes has none, and with no window spent it is not counted.
  assert.equal(creditsOf([{ ts: T0 + 100 * MIN, usd: 1 }], { readings: [], overage: [ov(5, true)], now: T0 + 8 * HOUR }).requests, 0);
  // A weekly window at 100% from minute 0, but the API said credits were not in use at 35: that request is not on credits; the one at 100 (no header reading standing) is inferred.
  const readings = weekly([100], T0 + DAY);
  const mixed = creditsOf(points, { readings, overage: [ov(5, true), ov(20, true), ov(35, false)], extraUsage: { enabled: true }, now: T0 + 8 * HOUR });
  assert.deepEqual([mixed.requests, mixed.fromHeaders, mixed.inferred], [4, 2, 2], "10 and 20 from the headers; 40 vetoed by 35's false; 100 and 400 inferred");
  assert.equal(mixed.episodes.length, 1, "one window period, one episode");
  assert.equal(mixed.episodes[0].window, "seven_day");
});

test("the words: when the limit ran out, how many requests, about how much at API list prices, and inferred said to be", () => {
  const now = Date.parse("2026-11-20T12:00:00Z");
  const base: CreditsEpisode = { window: "seven_day", ranOutAt: Date.parse("2026-11-17T14:05:00Z"), resetsAt: Date.parse("2026-11-21T09:00:00Z"), current: false, first: 0, last: 0, requests: 37, usd: 41.2, fromHeaders: 37, inferred: 0 };
  const when = (ms: number) => {
    const d = new Date(ms);
    return `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} at ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  assert.equal(episodeLine(base, now), `Your weekly limit ran out on ${when(base.ranOutAt)}; 37 requests after that were paid from usage credits, about $41.20 at API list prices (an estimate).`);
  assert.equal(episodeLine({ ...base, fromHeaders: 0, inferred: 37 }, now), `Your weekly limit ran out on ${when(base.ranOutAt)}; 37 requests after that still went through, so most likely on usage credits (inferred), about $41.20 at API list prices (an estimate).`);
  assert.equal(episodeLine({ ...base, fromHeaders: 30, inferred: 7, current: true }, now), `Your weekly limit ran out on ${when(base.ranOutAt)}; 37 requests after that were paid from usage credits (30 as the API's replies said, 7 inferred), about $41.20 at API list prices (an estimate). Still past it; it resets on ${when(base.resetsAt!)}.`);
  assert.equal(episodeLine({ ...base, window: "five_hour", requests: 1, usd: 0.4, fromHeaders: 1 }, now), `Your 5-hour limit ran out on ${when(base.ranOutAt)}; 1 request after that was paid from usage credits, about $0.40 at API list prices (an estimate).`);
  assert.equal(episodeLine({ ...base, window: undefined, resetsAt: undefined }, now), `Past your plan's limit from ${when(base.ranOutAt)}; 37 requests were paid from usage credits, about $41.20 at API list prices (an estimate).`);
  const lines = creditsLines({ episodes: [{ ...base, fromHeaders: 0, inferred: 37 }], requests: 37, usd: 41.2, fromHeaders: 0, inferred: 37 }, now);
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^Inferred: Claude Code's readings stop at 100% and say nothing about credits/);
  assert.match(lines[2], /not confirmed: the dollars are an estimate/);
  assert.deepEqual(creditsLines({ episodes: [], requests: 0, usd: 0, fromHeaders: 0, inferred: 0 }, now), []);
  const split = creditsSplitLines({ usd: 41.2, requests: 37, claudeUsd: 812, fromHeaders: 37, inferred: 0, since: base.ranOutAt }, now);
  assert.equal(split.join("\n"), [
    "",
    `Past your plan's limit since ${when(base.ranOutAt)}: $41.20 of Claude Code's $812,`,
    "  37 requests, paid from usage credits,",
    "  at API list prices (an estimate). The other $771 was inside the plan.",
    "  `context-doctor limits` says when each limit ran out.",
  ].join("\n"));
});

/** A Claude Code transcript in `home` with one Opus 5.5 reply per time: 1,000 input tokens and `output` output tokens each. */
function writeTranscript(home: string, times: number[], output = 10_000): void {
  const cwd = join(home, "work", "proj");
  const proj = join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(proj, { recursive: true });
  const rows: string[] = [];
  times.forEach((ts, i) => {
    const base = { cwd, sessionId: "s1", version: "2.1.329", entrypoint: "claude-desktop" };
    rows.push(JSON.stringify({ ...base, type: "user", uuid: `u${i}`, timestamp: new Date(ts - 2000).toISOString(), message: { role: "user", content: `q ${i}` } }));
    rows.push(JSON.stringify({ ...base, type: "assistant", uuid: `a${i}`, timestamp: new Date(ts).toISOString(), message: { id: `msg_${i}`, model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "a" }], usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: output } } }));
  });
  const file = join(proj, "s1.jsonl");
  writeFileSync(file, rows.join("\n") + "\n");
  const last = times[times.length - 1] / 1000;
  utimesSync(file, last, last);
}

test("limits and spend end to end: a weekly limit at 100%, the requests after it priced, and nothing at a 36% peak or with extra usage off", () => {
  const now = Date.now();
  const start = Math.floor((now - 2 * DAY) / MIN) * MIN;
  const reset = start + 3 * DAY;
  const mk = (peak: number, flag: boolean | undefined) => {
    const home = mkdtempSync(join(tmpdir(), "cd-credits-e2e-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    // Readings every hour for 10 hours, reaching `peak` at hour 6; a request every hour from 0.5 h to 9.5 h.
    const pcts = [80, 85, 90, 94, 97, 99, peak, peak, peak, peak];
    writeFileSync(join(home, ".claude", ".context-doctor-limits.jsonl"), pcts.map((pct, i) => JSON.stringify({ ts: start + i * HOUR, app: "claude", w: "seven_day", pct, reset: reset / 1000, src: "mod" })).join("\n") + "\n");
    writeTranscript(home, Array.from({ length: 10 }, (_, i) => start + i * HOUR + 30 * MIN));
    if (flag !== undefined) writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { hasExtraUsageEnabled: flag }, cachedExtraUsageDisabledReason: null }));
    return home;
  };
  // Each reply by hand: Opus 5.5 at $4 in and $20 out per million, 1,000 in and 10,000 out = $0.004 + $0.20 = $0.204.
  // The requests at 6.5, 7.5, 8.5 and 9.5 h are past the 100% reading at 6 h: $0.816; all ten $2.04.
  const each = requestCost("claude-opus-5-5", { input_tokens: 1000, output_tokens: 10_000 }, start)!.totalUsd;
  assert.ok(Math.abs(each - 0.204) < 1e-9, `Opus 5.5 at $4/$20 per M: ${each}`);
  const home = mk(100, true);
  const env = { ...sandboxEnv(home), CONTEXT_DOCTOR_CACHE_DIR: join(home, "cache") };
  const r = spawnSync(process.execPath, [cliPath, "limits"], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Past your plan's limit: usage credits/);
  assert.match(r.stdout, /Your weekly limit ran out on .+; 4 requests after that still went through, so most likely on usage credits \(inferred\), about \$0\.82 at API list prices \(an estimate\)\. Still past it; it resets on .+\./);
  assert.match(r.stdout, /Inferred: Claude Code's readings stop at 100%/);
  const json = JSON.parse(spawnSync(process.execPath, [cliPath, "limits", "--json"], { env, encoding: "utf8" }).stdout);
  assert.equal(json.credits.requests, 4);
  assert.ok(Math.abs(json.credits.usd - 4 * each) < 1e-9);
  assert.deepEqual(json.credits.extraUsage, { enabled: true, disabledReason: null });
  // The library call agrees, on the same files.
  const transcript = join(home, ".claude", "projects", join(home, "work", "proj").replace(/[^A-Za-z0-9]/g, "-"), "s1.jsonl");
  const lib = creditsReport(30, { now, logPath: join(home, ".claude", ".context-doctor-limits.jsonl"), claudePaths: [transcript], extraUsage: { enabled: true } });
  assert.deepEqual([lib?.requests, lib?.inferred, lib?.episodes.length], [4, 4, 1]);
  // spend splits Claude Code's dollars at the limit.
  const s = spawnSync(process.execPath, [cliPath, "spend"], { env, encoding: "utf8" });
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /Past your plan's limit since .+: \$0\.82 of Claude Code's \$2\.04,\n  4 requests, likely paid from usage credits \(inferred from 100% readings\),\n  at API list prices \(an estimate\)\. The other \$1\.22 was inside the plan\./);
  for (const line of s.stdout.split("\n")) assert.ok(line.length <= 80, `over 80 columns: ${line}`);
  const sj = JSON.parse(spawnSync(process.execPath, [cliPath, "spend", "--json"], { env, encoding: "utf8" }).stdout);
  assert.equal(sj.credits.requests, 4);
  assert.equal(sj.credits.inferred, 4);
  // doctor says extra usage is on.
  const d = spawnSync(process.execPath, [cliPath, "doctor"], { env, encoding: "utf8" });
  assert.match(d.stdout, /Extra usage.*on: when a plan limit runs out, Claude Code keeps working/);

  // The author's case: a peak of 36%: nothing in limits or spend.
  for (const [peak, flag] of [[36, true], [100, false]] as const) {
    const h = mk(peak, flag);
    const e = { ...sandboxEnv(h), CONTEXT_DOCTOR_CACHE_DIR: join(h, "cache") };
    const l = spawnSync(process.execPath, [cliPath, "limits"], { env: e, encoding: "utf8" });
    assert.equal(l.status, 0, l.stderr);
    assert.ok(!/usage credits/.test(l.stdout), `peak ${peak}, extra usage ${flag}:\n${l.stdout}`);
    assert.equal(JSON.parse(spawnSync(process.execPath, [cliPath, "limits", "--json"], { env: e, encoding: "utf8" }).stdout).credits, undefined);
    const sp = spawnSync(process.execPath, [cliPath, "spend"], { env: e, encoding: "utf8" });
    assert.ok(!/Past your plan's limit/.test(sp.stdout), sp.stdout);
  }
});

test("spendReport takes the ledger and the flag from its options, and counts the API's word without any 100% reading", () => {
  const home = mkdtempSync(join(tmpdir(), "cd-credits-spend-"));
  const now = Date.now();
  const start = Math.floor((now - DAY) / MIN) * MIN;
  writeTranscript(home, [start, start + 10 * MIN, start + 20 * MIN, start + 2 * HOUR]);
  const files = [join(home, ".claude", "projects", join(home, "work", "proj").replace(/[^A-Za-z0-9]/g, "-"), "s1.jsonl")];
  const log = join(home, "limits.jsonl");
  recordOverage({ status: "allowed", inUse: true }, start + 5 * MIN, log);
  recordOverage({ status: "allowed", inUse: true }, start + 21 * MIN - 30_000, log);
  recordOverage({ status: "allowed", inUse: false }, start + 30 * MIN, log);
  const r = spendReport(7, { home, now, claudePaths: files, limitsLogPath: log, extraUsage: null, progress: false });
  assert.equal(r.credits?.requests, 2, "the replies at 10 and 20 minutes; the first came before credits, the last after they stopped");
  assert.equal(r.credits?.fromHeaders, 2);
  assert.equal(r.credits?.since, start + 5 * MIN);
  const none = spendReport(7, { home, now, claudePaths: files, limitsLogPath: join(home, "none.jsonl"), extraUsage: null, progress: false });
  assert.equal(none.credits, undefined);
});
