/**
 * What a full 5-hour window costs of the weekly limit (ROADMAP I2): a
 * constant ratio reports no move, a planted 10% to 12% is flagged and dated
 * at its reset, whole-percent noise alone flags nothing, thin data quotes no
 * number, a plan with no 5-hour window (Ultra) prints nothing, Codex's two
 * windows pair the same way, and `limits --json` carries `exchange`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { exchangeLine, exchangeOf, limitsReport, renderLimits, renderLimitsReport, type LimitReading } from "../limits.js";
import { sandboxEnv } from "./sandbox.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR, WEEK = 7 * DAY;
/** A Saturday weekly reset, 11:00 UTC. */
const W0 = Date.parse("2026-11-07T11:00:00Z");

/**
 * Claude readings as the mod writes them, in whole percents, both windows
 * at the same moment: `weeks[i]` is the true ratio in weekly window i, and
 * `rises(i, k)` the 5-hour points of its k-th window (one a day, from an hour after the weekly reset).
 * Each window rises in 2-point steps every 5 minutes; the weekly figure is
 * the true running total, rounded down as the meter shows it.
 */
function claudeReadings(weeks: number[], rises: (week: number, k: number) => number, opts: { start?: number; perWeek?: number } = {}): LimitReading[] {
  const start = opts.start ?? W0;
  const out: LimitReading[] = [];
  weeks.forEach((ratio, i) => {
    const weekStart = start + i * WEEK;
    const weekReset = weekStart + WEEK;
    let weekly = 0;
    for (let k = 0; k < (opts.perWeek ?? 6); k++) {
      const from = weekStart + k * DAY + HOUR;
      const reset = from + 5 * HOUR;
      const total = rises(i, k);
      let five = 0;
      for (let t = 0; five < total; t++) {
        const ts = from + 5 * MIN * (t + 1);
        const step = Math.min(2, total - five);
        five += step;
        weekly += step * ratio;
        out.push({ ts, app: "claude", window: "five_hour", pct: Math.floor(five), resetsAt: reset, windowMs: 5 * HOUR, source: "mod" });
        out.push({ ts, app: "claude", window: "seven_day", pct: Math.floor(weekly + 1e-9), resetsAt: weekReset, windowMs: WEEK, source: "mod" });
      }
    }
  });
  return out;
}

const split = (rs: LimitReading[]) => [rs.filter((r) => r.window === "five_hour"), rs.filter((r) => r.window === "seven_day")] as const;

/** A deterministic spread of window sizes: 20 to 79 points. */
const lcg = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

test("a constant ratio reports no move: the figure, its error and 'unchanged since' the first window", () => {
  const rs = claudeReadings([1 / 6, 1 / 6, 1 / 6], () => 60);
  const e = exchangeOf(...split(rs), { app: "claude", label: "Claude", now: W0 + 3 * WEEK })!;
  assert.equal(e.moves.length, 0);
  assert.equal(e.weeks.length, 3);
  assert.equal(e.compared, 3);
  assert.ok(Math.abs(e.pct! - 100 / 6) < 0.8, String(e.pct));
  assert.ok(e.err! > 0 && e.err! < 1, String(e.err));
  assert.equal(e.why, undefined);
  assert.equal(exchangeLine(e), `A full 5-hour window is ${(Math.round(e.pct! * 10) / 10).toFixed(1)}% of your weekly limit (±${(Math.round(e.err! * 10) / 10).toFixed(1)}), about 6 a week; unchanged since Nov 7.`);
});

