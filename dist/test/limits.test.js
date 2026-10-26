/**
 * The limit ledger: what the status line records, what Codex's rollouts
 * hold, the pace and run-out forecast, and the fit of % of the limit per 1M
 * tokens, which must recover known weights and refuse to quote thin data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { claudeLimitFit, cleanReadings, codexLimitData, fitWindow, inLimit, limitSavingsLines, limitsReport, readClaudeReadings, recordLimits, renderLimits, segmentsOf, windowStatus, } from "../limits.js";
import { sandboxEnv } from "./sandbox.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const MIN = 60_000, HOUR = 60 * MIN;
const T0 = Date.parse("2026-10-20T08:00:00Z");
test("the status line's rate_limits are logged on a change, kept alive every 15 minutes, and nothing without them", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-limits-log-"));
    const log = join(dir, "limits.jsonl");
    const rl = (five, week) => ({ five_hour: { used_percentage: five, resets_at: T0 / 1000 + 3600 }, seven_day: { used_percentage: week, resets_at: T0 / 1000 + 86400 } });
    assert.equal(recordLimits(undefined, T0, log), 0);
    assert.equal(recordLimits({}, T0, log), 0);
    assert.equal(recordLimits({ five_hour: { used_percentage: "12" } }, T0, log), 0);
    assert.equal(existsSync(log), false, "no limits, no file");
    assert.equal(recordLimits(rl(12.34, 40), T0, log), 2);
    assert.equal(recordLimits(rl(12.34, 40), T0 + MIN, log), 0, "unchanged: nothing");
    assert.equal(recordLimits(rl(13, 40), T0 + 2 * MIN, log), 1, "only the window that moved");
    assert.equal(recordLimits(rl(13, 40), T0 + 20 * MIN, log), 2, "a keepalive after 15 minutes");
    const readings = readClaudeReadings(0, log);
    assert.equal(readings.length, 5);
    assert.deepEqual(readings.slice(0, 2).map((r) => [r.window, r.pct, r.resetsAt]), [["five_hour", 12.3, T0 + HOUR], ["seven_day", 40, T0 + 86_400_000]]);
    // Garbage lines are skipped, not fatal.
    writeFileSync(log, readFileSync(log, "utf8") + "not json\n{\"ts\":1,\"w\":\"five_hour\",\"pct\":\"x\"}\n");
    assert.equal(readClaudeReadings(0, log).length, 5);
});
test("the log is byte-capped: past 2 MB it keeps the newest 1.5 MB (over a week of the heaviest use)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-limits-cap-"));
    const log = join(dir, "limits.jsonl");
    const line = JSON.stringify({ ts: T0, app: "claude", w: "five_hour", pct: 1, reset: 1 }) + "\n";
    writeFileSync(log, line.repeat(Math.ceil((2.1 * 1024 * 1024) / line.length)));
    assert.equal(recordLimits({ five_hour: { used_percentage: 50, resets_at: 2 } }, T0 + MIN, log), 1);
    const size = statSync(log).size;
    assert.ok(size <= 1536 * 1024 + 200 && size > 1024 * 1024, String(size));
    const last = readClaudeReadings(0, log).at(-1);
    assert.equal(last.pct, 50, "the new reading is kept");
});
test("a stale reading from a parallel session is never logged; a rise is logged at most once a minute", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-limits-stale-"));
    const log = join(dir, "limits.jsonl");
    const reset = Math.round((T0 + 4 * HOUR) / 1000);
    const rl = (pct, r = reset) => ({ five_hour: { used_percentage: pct, resets_at: r } });
    assert.equal(recordLimits(rl(40), T0, log), 1);
    assert.equal(recordLimits(rl(45), T0 + 20 * MIN, log), 1);
    assert.equal(recordLimits(rl(40), T0 + 21 * MIN, log), 0, "lower, same window period: another session's older figure");
    assert.equal(recordLimits(rl(40, reset + 300), T0 + 22 * MIN, log), 0, "a reset five minutes off is the same period");
    assert.equal(recordLimits(rl(45.5), T0 + 20 * MIN + 30_000, log), 0, "a rise within the minute waits");
    assert.equal(recordLimits(rl(46), T0 + 23 * MIN, log), 1);
    assert.equal(recordLimits(rl(2, reset + 5 * 3600), T0 + 4 * HOUR + MIN, log), 1, "a new period starts low");
    assert.deepEqual(readClaudeReadings(0, log).map((r) => r.pct), [40, 45, 46, 2]);
    // A log written before 0.38 holds them: read as stale, not as a new period.
    const old = [[0, 40], [20, 45], [21, 40], [31, 46], [33, 40]].map(([m, pct]) => ({ ts: T0 + m * MIN, app: "claude", window: "five_hour", pct, resetsAt: reset * 1000, windowMs: 5 * HOUR }));
    assert.deepEqual(cleanReadings(old).map((r) => r.pct), [40, 45, 46]);
    assert.equal(windowStatus(cleanReadings(old), T0 + 34 * MIN).pct, 46);
    const cut = segmentsOf(old, [{ ts: T0 + 10 * MIN, app: "claude", input: 1, read: 1, write: 1, output: 1, usd: 1 }, { ts: T0 + 25 * MIN, app: "claude", input: 1, read: 1, write: 1, output: 1, usd: 1 }], 1);
    assert.deepEqual(cut.segments.map((g) => g.dpct), [5, 1], "45 to 46, not a fall to the stale 40 and a rise of 6");
    assert.equal(cut.elsewhere, 0);
});
test("`context-doctor statusline` records the readings beside its line, in the sandboxed home", () => {
    const home = mkdtempSync(join(tmpdir(), "cd-limits-sl-"));
    const input = { model: { id: "claude-opus-5-5" }, context_window: { context_window_size: 1_000_000, current_usage: { input_tokens: 100_000 } }, rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1_900_000_000 }, seven_day: { used_percentage: 41.2, resets_at: 1_900_500_000 } } };
    const r = spawnSync(process.execPath, [cliPath, "statusline"], { input: JSON.stringify(input), env: sandboxEnv(home), encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ctx 100k/);
    const log = join(home, ".claude", ".context-doctor-limits.jsonl");
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.w, l.pct]), [["five_hour", 23.5], ["seven_day", 41.2]]);
    // No rate_limits (an API key): nothing written.
    const home2 = mkdtempSync(join(tmpdir(), "cd-limits-sl2-"));
    spawnSync(process.execPath, [cliPath, "statusline"], { input: JSON.stringify({ ...input, rate_limits: undefined }), env: sandboxEnv(home2), encoding: "utf8" });
    assert.equal(existsSync(join(home2, ".claude", ".context-doctor-limits.jsonl")), false);
});
/** A Codex rollout: token_count events with usage and limits. */
function rollout(home, events) {
    const dir = join(home, ".codex", "sessions", "2026", "10", "20");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `rollout-${events.length}-${Math.random().toString(36).slice(2)}.jsonl`);
    const rows = [JSON.stringify({ timestamp: new Date(events[0].at).toISOString(), type: "turn_context", payload: { model: "gpt-5.6-sol" } })];
    let total = 0;
    for (const e of events) {
        total = e.total ?? total + e.input + e.output;
        rows.push(JSON.stringify({
            timestamp: new Date(e.at).toISOString(),
            type: "event_msg",
            payload: {
                type: "token_count",
                info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: e.input, cached_input_tokens: e.cached, cache_write_input_tokens: 0, output_tokens: e.output } },
                rate_limits: { limit_id: "codex", primary: { used_percent: e.pct, window_minutes: 300, resets_at: Math.round((T0 + 5 * HOUR) / 1000) }, secondary: null, plan_type: e.plan ?? "plus" },
            },
        }));
    }
    writeFileSync(p, rows.join("\n") + "\n");
    return p;
}
test("Codex: readings and usage from the rollouts; a limits-only refresh is not a second request", () => {
    const home = mkdtempSync(join(tmpdir(), "cd-limits-codex-"));
    rollout(home, [
        { at: T0, input: 10_000, cached: 8_000, output: 100, pct: 1 },
        { at: T0 + MIN, input: 10_000, cached: 8_000, output: 100, pct: 2, total: 10_100 },
        { at: T0 + 2 * MIN, input: 20_000, cached: 18_000, output: 200, pct: 3 },
    ]);
    const d = codexLimitData(0, join(home, ".codex", "sessions"));
    assert.equal(d.readings.length, 3);
    assert.equal(d.usage.length, 2, "the event that repeats the running total is the same request");
    assert.deepEqual([d.usage[0].input, d.usage[0].read, d.usage[0].output], [2_000, 8_000, 100]);
    assert.equal(d.readings[0].window, "codex:plus:300");
    assert.equal(d.readings[0].resetsAt, Math.round((T0 + 5 * HOUR) / 1000) * 1000);
});
test("pace and forecast: the recent rate, and whether it runs out before the reset", () => {
    const r = (min, pct, reset = T0 + 4 * HOUR) => ({ ts: T0 + min * MIN, app: "claude", window: "five_hour", pct, resetsAt: reset, windowMs: 5 * HOUR });
    const fast = windowStatus([r(0, 10), r(30, 30), r(60, 50)], T0 + 61 * MIN);
    assert.equal(Math.round(fast.recentPerHour), 40);
    assert.ok(fast.beforeReset, "50% left at 40 an hour: 75 minutes, before the reset in 3 hours");
    assert.equal(Math.round((fast.runsOutAt - T0) / MIN), 135);
    const slow = windowStatus([r(0, 10), r(60, 12)], T0 + 61 * MIN);
    assert.equal(slow.beforeReset, false);
    const reset = windowStatus([r(0, 10, T0 + 30 * MIN)], T0 + HOUR);
    assert.equal(reset.resetSince, true);
    assert.match(renderLimits({ days: 30, now: T0 + 61 * MIN, claudeLog: "/x", claudeReadings: 3, codexReadings: 0, windows: [fast], fits: [] }), /runs out .* before the reset/);
});
/** Readings and usage from known weights: the fit must find them. */
function synthetic(weights, segments, noise = 0, priceOf = (x) => x[0] * 4 + x[1] * 0.4 + x[2] * 5 + x[3] * 20) {
    const usage = [];
    const readings = [];
    let pct = 0, t = T0, seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    readings.push({ ts: t, app: "claude", window: "seven_day", pct: 0, resetsAt: T0 + 7 * 86_400_000, windowMs: 7 * 86_400_000 });
    for (let s = 0; s < segments; s++) {
        // Each stretch: a few requests with a mix that varies, so the types can be told apart.
        const x = [0.05 + 0.3 * rand(), 2 + 20 * rand(), 0.2 + 2 * rand(), 0.02 + 0.2 * rand()];
        const n = 3;
        for (let i = 0; i < n; i++) {
            t += 5 * MIN;
            const part = x.map((v) => (v / n) * 1e6);
            usage.push({ ts: t, app: "claude", model: "claude-opus-5-5", input: part[0], read: part[1], write: part[2], output: part[3], usd: priceOf(part) / 1e6 });
        }
        pct += x.reduce((sum, v, j) => sum + v * weights[j], 0) * Math.max(0, 1 + noise * (rand() - 0.5));
        t += MIN;
        readings.push({ ts: t, app: "claude", window: "seven_day", pct: Math.round(pct * 10) / 10, resetsAt: T0 + 7 * 86_400_000, windowMs: 7 * 86_400_000 });
    }
    return { readings, usage };
}
test("the fit recovers known weights per token type, and list price when the limit follows it", () => {
    // Weights proportional to Opus 5.5's list price ($4 in, $0.20 read... here 0.4, 5 write, 20 out per 1M), 0.25 points per dollar.
    const w = [4 * 0.25, 0.4 * 0.25, 5 * 0.25, 20 * 0.25];
    const { readings, usage } = synthetic(w, 30, 0.05);
    const fit = fitWindow(readings, usage, 1);
    assert.ok(fit.segments >= 25, String(fit.segments));
    assert.ok(fit.byPrice.r2 > 0.9, String(fit.byPrice.r2));
    assert.ok(Math.abs(fit.pctPerUsd - 0.25) / 0.25 < 0.1, String(fit.pctPerUsd));
    assert.ok(Math.abs(fit.perMillion["cache read"] - w[1]) / w[1] < 0.35, JSON.stringify(fit.perMillion));
    assert.equal(fit.usable, true, fit.why);
    // $100 saved over 28 days at 0.25 points per dollar: 25 points, 6.25 a week.
    assert.match(inLimit(fit, 100, 28), /^≈ 6\.\d% of your weekly limit a week \(±/);
    const lines = limitSavingsLines(fit, [["2. Autopilot", 100], ["nothing", 0]], 28);
    assert.equal(lines.length, 3, "a heading of two lines and the one lever with a saving");
    assert.ok(lines.every((l) => l.length <= 64), lines.join("\n"));
    assert.match(renderLimits({ days: 30, now: T0, claudeLog: "/x", claudeReadings: readings.length, codexReadings: 0, windows: [windowStatus(readings, T0 + HOUR)], fits: [fit] }), /Good enough to show savings/);
});
test("thin or unexplained data is never quoted", () => {
    const { readings, usage } = synthetic([1, 0.1, 1.25, 5], 4);
    const thin = fitWindow(readings, usage, 1);
    assert.equal(thin.usable, false);
    assert.match(thin.why, /stretch/);
    assert.equal(inLimit(thin, 100, 30), undefined);
    assert.deepEqual(limitSavingsLines(thin, [["x", 100]], 30), []);
    assert.match(renderLimits({ days: 30, now: T0, claudeLog: "/x", claudeReadings: 5, codexReadings: 0, windows: [], fits: [thin] }), /No limit readings yet|Too thin to quote/);
    // Rises that track nothing recorded here: the rate cannot be pinned down.
    const random = synthetic([1, 0.1, 1.25, 5], 30);
    let seed = 11;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    let pct = 0;
    for (const r of random.readings)
        r.pct = Math.round((pct += rand() * 3) * 10) / 10;
    const bad = fitWindow(random.readings, random.usage, 1);
    assert.equal(bad.usable, false, `relSe ${bad.byPrice?.relSe}`);
});
test("bursts of use elsewhere in a few stretches are left out of the rate, and when they are many the rate is not quoted", () => {
    const w = [1, 0.1, 1.25, 5];
    const few = synthetic(w, 40);
    // Two stretches gain 3 points each from a web-app session at the same time.
    for (const [i, r] of few.readings.entries())
        if (i >= 10)
            r.pct += 3 + (i >= 25 ? 3 : 0);
    const clean = fitWindow(synthetic(w, 40).readings, synthetic(w, 40).usage, 1);
    const fitted = fitWindow(few.readings, few.usage, 1);
    assert.equal(fitted.outliers, 2);
    assert.ok(Math.abs(fitted.pctPerUsd - clean.pctPerUsd) / clean.pctPerUsd < 0.05, `${fitted.pctPerUsd} vs ${clean.pctPerUsd}`);
    const many = synthetic(w, 40);
    let extra = 0;
    for (const [i, r] of many.readings.entries()) {
        if (i % 6 === 5)
            extra += 4;
        r.pct += extra;
    }
    const shared = fitWindow(many.readings, many.usage, 1);
    assert.equal(shared.usable, false);
    assert.match(shared.why, /used elsewhere too/);
});
test("fifty thousand readings take well under the time a report may", () => {
    const readings = [];
    const usage = [];
    for (let i = 0; i < 50_000; i++) {
        const ts = T0 + i * MIN;
        usage.push({ ts: ts - 1000, app: "codex", input: 1000, read: 9000, write: 0, output: 100, usd: 0.01 });
        readings.push({ ts, app: "codex", window: "codex:300", pct: Math.floor((i % 300) / 3), resetsAt: T0 + (Math.floor(i / 300) + 1) * 300 * MIN, windowMs: 300 * MIN });
    }
    const t = Date.now();
    const f = fitWindow(readings, usage);
    assert.ok(f && f.segments > 100);
    assert.ok(Date.now() - t < 3000, `${Date.now() - t} ms`);
});
test("a rise with no usage on this machine is counted as usage elsewhere and left out", () => {
    const r = (min, pct) => ({ ts: T0 + min * MIN, app: "claude", window: "five_hour", pct, resetsAt: T0 + 5 * HOUR, windowMs: 5 * HOUR });
    const usage = [{ ts: T0 + 5 * MIN, app: "claude", input: 1e5, read: 1e6, write: 1e5, output: 1e4, usd: 1 }];
    const s = segmentsOf([r(0, 0), r(10, 2), r(20, 5), r(30, 9)], usage, 1);
    assert.equal(s.segments.length, 1);
    assert.equal(s.elsewhere, 2);
    assert.equal(s.elsewherePct, 7);
    // A reset (the % falls, or the reset time moves) starts a new period: no negative rise.
    const p = segmentsOf([r(0, 50), r(10, 60), { ...r(20, 1), resetsAt: T0 + 9 * HOUR }, { ...r(30, 4), resetsAt: T0 + 9 * HOUR }], [
        { ts: T0 + 5 * MIN, app: "claude", input: 1, read: 1, write: 1, output: 1, usd: 1 },
        { ts: T0 + 25 * MIN, app: "claude", input: 1, read: 1, write: 1, output: 1, usd: 1 },
    ], 1);
    assert.deepEqual(p.segments.map((g) => g.dpct), [10, 3]);
});
test("limits: no readings at all says how to start recording; the report reads Codex and the Claude log", () => {
    const home = mkdtempSync(join(tmpdir(), "cd-limits-cli-"));
    const empty = spawnSync(process.execPath, [cliPath, "limits"], { env: sandboxEnv(home), encoding: "utf8" });
    assert.equal(empty.status, 0);
    assert.match(empty.stdout, /No limit readings yet/);
    assert.match(empty.stdout, /install --statusline/);
    const now = Date.now();
    rollout(home, [
        { at: now - 30 * MIN, input: 10_000, cached: 8_000, output: 100, pct: 4 },
        { at: now - 10 * MIN, input: 10_000, cached: 8_000, output: 100, pct: 9 },
    ]);
    const r = spawnSync(process.execPath, [cliPath, "limits", "--json"], { env: sandboxEnv(home), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const json = JSON.parse(r.stdout);
    assert.equal(json.codexReadings, 2);
    assert.equal(json.windows[0].label, "Codex 5-hour (plus)");
    assert.equal(json.windows[0].pct, 9);
    const report = limitsReport(30, { now, logPath: join(home, "none.jsonl"), codexRoot: join(home, ".codex", "sessions") });
    assert.equal(report.windows.length, 1);
    assert.equal(claudeLimitFit(report), undefined, "no Claude readings: nothing to quote savings in");
});
