/**
 * The run-out forecast checked against your own past weeks (ROADMAP J3):
 * each closed weekly window is replayed every 12 hours, both paces put its
 * end somewhere, and the one that missed less on the last 2+ windows is
 * named and used for the run-out and for H2's credits figure, which gets a
 * range. Bursty weeks pick the window's average, a steady pace that changed
 * picks the last 24 hours'; with under 2 closed windows nothing changes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { creditsAhead, creditsAheadLine } from "../credits.js";
import { cleanReadings, limitsReport, paceCheck, paceCheckLine, renderLimits, windowStatus, withPace } from "../limits.js";
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR, WEEK = 7 * DAY;
const W0 = Date.parse("2026-11-07T11:00:00Z");
/**
 * Weekly readings from each day's rise: `sessions` spreads a day's points
 * over 8 hours of work (readings every 15 minutes), `round` over the whole
 * day (every 30 minutes, agents running around the clock). 0.1% steps.
 */
function weeks(days, mode, start = W0) {
    const out = [];
    days.forEach((week, i) => {
        const ws = start + i * WEEK, reset = ws + WEEK;
        let pct = 0;
        week.forEach((rise, d) => {
            const [from, span, step] = mode === "sessions" ? [ws + d * DAY + HOUR, 8 * HOUR, 15 * MIN] : [ws + d * DAY, DAY, 30 * MIN];
            const n = span / step;
            for (let k = 1; k <= n; k++) {
                pct += rise / n;
                out.push({ ts: from + k * step - (mode === "round" ? MIN : 0), app: "claude", window: "seven_day", pct: Math.round(pct * 10) / 10, resetsAt: reset, windowMs: WEEK, source: "mod" });
            }
        });
    });
    return out;
}
const BURSTY = [[18, 0, 4, 22, 0, 2, 10], [5, 25, 0, 0, 20, 3, 0], [0, 15, 2, 0, 24, 0, 9]];
const STEADY = [[3, 3, 3, 12, 12, 12, 12], [2, 2, 10, 10, 10, 10, 10], [4, 4, 4, 4, 14, 14, 14]];
test("bursty weeks of 8-hour sessions: the window's average misses less, and is named with both medians", () => {
    const rs = weeks([...BURSTY, [10, 0, 0]], "sessions");
    const now = W0 + 3 * WEEK + 2 * DAY + 12 * HOUR;
    const c = paceCheck(cleanReadings(rs), now);
    assert.ok(c, "three closed windows");
    assert.equal(c.windows, 3);
    assert.equal(c.pace, "average", JSON.stringify(c));
    assert.ok(c.averageMiss < c.recentMiss);
    assert.match(paceCheckLine(c), /^Replayed every 12 hours on your last 3 weekly windows, the window's average pace missed where the week ended by a median [\d.]+ points, the last 24 hours' by [\d.]+: the run-out uses the average\.$/);
});
test("a steady round-the-clock pace that steps up mid-week: the last 24 hours' misses less", () => {
    const rs = weeks([...STEADY, [12, 12]], "round");
    const now = W0 + 3 * WEEK + 2 * DAY;
    const c = paceCheck(cleanReadings(rs), now);
    assert.equal(c.windows, 3);
    assert.equal(c.pace, "recent", JSON.stringify(c));
    assert.ok(c.recentMiss < c.averageMiss);
    assert.match(paceCheckLine(c), /the last 24 hours' pace missed where the week ended by a median [\d.]+ points, the window's average by [\d.]+: the run-out uses the last 24 hours'\.$/);
});
test("under two closed windows: no check, the status and the report as before", () => {
    const one = weeks([BURSTY[0], [10, 20, 0]], "sessions");
    const now = W0 + WEEK + 2 * DAY + 12 * HOUR;
    assert.equal(paceCheck(cleanReadings(one), now), undefined);
    const s = windowStatus(cleanReadings(one), now);
    assert.deepEqual(withPace(s, undefined), s);
    const dir = mkdtempSync(join(tmpdir(), "cd-pace-"));
    const real = Date.now();
    const log = join(dir, "limits.jsonl");
    const line = (r) => JSON.stringify({ ts: r.ts, app: "claude", w: r.window, pct: r.pct, reset: Math.round(r.resetsAt / 1000), src: "mod" });
    writeFileSync(log, weeks([BURSTY[0], [10, 20, 0]], "sessions", real - WEEK - 2 * DAY - 12 * HOUR).filter((r) => r.ts <= real).map(line).join("\n") + "\n");
    const r = limitsReport(30, { now: real, logPath: log, codexRoot: join(dir, "none"), claudePaths: [] });
    const w = r.windows.find((x) => x.window === "seven_day");
    assert.ok(!("paceCheck" in w), "no new key in --json");
    assert.ok(!/Replayed every 12 hours/.test(renderLimits(r)));
});
test("limits: the checked pace names itself, and the run-out is at it", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-pace-report-"));
    const real = Date.now();
    // The current week, a day and 10 hours in, after a 15-point burst that ended an hour ago: the last day's pace runs out, the week's average lasts.
    const start = real - 3 * WEEK - DAY - 10 * HOUR;
    const rs = weeks([...BURSTY, [2, 15]], "sessions", start).filter((r) => r.ts <= real);
    const log = join(dir, "limits.jsonl");
    writeFileSync(log, rs.map((r) => JSON.stringify({ ts: r.ts, app: "claude", w: r.window, pct: r.pct, reset: Math.round(r.resetsAt / 1000), src: "mod" })).join("\n") + "\n");
    const r = limitsReport(30, { now: real, logPath: log, codexRoot: join(dir, "none"), claudePaths: [] });
    const w = r.windows.find((x) => x.window === "seven_day");
    assert.equal(w.paceCheck?.pace, "average", JSON.stringify(w));
    // The last day's pace alone would run out before the reset; the average lasts, so no run-out time.
    const plain = windowStatus(cleanReadings(rs), real);
    assert.equal(plain.beforeReset, true, JSON.stringify(plain));
    assert.equal(w.beforeReset, false);
    const text = renderLimits(r, [], "AHEAD");
    assert.match(text, /\n {2}Replayed every 12 hours on your last 3 weekly windows, the window's average pace missed/);
    assert.match(text, /\n {2}At the window's average pace it lasts until the reset\.\n/);
    assert.ok(!text.includes("AHEAD"), "no credits line when the chosen pace lasts");
});
/** Wednesday 2026-10-14, 15:00 UTC; the weekly resets 72 hours later. */
const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const RESET = NOW + 3 * DAY;
const ON = { enabled: true, disabledReason: null };
const day = Array.from({ length: 24 }, (_, i) => ({ ts: NOW - i * HOUR, usd: 0.2, model: "claude-fable-5-2" }));
const status = (over = {}) => ({
    window: "seven_day", label: "Claude weekly", app: "claude", pct: 64, at: NOW, resetsAt: RESET, resetSince: false, readings: 30,
    recentPerHour: 1, averagePerHour: 64 / 96, runsOutAt: NOW + 36 * HOUR, beforeReset: true, ...over,
});
test("H2's credits figure at the checked pace, with the range between the two: $3.60 to $7.20 by hand", () => {
    const check = { windows: 2, checks: 20, recentMiss: 22, averageMiss: 9, pace: "average" };
    const s = withPace(status(), check);
    // At the average (64% over 96 h, 0.667% an hour): 36% left runs out in 54 h, 18 h before the reset.
    assert.equal(Math.round((s.runsOutAt - NOW) / HOUR), 54);
    assert.equal(s.beforeReset, true);
    const a = creditsAhead(s, ON, day, NOW);
    assert.equal(a.pace, "average");
    assert.equal(a.usd.toFixed(2), "3.60");
    // The last 24 hours' pace (1% an hour): 36 h to the reset, $7.20; the average: 18 h, $3.60.
    assert.equal(a.usdLow.toFixed(2), "3.60");
    assert.equal(a.usdHigh.toFixed(2), "7.20");
    assert.match(creditsAheadLine(a, NOW), /^Extra usage is on: at the window's average pace \(the one that missed less on your past weeks\) your weekly limit runs out on \w{3}, Oct 1[67] at \d\d:\d\d, 18 hours before it resets, and Claude Code would keep working on usage credits until then: about \$3\.60 at API list prices \(an estimate\), \$3\.60 to \$7\.20 between the two paces, at your last 24 hours' \$0\.20 an hour, mostly Fable 5\.2\.$/);
    // An average that lasts: no run-out, so no credits line at all.
    const lasts = withPace(status({ averagePerHour: 0.3 }), check);
    assert.equal(lasts.beforeReset, false);
    assert.equal(creditsAhead(lasts, ON, day, NOW), undefined);
    // The last 24 hours' pace chosen: the run-out as before, the range from 0 (the average lasts) to it.
    const recent = creditsAhead(withPace(status({ averagePerHour: 0.3 }), { ...check, pace: "recent" }), ON, day, NOW);
    assert.equal(recent.usd.toFixed(2), "7.20");
    assert.equal(recent.usdLow, 0);
    assert.match(creditsAheadLine(recent, NOW), /at the last 24 hours' pace \(the one that missed less on your past weeks\).*about \$7\.20 .*, \$0\.00 to \$7\.20 between the two paces/);
    // No check: the line as H2 wrote it.
    assert.equal(creditsAhead(status(), ON, day, NOW).pace, undefined);
});