test("a planted move from 10% to 12% is flagged at its weekly reset, from what to what, and the mix ruled out", () => {
  const rs = claudeReadings([0.1, 0.1, 0.12, 0.12], () => 50, { perWeek: 7 });
  const e = exchangeOf(...split(rs), { app: "claude", label: "Claude", now: W0 + 4 * WEEK })!;
  assert.equal(e.moves.length, 1, JSON.stringify(e.moves));
  const m = e.moves[0];
  assert.equal(m.at, W0 + 2 * WEEK);
  assert.ok(Math.abs(m.pctBefore - 10) < 0.6 && Math.abs(m.pctAfter - 12) < 0.6, JSON.stringify(m));
  assert.ok(m.sigma >= 3);
  // The figure counts from the move on: the 12%.
  assert.equal(e.since, W0 + 2 * WEEK);
  assert.ok(Math.abs(e.pct! - 12) < 0.6, String(e.pct));
  const line = exchangeLine(e);
  assert.match(line, /^A full 5-hour window is 1[12]\.\d% of your weekly limit \(±\d+\.\d\), about [89] a week; it was (9|10)\.\d% \(±\d+\.\d\) and moved at the weekly reset of Nov 21\./);
  assert.match(line, /model mix does not explain this: both limits count the same requests/);
  // The same rises with no move: nothing flagged.
  const flat = exchangeOf(...split(claudeReadings([0.1, 0.1, 0.1, 0.1], () => 50, { perWeek: 7 })), { app: "claude", label: "Claude", now: W0 + 4 * WEEK })!;
  assert.equal(flat.moves.length, 0);
});

test("whole-percent noise alone flags nothing: uneven windows, one true ratio, readings rounded", () => {
  for (const seed of [1, 7, 42, 99, 2026]) {
    const rnd = lcg(seed);
    const sizes = Array.from({ length: 6 }, () => Array.from({ length: 7 }, () => 20 + Math.floor(rnd() * 60)));
    const rs = claudeReadings([0.137, 0.137, 0.137, 0.137, 0.137, 0.137], (w, k) => sizes[w][k], { perWeek: 7 });
    const e = exchangeOf(...split(rs), { app: "claude", label: "Claude", now: W0 + 6 * WEEK })!;
    assert.equal(e.moves.length, 0, `seed ${seed}: ${JSON.stringify(e.moves)}`);
    assert.ok(Math.abs(e.pct! - 13.7) < 3 * e.err! + 0.6, `seed ${seed}: ${e.pct} ±${e.err}`);
    assert.match(exchangeLine(e), /unchanged since Nov 7\.$/);
  }
});

test("thin data is said to be thin, with no figure; one weekly window says there is nothing to compare yet", () => {
  const rs = claudeReadings([1 / 6], () => 40, { perWeek: 2 });
  const e = exchangeOf(...split(rs), { app: "claude", label: "Claude", now: W0 + DAY * 3 })!;
  assert.ok(e.why);
  const line = exchangeLine(e);
  assert.match(line, /too thin to quote yet \(2 five-hour windows with weekly readings beside them; 3 make a figure\)/);
  assert.ok(!/\d%|±/.test(line), line);
  // The weekly reading never moving: no ratio of 0 quoted.
  const still = exchangeOf(...split(claudeReadings([0.001], () => 30, { perWeek: 4 })), { app: "claude", label: "Claude", now: W0 + 5 * DAY })!;
  assert.ok(!/\d%|±/.test(exchangeLine(still)), exchangeLine(still));
  // One weekly window with enough data: the figure, and no claim that it held.
  const one = exchangeOf(...split(claudeReadings([1 / 6], () => 60)), { app: "claude", label: "Claude", now: W0 + 6 * DAY })!;
  assert.match(exchangeLine(one), /about 6 a week \(since Nov 7; one weekly window so far, nothing to compare yet\)\.$/);
});

test("a plan with no 5-hour window (Ultra) prints no exchange line; limits and --report print it otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-exchange-"));
  const now = Date.now();
  const start = now - 2 * WEEK - 2 * DAY;
  const rs = claudeReadings([1 / 6, 1 / 6], () => 60, { start });
  const line = (r: LimitReading) => JSON.stringify({ ts: r.ts, app: "claude", w: r.window, pct: r.pct, reset: Math.round(r.resetsAt! / 1000), src: "mod" });
  const ultra = join(dir, "ultra.jsonl");
  writeFileSync(ultra, rs.filter((r) => r.window === "seven_day").map(line).join("\n") + "\n");
  const u = limitsReport(30, { now, logPath: ultra, codexRoot: join(dir, "none"), claudePaths: [] });
  assert.deepEqual(u.exchange, []);
  assert.ok(!/5-hour window (is|costs)/.test(renderLimits(u)), renderLimits(u));
  assert.ok(!/5-hour window (is|costs)/.test(renderLimitsReport(u)));
  const both = join(dir, "both.jsonl");
  writeFileSync(both, rs.map(line).join("\n") + "\n");
  const b = limitsReport(30, { now, logPath: both, codexRoot: join(dir, "none"), claudePaths: [] });
  assert.equal(b.exchange.length, 1);
  assert.match(renderLimits(b), /\nA full 5-hour window is 1\d\.\d% of your weekly limit \(±\d+\.\d\), about 6 a week; unchanged since /);
  assert.match(renderLimitsReport(b), /\nA full 5-hour window is 1\d\.\d% of your weekly limit/);
});

