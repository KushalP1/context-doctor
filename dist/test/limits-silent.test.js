/**
 * A weekly meter that went silent (ROADMAP J2): a weekly window whose
 * readings stop while the 5-hour window goes on rising gets one line (where
 * it stopped, how far the 5-hour rose after, the weekly that amounts to),
 * no pace from its old reading, and a per-1% fit that ends at its last
 * reading. With no silence the report is unchanged. And the recorder's side
 * of the cause: a fall the proxy reads (usage given back) is kept.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanReadings, exchangeOf, limitsReport, recordLimits, renderLimits, renderLimitsReport, resetWindowsOf, segmentsOf, silentLine, silentMeters } from "../limits.js";
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR, WEEK = 7 * DAY;
const W0 = Date.parse("2026-11-07T11:00:00Z");
/**
 * Both windows as the mod writes them, whole percents, a 5-hour window a
 * day of 60 points (2 points every 5 minutes), a weekly at 1/6 of that.
 * `silentFrom(week)`: the 5-hour window index from which that week's weekly
 * readings are no longer written.
 */
function readings(weeks, opts = {}) {
    const start = opts.start ?? W0;
    const out = [];
    for (let i = 0; i < weeks; i++) {
        const weekStart = start + i * WEEK, weekReset = weekStart + WEEK;
        const cut = opts.silentFrom?.(i);
        let weekly = 0;
        for (let k = 0; k < 6; k++) {
            const from = weekStart + k * DAY + HOUR, reset = from + 5 * HOUR;
            let five = 0;
            for (let t = 0; five < 60; t++) {
                const ts = from + 5 * MIN * (t + 1);
                five += 2;
                weekly += 2 / 6;
                out.push({ ts, app: "claude", window: "five_hour", pct: five, resetsAt: reset, windowMs: 5 * HOUR, source: "mod" });
                if (cut === undefined || k < cut)
                    out.push({ ts, app: "claude", window: "seven_day", pct: Math.floor(weekly + 1e-9), resetsAt: weekReset, windowMs: WEEK, source: "mod" });
            }
        }
    }
    return out;
}
const split = (rs) => [rs.filter((r) => r.window === "five_hour"), rs.filter((r) => r.window === "seven_day")];
const logLine = (r) => JSON.stringify({ ts: r.ts, app: "claude", w: r.window, pct: r.pct, reset: Math.round(r.resetsAt / 1000), src: r.source ?? "mod" });
test("a weekly that stops while the 5-hour rises: where it stopped, the rise after, and the weekly it amounts to", () => {
    const rs = readings(3, { silentFrom: (i) => (i === 2 ? 3 : undefined) });
    const [five, week] = split(rs);
    const now = W0 + 3 * WEEK + HOUR;
    const ex = exchangeOf(five, week, { app: "claude", label: "Claude", now });
    assert.ok(Math.abs(ex.pct - 100 / 6) < 1, String(ex.pct));
    const list = silentMeters(five, week, ex, now);
    assert.equal(list.length, 1, JSON.stringify(list));
    const m = list[0];
    const lastWeekly = week[week.length - 1];
    assert.equal(m.at, lastWeekly.ts);
    assert.equal(m.pct, 30);
    assert.equal(m.resetsAt, W0 + 3 * WEEK);
    assert.equal(m.current, false);
    assert.equal(m.fiveRise, 180, "three full 5-hour windows after the weekly's last reading, each from 0");
    assert.ok(Math.abs(m.estimate - 60) < 2, String(m.estimate));
    assert.ok(m.err > 0 && m.err < 3, String(m.err));
    assert.equal(silentLine(m, now), `No weekly reading after Nov 23 14:30 UTC (30%); the 5-hour meter rose 180 points after it: about ${Math.round(m.estimate)}% (±${Math.max(1, Math.round(m.err))}) by the reset, from the 5-hour exchange; an estimate.`);
    // No exchange worth quoting: the line says the weekly is higher, with no figure.
    assert.match(silentLine({ ...m, estimate: undefined, err: undefined }, now), /rose 180 points after it, so the weekly is higher than its last reading says\.$/);
    // Past 100%: said so, not "about 112%".
    assert.match(silentLine({ ...m, estimate: 112 }, now), /: it likely reached 100% before the reset, from the 5-hour exchange; an estimate\.$/);
});
test("no silence, no line: weeks read to the end, and a weekly that only stops when the 5-hour stops too", () => {
    const [five, week] = split(readings(3));
    assert.deepEqual(silentMeters(five, week, undefined, W0 + 3 * WEEK), []);
    // Both windows stop together (nobody worked): not a silent meter.
    const quiet = readings(1).filter((r) => r.ts < W0 + 3 * DAY);
    assert.deepEqual(silentMeters(...split(quiet), undefined, W0 + WEEK), []);
    // The 5-hour read later but not rising (a keepalive at the same %): not one either.
    const [f2, w2] = split(readings(1).filter((r) => r.ts < W0 + 2 * DAY));
    const kept = f2[f2.length - 1];
    assert.deepEqual(silentMeters([...f2, { ...kept, ts: kept.ts + 3 * HOUR }], w2, undefined, W0 + WEEK), []);
});
test("the per-1% fit ends at the silent weekly's last reading: the usage after it is in no stretch", () => {
    const rs = readings(1, { silentFrom: () => 3 });
    const [, week] = split(rs);
    const last = week[week.length - 1];
    const usage = rs.filter((r) => r.window === "five_hour").map((r) => ({ ts: r.ts - MIN, app: "claude", model: "claude-opus-5-5", input: 0, read: 0, write: 1000, output: 100, usd: 1 }));
    const { segments } = segmentsOf(week, usage, 30 * MIN);
    assert.ok(segments.length > 0);
    assert.ok(segments.every((s) => s.to <= last.ts), "no stretch past the last weekly reading");
    const [w] = resetWindowsOf(week, usage, { now: W0 + WEEK + HOUR });
    const before = usage.filter((p) => p.ts > week[0].ts && p.ts <= last.ts).length;
    assert.equal(w.usd, before, "only the dollars up to the last weekly reading");
    assert.ok(w.usd < usage.length / 2 + 1, "the three silent days' dollars are left out");
});
test("limits: the line under the window's row; while it runs, an estimate for now and no pace or run-out from the old reading", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-silent-"));
    const now = Date.now();
    // Week index 2 runs now: its 5-hour window k=3 is under way, the weekly silent since k=1.
    const start = now - 2 * WEEK - 3 * DAY - 4 * HOUR;
    const rs = readings(3, { start, silentFrom: (i) => (i === 2 ? 1 : undefined) }).filter((r) => r.ts <= now);
    const log = join(dir, "limits.jsonl");
    writeFileSync(log, rs.map(logLine).join("\n") + "\n");
    const r = limitsReport(30, { now, logPath: log, codexRoot: join(dir, "none"), claudePaths: [] });
    const week = r.windows.find((w) => w.window === "seven_day");
    assert.ok(week.silent, JSON.stringify(week));
    assert.equal(week.stale, true);
    assert.equal(week.runsOutAt, undefined);
    assert.equal(week.silent.current, true);
    const row = r.resets.find((w) => w.current);
    assert.ok(row.silent);
    const text = renderLimits(r);
    assert.match(text, /\n {2}No weekly reading since .+ \(10%\); the 5-hour meter rose \d+ points after it: about \d+% \(±\d+\) now, from the 5-hour exchange; an estimate\. No pace or run-out time from the old reading\.\n/);
    assert.match(text, /\n {2}No weekly reading after .+ UTC \(10%\); the 5-hour meter rose \d+ points after it: about \d+% \(±\d+\) now, /);
    assert.match(renderLimitsReport(r), /\n- \d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d: No weekly reading after /);
    // The same readings with the weekly written throughout: no line, the pace as before.
    const full = join(dir, "full.jsonl");
    writeFileSync(full, readings(3, { start }).filter((x) => x.ts <= now).map(logLine).join("\n") + "\n");
    const f = limitsReport(30, { now, logPath: full, codexRoot: join(dir, "none"), claudePaths: [] });
    const fw = f.windows.find((w) => w.window === "seven_day");
    assert.equal(fw.silent, undefined);
    assert.ok(!("silent" in fw) && f.resets.every((w) => !("silent" in w)), "no new key when nothing went silent (the --json golden)");
    assert.ok(!/No weekly reading/.test(renderLimits(f)));
    assert.ok(!/No weekly reading/.test(renderLimitsReport(f)));
});
test("the cause: a fall of 5 points or more read by the proxy is usage given back, kept by the recorder and the reader; any other fall is still a stale figure", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-silent-rec-"));
    const log = join(dir, "limits.jsonl");
    const T0 = Date.parse("2026-11-27T07:00:00Z");
    const reset = Math.round(Date.parse("2026-11-28T11:00:00Z") / 1000);
    const rl = (pct) => ({ seven_day: { used_percentage: pct, resets_at: reset } });
    assert.equal(recordLimits(rl(73), T0, log, "mod"), 1);
    assert.equal(recordLimits(rl(72), T0 + 20 * MIN, log, "mod"), 0, "the mod's lower figure: never logged, as before");
    assert.equal(recordLimits(rl(71), T0 + 21 * MIN, log, "proxy"), 0, "two points under: replies racing, not a give-back");
    assert.equal(recordLimits(rl(40), T0 + 22 * MIN, log, "proxy"), 1, "33 points under, from a live reply: given back");
    assert.equal(recordLimits(rl(41), T0 + 30 * MIN, log, "mod"), 1, "and the next rise is weighed against it");
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.pct), [73, 40, 41]);
    const rs = lines.map((l) => ({ ts: l.ts, app: "claude", window: "seven_day", pct: l.pct, resetsAt: l.reset * 1000, windowMs: WEEK, source: l.src }));
    // A stale mod figure under the given-back one is still dropped; the proxy's fall is kept.
    const withStale = [...rs, { ...rs[0], ts: T0 + 25 * MIN, pct: 35, source: "mod" }];
    assert.deepEqual(cleanReadings(withStale).map((r) => r.pct), [73, 40, 41]);
    // No stretch spans the fall: no zero rise with usage in it.
    const usage = [T0 + 10 * MIN, T0 + 26 * MIN].map((ts) => ({ ts, app: "claude", input: 0, read: 0, write: 1000, output: 10, usd: 1 }));
    assert.deepEqual(segmentsOf(rs, usage, MIN).segments.map((s) => s.dpct), [1]);
});
