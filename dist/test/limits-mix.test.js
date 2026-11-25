/**
 * A move in what 1% buys that the model mix explains (ROADMAP H1): two
 * models at fixed per-model rates and a mix that moves from one to the
 * other is said to be the mix, never "the limit drains faster"; a planted
 * per-model move with the mix held is the limit's own; both at once name
 * both; a mix that flips whole with no other window to take rates from is
 * said to be unclear. The usage pane says the same in a few words.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLimits, renderLimitsReport, resetWindowsOf, slopeChanges } from "../limits.js";
import { limitFitsOf, limitWindows } from "../usagepane.js";
import { usageView } from "../mod/logic.js";
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR, WEEK = 7 * DAY;
const T0 = Date.parse("2026-11-14T16:30:00Z");
const OPUS = "claude-opus-5-5", FABLE = "claude-fable-5-2";
/**
 * Weekly windows from T0, each 48 half-hour stretches of three requests
 * ($1-$5 each), each request on Fable 5.2 with the side's probability, the
 * % rising by each request's dollars over its model's rate on that side.
 * `split`: from this stretch on, the window's second side holds.
 */
function mixed(windows, o = {}) {
    let seed = o.seed ?? 11;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const noise = o.noise ?? 0.04;
    const readings = [];
    const usage = [];
    windows.forEach((w, k) => {
        const start = T0 + k * WEEK, reset = start + WEEK;
        let t = start + HOUR, pct = 0;
        const read = () => readings.push({ ts: t, app: "claude", window: "seven_day", pct: Math.round(pct * 10) / 10, resetsAt: reset, windowMs: WEEK, source: "mod" });
        read();
        for (let s = 0; s < 48; s++) {
            const side = w.after && s >= (w.split ?? 24) ? w.after : w.before;
            let rise = 0;
            for (let i = 0; i < 3; i++) {
                const usd = 1 + 4 * rand();
                const model = rand() < side.fable ? FABLE : OPUS;
                usage.push({ ts: t + (5 + 5 * i) * MIN, app: "claude", model, input: 1000, read: Math.round(usd * 400_000), write: 10_000, output: 2_000, usd, entrypoint: "claude-desktop", version: "2.1.330" });
                rise += usd / side.rates[model];
            }
            pct += rise * (1 + noise * (rand() - 0.5));
            t += 30 * MIN;
            read();
        }
    });
    return { readings, usage };
}
const RATES = { [OPUS]: 15, [FABLE]: 5 };
const HALF = { [OPUS]: 7.5, [FABLE]: 2.5 };
function report(readings, usage, now) {
    const resets = resetWindowsOf(readings, usage, { now });
    const changes = slopeChanges(resets, usage, readings);
    return { days: 30, now, claudeLog: "x", claudeReadings: readings.length, codexReadings: 0, windows: [], fits: [], resets, changes, claudeWindows: ["seven_day"], claudeSources: { mod: readings.length }, exchange: [] };
}
test("a mix moving from 10% to 80% Fable 5.2 at fixed per-model rates is the mix, not the limit draining faster", () => {
    const { readings, usage } = mixed([{ before: { fable: 0.1, rates: RATES }, after: { fable: 0.8, rates: RATES } }]);
    const r = report(readings, usage, T0 + 6 * DAY);
    assert.equal(r.changes.length, 1, JSON.stringify(r.changes));
    const c = r.changes[0];
    assert.equal(c.kind, "within");
    assert.ok(c.factor < 1 / 1.5, String(c.factor));
    assert.equal(c.cause, "mix");
    assert.ok(Math.abs(c.residual - 1) < 0.15, `residual ${c.residual}`);
    assert.ok(Math.abs(c.mixFactor - c.factor) / c.factor < 0.15, `${c.mixFactor} against ${c.factor}`);
    assert.equal(c.mix.grew, FABLE);
    assert.equal(c.mix.shrank, OPUS);
    // The rates the prediction used: Fable 5.2 drains ~3x per dollar against Opus 5.5.
    const drains = c.mix.pctPerUsd[FABLE] / c.mix.pctPerUsd[OPUS];
    assert.ok(Math.abs(drains - 3) < 0.5, String(drains));
    const block = renderLimitsReport(r);
    assert.doesNotMatch(block, /drains faster/);
    assert.match(block, /\(2\.\dx less use per 1%\)\. This comes from your model mix, not the limit: you used Fable 5\.2 for [78]\d% of your dollars after it \(\d+% before\), which uses your limit [23]\.\dx faster per dollar than Opus 5\.5; the mix alone predicts \$1\d\.\d\d to \$\d\.\d\d; per model, 1% buys about the same/);
    assert.match(renderLimits(r), /What 1% buys moved:\n  Claude weekly, within the window, .*This comes from your model mix, not the limit/);
});
test("the mix held and every model's rate halved: the limit's own move, residual 2x", () => {
    const { readings, usage } = mixed([{ before: { fable: 0.5, rates: RATES }, after: { fable: 0.5, rates: HALF } }]);
    const [c, ...more] = report(readings, usage, T0 + 6 * DAY).changes;
    assert.equal(more.length, 0);
    assert.equal(c.cause, "limit");
    assert.ok(c.mix.moved < 0.1, String(c.mix.moved));
    assert.equal(c.mixFactor, 1);
    assert.ok(Math.abs(c.residual - 0.5) < 0.06, `residual ${c.residual}`);
    assert.match(renderLimitsReport(report(readings, usage, T0 + 6 * DAY)), /\(2\.\dx less use per 1%: the limit drains faster\)/);
});
test("the mix moved and the rates halved at once: both named, residual 2x", () => {
    const { readings, usage } = mixed([{ before: { fable: 0.1, rates: RATES }, after: { fable: 0.8, rates: HALF } }]);
    const r = report(readings, usage, T0 + 6 * DAY);
    const [c] = r.changes;
    assert.equal(c.cause, "both", JSON.stringify(c));
    assert.ok(Math.abs(c.residual - 0.5) < 0.08, `residual ${c.residual}`);
    assert.ok(Math.abs(c.mixFactor - 0.46) < 0.07, `mix ${c.mixFactor}`);
    assert.match(renderLimitsReport(r), /Part of it is your model mix: you used Fable 5\.2 for .*Beyond the mix, per model, 1% buys [12]\.\dx less use: the limit drains faster/);
});
test("between windows: a week on Opus 5.5 then a week on Fable 5.2 at the same per-model rates is the mix", () => {
    const { readings, usage } = mixed([{ before: { fable: 0.1, rates: RATES } }, { before: { fable: 0.85, rates: RATES } }]);
    const r = report(readings, usage, T0 + WEEK + 6 * DAY);
    const c = r.changes.find((x) => x.kind === "reset");
    assert.ok(c, JSON.stringify(r.changes));
    assert.equal(c.cause, "mix");
    assert.ok(Math.abs(c.residual - 1) < 0.15, `residual ${c.residual}`);
    assert.match(renderLimitsReport(r), /at the reset of 2026-11-21 16:30 UTC: .*This comes from your model mix, not the limit/);
});
test("a mix that flips whole inside the only window cannot be told from a move: said so, never 'drains faster'", () => {
    const { readings, usage } = mixed([{ before: { fable: 0, rates: RATES }, after: { fable: 1, rates: RATES } }]);
    const [c] = report(readings, usage, T0 + 6 * DAY).changes;
    assert.equal(c.cause, "unclear");
    assert.equal(c.mixFactor, undefined);
    const block = renderLimitsReport(report(readings, usage, T0 + 6 * DAY));
    assert.doesNotMatch(block, /drains faster/);
    assert.match(block, /and your model mix changed too: you used Fable 5\.2 for 100% of your dollars after it \(0% before\)\. Per-model figures are too thin yet/);
    // A mixed week before it gives the rates, and the move reads as the mix.
    const two = mixed([{ before: { fable: 0.5, rates: RATES } }, { before: { fable: 0, rates: RATES }, after: { fable: 1, rates: RATES } }], { seed: 5 });
    const within = report(two.readings, two.usage, T0 + WEEK + 6 * DAY).changes.find((x) => x.kind === "within");
    assert.ok(within, "the move inside the second window");
    assert.equal(within.cause, "mix");
});
test("usage pane: a move the mix explains says so in a few words", () => {
    const { readings, usage } = mixed([{ before: { fable: 0.1, rates: RATES }, after: { fable: 0.8, rates: RATES } }]);
    const now = T0 + 6 * DAY;
    const r = report(readings, usage, now);
    const f = limitFitsOf({ now, windows: [], resets: r.resets, changes: r.changes, noFiveHour: true, readings: readings.length });
    assert.equal(f.limitMove?.cause, "mix");
    assert.equal(f.limitMove?.model, FABLE);
    const limits = limitWindows(now, f.limitFits, [{ ts: now - HOUR, app: "claude", window: "seven_day", pct: 30, resetsAt: T0 + WEEK, windowMs: WEEK }]);
    const v = usageView({ data: { at: now, history: { at: now, periods: [], ...f }, limits, agents: [] }, now });
    assert.match(v.limits[0].sub, /1% moved from \$1\d\.\d\d to \$\d\.\d\d .* ago \(2\.\dx less use per 1%: your model mix \(more Fable 5\.2\), not the limit\)/);
});