test("Codex: the 300- and 10080-minute windows of one plan pair the same way", () => {
  const home = mkdtempSync(join(tmpdir(), "cd-exchange-codex-"));
  const dir = join(home, ".codex", "sessions", "2026", "11", "20");
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const start = now - 2 * WEEK - 2 * DAY;
  const rs = claudeReadings([0.1, 0.1], () => 60, { start });
  const rows = [JSON.stringify({ timestamp: new Date(start).toISOString(), type: "turn_context", payload: { model: "gpt-5.6-sol" } })];
  const fives = rs.filter((r) => r.window === "five_hour");
  const weeks = rs.filter((r) => r.window === "seven_day");
  fives.forEach((f, i) => {
    const w = weeks[i];
    rows.push(JSON.stringify({
      timestamp: new Date(f.ts).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { total_tokens: 1000 * (i + 1) }, last_token_usage: { input_tokens: 900, cached_input_tokens: 0, output_tokens: 100 } },
        rate_limits: {
          limit_id: "codex", plan_type: "plus",
          primary: { used_percent: f.pct, window_minutes: 300, resets_at: Math.round(f.resetsAt! / 1000) },
          secondary: { used_percent: w.pct, window_minutes: 10080, resets_at: Math.round(w.resetsAt! / 1000) },
        },
      },
    }));
  });
  writeFileSync(join(dir, "rollout-x.jsonl"), rows.join("\n") + "\n");
  const r = limitsReport(30, { now, logPath: join(home, "none.jsonl"), codexRoot: join(home, ".codex", "sessions") });
  assert.equal(r.exchange.length, 1);
  const e = r.exchange[0];
  assert.equal(e.app, "codex");
  assert.equal(e.label, "Codex (plus)");
  assert.ok(Math.abs(e.pct! - 10) < 1, String(e.pct));
  assert.match(exchangeLine(e), /^Codex \(plus\): a full 5-hour window is \d+\.\d% of your weekly limit/);
});

test("limits --json carries `exchange`: the figure, its error, the weekly windows and the moves", () => {
  const home = mkdtempSync(join(tmpdir(), "cd-exchange-json-"));
  const now = Date.now();
  const rs = claudeReadings([1 / 6, 1 / 6], () => 60, { start: now - 2 * WEEK - 2 * DAY });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".context-doctor-limits.jsonl"), rs.map((r) => JSON.stringify({ ts: r.ts, app: "claude", w: r.window, pct: r.pct, reset: Math.round(r.resetsAt! / 1000), src: "mod" })).join("\n") + "\n");
  const out = spawnSync(process.execPath, [cliPath, "limits", "--json"], { env: sandboxEnv(home), encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  const json = JSON.parse(out.stdout);
  assert.equal(json.exchange.length, 1);
  const e = json.exchange[0];
  assert.deepEqual(Object.keys(e).sort(), ["app", "compared", "err", "fivePct", "label", "long", "moves", "pct", "short", "since", "weekPct", "weeks", "windows"]);
  assert.equal(e.app, "claude");
  assert.equal(e.short, "five_hour");
  assert.equal(e.long, "seven_day");
  assert.equal(typeof e.pct, "number");
  assert.deepEqual(e.moves, []);
  assert.deepEqual(Object.keys(e.weeks[0]).sort(), ["current", "err", "fivePct", "pct", "resetsAt", "start", "weekPct", "windows"]);
  const text = spawnSync(process.execPath, [cliPath, "limits"], { env: sandboxEnv(home), encoding: "utf8" });
  assert.match(text.stdout, /A full 5-hour window is 1\d\.\d% of your weekly limit/);
});
