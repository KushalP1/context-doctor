/**
 * The window the Desktop app chose (ROADMAP G3): its offer's answers and the
 * server's windows read from ~/.claude.json (never written), said by
 * `compact-window` and `fix`, and the answered model's sessions left as they
 * ran. With no answer on file the reports are byte for byte as before (the
 * golden files, scan-golden.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appAnswerText, appWindowLines, hasAppWindows, modelKey, readAppWindows, sameModel } from "../appwindow.js";
import { appWindowCheck } from "../doctor.js";
import { estimateCompactWindows, renderCompactWindows } from "../compactwindow.js";
import { planFixes, renderFixPlan } from "../fix.js";
import { buildHistory } from "./history-fixture.js";
import { goldenName, runReport } from "./golden-run.js";
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "cli.js");
const AT = Date.UTC(2026, 8, 25, 9, 0, 0);
const NO_ENV = { CONTEXT_DOCTOR_NO_MANAGED_SETTINGS: "1" };
test("read: every account's newest answer per model, the server's windows, a settings answer; ~/.claude.json untouched", () => {
    const home = mkdtempSync(join(tmpdir(), "cd-appwin-"));
    const cj = join(home, ".claude.json");
    writeFileSync(cj, JSON.stringify({
        oauthAccount: { accountUuid: "AAA" },
        autoCompactOfferCodeTab: {
            aaa: { "claude-opus-5-5": { choice: "accept", tokens: 400_000, at: AT }, "claude-fable-5-2": { choice: "maybe", tokens: 1, at: AT } },
            bbb: { "claude-opus-5-5": { choice: "undo", tokens: 1_000_000, at: AT + 1000 }, "claude-sonnet-5-5": { choice: "keep", tokens: 600_000, at: AT - 5 } },
        },
        autoCompactWindowsCache: { "claude-fable-5-2": 500_000, "claude-haiku-5-5": "auto" },
    }));
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ autoCompactOfferAnswer: { model: "claude-fable-5-1", choice: "keep", tokens: 300_000, at: AT }, autoCompactRaisedForLoad: true }));
    const before = readFileSync(cj, "utf8");
    const mtime = statSync(cj).mtimeMs;
    const a = readAppWindows({ home, cwd: home, env: NO_ENV });
    assert.deepEqual(a.answers.map((x) => [x.model, x.choice, x.tokens]), [["claude-sonnet-5-5", "keep", 600_000], ["claude-fable-5-1", "keep", 300_000], ["claude-opus-5-5", "undo", 1_000_000]]);
    assert.match(a.answers[1].where, /settings\.json$/);
    assert.deepEqual(a.served, [{ model: "claude-fable-5-2", window: 500_000 }]);
    assert.match(a.raisedForLoad, /settings\.json$/);
    assert.equal(readFileSync(cj, "utf8"), before);
    assert.equal(statSync(cj).mtimeMs, mtime);
    // Nothing on file (the author's machine): nothing to say.
    const bare = mkdtempSync(join(tmpdir(), "cd-appwin-bare-"));
    writeFileSync(join(bare, ".claude.json"), JSON.stringify({ autoCompactWindowsCache: null }));
    const none = readAppWindows({ home: bare, cwd: bare, env: NO_ENV });
    assert.equal(hasAppWindows(none), false);
    assert.deepEqual(appWindowLines(none), []);
});
test("model keys: the app's settings key matches the transcript's model, dated, [1m] or by family", () => {
    assert.equal(modelKey("claude-opus-5-5[1m]"), "claude-opus-5-5");
    assert.equal(modelKey("us.anthropic.claude-haiku-4-5-20251001-v1:0"), "claude-haiku-4-5");
    assert.ok(sameModel("claude-opus-5-5", "claude-opus-5-5-20261101"));
    assert.ok(sameModel("opus", "claude-opus-5-5"));
    assert.ok(!sameModel("claude-opus-5-5", "claude-opus-5"));
    assert.ok(!sameModel("claude-fable-5-1", "claude-fable-5-2"));
});
test("lines: what the app offered and what you chose, for accept, keep and undo; nothing assumed about the window", () => {
    const ans = (choice) => appWindowLines({ answers: [{ model: "claude-opus-5-5", choice, tokens: 400_000, at: AT, where: "~/.claude.json" }], served: [] });
    const accept = ans("accept").join("\n");
    assert.match(accept, /The Desktop app, Opus 5\.5: on 2026-09-25 it offered a 400k auto-compact window and you accepted it\./);
    assert.match(accept, /Whether that answer changes the window Claude Code uses is not recorded on this computer/);
    assert.match(accept, /mostly on Opus 5\.5 are left as they ran, and only the rest are replayed\./);
    assert.match(ans("keep")[0], /on 2026-09-25 it offered a lower auto-compact window and you kept yours \(400k\)\./);
    assert.match(ans("undo")[0], /on 2026-09-25 you undid the lower auto-compact window it had set \(on record: 400k\)\./);
    assert.match(appWindowLines({ answers: [{ model: "claude-opus-5-5", choice: "keep", tokens: 400_000, at: AT, where: "x" }], served: [] }, 3).join("\n"), /mostly on Opus 5\.5 \(3 here\) are left as they ran/);
    const served = appWindowLines({ answers: [], served: [{ model: "claude-fable-5-2", window: 500_000 }, { model: "claude-opus-5-5", window: 600_000 }], raisedForLoad: "~/.claude/settings.json" });
    assert.deepEqual(served, [
        "Anthropic's server sets an auto-compact window on your account: 500k for Fable 5.2, 600k for Opus 5.5",
        "(Claude Code uses it where no autoCompactWindow is set).",
        "autoCompactRaisedForLoad in ~/.claude/settings.json does nothing: Claude Code reads it from the app's settings only.",
    ]);
    for (const l of [...ans("accept"), ...ans("keep"), ...ans("undo"), ...served])
        assert.ok(l.length <= 120, l);
});
test("replay: the answered model's sessions are left as they ran, billed in 'as now', saving nothing; the rest replayed", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-appwin-replay-"));
    const start = Date.now() - 86_400_000;
    const session = (name, model) => {
        const p = join(dir, `${name}.jsonl`);
        const lines = Array.from({ length: 60 }, (_, i) => ({ type: "assistant", timestamp: new Date(start + i * 60_000).toISOString(), message: { id: `${name}-${i}`, model, content: [{ type: "text", text: "ok" }], usage: { input_tokens: 5, cache_read_input_tokens: 100_000 + i * 13_500 - 5, cache_creation_input_tokens: 0, output_tokens: 10 } } }));
        writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"));
        return p;
    };
    const opus = session("o", "claude-opus-5-5");
    const fable = session("f", "claude-fable-5-1");
    const all = estimateCompactWindows([400_000], 30, [opus, fable]);
    const onlyOpus = estimateCompactWindows([400_000], 30, [opus]);
    const left = estimateCompactWindows([400_000], 30, [opus, fable], 0, undefined, { leaveModels: ["claude-fable-5-1"] });
    assert.equal(all.leftAlone, undefined, "no answer: no field, the report as before");
    assert.deepEqual(left.leftAlone, { sessions: 1, models: ["claude-fable-5-1"] });
    assert.equal(left.sessions, 2);
    const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
    near(left.estimates[0].baselineUsd, all.estimates[0].baselineUsd);
    near(left.estimates[0].savedUsd, onlyOpus.estimates[0].savedUsd);
    assert.ok(left.estimates[0].savedUsd < all.estimates[0].savedUsd);
});
test("fix: the lever says what the app chose and that applying may not win there; under $1 once left alone, said, not offered", () => {
    const app = { lines: appWindowLines({ answers: [{ model: "claude-opus-5-5", choice: "accept", tokens: 400_000, at: AT, where: "~/.claude.json" }], served: [] }), answered: ["Opus 5.5"], leftSessions: 3 };
    const cw = { window: 400_000, savedUsd: 120, savedShare: 0.1, compactionsPerWeek: 2, nowPerWeek: 1 };
    const [f] = planFixes({ days: 30, billedUsd: 1200, compactWindow: { ...cw, app } });
    assert.equal(f.state, "available");
    const text = renderFixPlan(30, 1200, [f], []);
    assert.match(text, /\n {5}The Desktop app, Opus 5\.5: on 2026-09-25 it offered a 400k auto-compact window and you accepted it\./);
    assert.match(text, /Applying writes one window for every model; whether it or the app's choice wins for Opus 5\.5 is not recorded here\./);
    // No app on file: no detail, as before.
    assert.equal(planFixes({ days: 30, billedUsd: 1200, compactWindow: cw })[0].detail, undefined);
    const small = planFixes({ days: 30, billedUsd: 1200, compactWindow: { ...cw, savedUsd: 0.4, app } });
    assert.deepEqual(small.map((x) => [x.id, x.state]), [["compact-window", "not-here"]]);
    assert.match(renderFixPlan(30, 1200, small, []), /- Compact earlier: you answered the Desktop app's own window offer for Opus 5\.5, so its 3 sessions are left alone; the rest would save under \$1/);
});
test("the CLI on the fixture history: accept, keep and undo said in compact-window and fix; none on file is the golden output", () => {
    for (const choice of ["accept", "keep", "undo"]) {
        const home = mkdtempSync(join(tmpdir(), `cd-appwin-cli-${choice}-`));
        buildHistory(home);
        const cj = join(home, ".claude.json");
        const j = JSON.parse(readFileSync(cj, "utf8"));
        // s4 runs on Fable 5.1: the app's answer for it.
        j.autoCompactOfferCodeTab = { "00000000-0000-4000-8000-000000000001": { "claude-fable-5-1": { choice, tokens: 300_000, at: AT } } };
        writeFileSync(cj, JSON.stringify(j));
        const before = readFileSync(cj, "utf8");
        const env = { CONTEXT_DOCTOR_CACHE_DIR: mkdtempSync(join(tmpdir(), "cd-appwin-cache-")) };
        const cw = runReport(cli, home, ["compact-window"], env);
        const want = { accept: "it offered a 300k auto-compact window and you accepted it.", keep: "it offered a lower auto-compact window and you kept yours (300k).", undo: "you undid the lower auto-compact window it had set (on record: 300k)." }[choice];
        assert.ok(cw.includes(`The Desktop app, Fable 5.1: on 2026-09-25 ${want}`), cw);
        assert.match(cw, /mostly on Fable 5\.1 \(1 here\) are left as they ran/);
        const json = JSON.parse(runReport(cli, home, ["compact-window", "--json"], env).replace(/\n\[exit \d+\]\s*$/, ""));
        assert.deepEqual(json.leftAlone, { sessions: 1, models: ["claude-fable-5-1"] });
        assert.equal(json.desktopApp.answers[0].choice, choice);
        const fix = runReport(cli, home, ["fix"], env);
        assert.ok(fix.includes(`The Desktop app, Fable 5.1: on 2026-09-25 ${want}`) || fix.includes("Compact earlier: you answered the Desktop app's own window offer for Fable 5.1"), fix);
        assert.equal(readFileSync(cj, "utf8"), before, "~/.claude.json is only read");
    }
    // Nothing on file: byte for byte the golden output.
    const home = mkdtempSync(join(tmpdir(), "cd-appwin-cli-none-"));
    buildHistory(home);
    const env = { CONTEXT_DOCTOR_CACHE_DIR: mkdtempSync(join(tmpdir(), "cd-appwin-cache-")) };
    for (const args of [["compact-window"], ["compact-window", "--json"], ["fix"], ["fix", "--json"]]) {
        assert.equal(runReport(cli, home, args, env), readFileSync(join(here, "..", "..", "src", "test", "golden", "base", goldenName(args)), "utf8"), args.join(" "));
    }
});
test("audit: an answer whose time is no date (out of range) is skipped, not a crash of compact-window or fix", () => {
    const home = mkdtempSync(join(tmpdir(), "cd-appwin-odd-"));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
        autoCompactOfferCodeTab: { aaa: { "claude-opus-5-5": { choice: "accept", tokens: 400_000, at: 1e20 } } },
    }));
    const a = readAppWindows({ home, cwd: home, env: NO_ENV });
    assert.deepEqual(a.answers, []);
    assert.deepEqual(appWindowLines(a), []);
});
test("audit: with a window the server sets and none in settings, compact-window's Now line does not say Claude Code compacts near the full window", () => {
    const empty = estimateCompactWindows([400_000], 30, []);
    const lines = appWindowLines({ answers: [], served: [{ model: "claude-opus-5-5", window: 600_000 }] });
    const text = renderCompactWindows(empty, undefined, undefined, lines, true);
    assert.doesNotMatch(text, /Now: not set: Claude Code compacts near the model's full window/);
    assert.match(text, /Now: not set in your settings: Claude Code compacts at the window Anthropic's server sets \(below\), else near the model's full window/);
    // No server window: as before.
    assert.match(renderCompactWindows(empty), /Now: not set: Claude Code compacts near the model's full window/);
});
test("doctor: one line saying what the Desktop app offered and what you answered, only when an answer is on file", () => {
    const ans = (choice) => appAnswerText({ answers: [{ model: "claude-fable-5-1", choice, tokens: 300_000, at: AT, where: "~/.claude.json" }], served: [] });
    assert.equal(ans("accept"), "on 2026-09-25 the Desktop app offered a 300k auto-compact window for Fable 5.1 and you accepted it");
    assert.equal(ans("keep"), "on 2026-09-25 the Desktop app offered a lower auto-compact window for Fable 5.1 and you kept yours (300k)");
    assert.equal(ans("undo"), "on 2026-09-25 you undid the lower auto-compact window the Desktop app had set for Fable 5.1 (on record: 300k)");
    // A server window alone is no answer: nothing for doctor.
    assert.equal(appAnswerText({ answers: [], served: [{ model: "claude-opus-5-5", window: 600_000 }] }), undefined);
    const home = mkdtempSync(join(tmpdir(), "cd-appwin-doctor-"));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ autoCompactOfferCodeTab: { aaa: { "claude-fable-5-1": { choice: "accept", tokens: 300_000, at: AT } } } }));
    assert.deepEqual(appWindowCheck(home), { label: "Desktop compact offer", status: "ok", detail: "on 2026-09-25 the Desktop app offered a 300k auto-compact window for Fable 5.1 and you accepted it" });
    const bare = mkdtempSync(join(tmpdir(), "cd-appwin-doctor-bare-"));
    writeFileSync(join(bare, ".claude.json"), JSON.stringify({ autoCompactWindowsCache: { "claude-opus-5-5": 600_000 } }));
    assert.equal(appWindowCheck(bare), undefined);
    // Through the CLI: the line in doctor, and nothing on the fixture history with no answer.
    const env = { CONTEXT_DOCTOR_CACHE_DIR: mkdtempSync(join(tmpdir(), "cd-appwin-cache-")) };
    const fixture = mkdtempSync(join(tmpdir(), "cd-appwin-doctor-cli-"));
    buildHistory(fixture);
    assert.ok(!/Desktop compact offer/.test(runReport(cli, fixture, ["doctor"], env)));
    const cj = join(fixture, ".claude.json");
    writeFileSync(cj, JSON.stringify({ ...JSON.parse(readFileSync(cj, "utf8")), autoCompactOfferCodeTab: { aaa: { "claude-fable-5-1": { choice: "keep", tokens: 300_000, at: AT } } } }));
    assert.match(runReport(cli, fixture, ["doctor"], env), /Desktop compact offer +on 2026-09-25 the Desktop app offered a lower auto-compact window for Fable 5\.1 and you kept yours \(300k\)/);
});
test("audit: a 1M window reads 1M, not 1000k, in doctor's line and compact-window's", () => {
    const a = { answers: [{ model: "claude-opus-5-5", choice: "keep", tokens: 1_000_000, at: AT, where: "~/.claude.json" }], served: [{ model: "claude-fable-5-1", window: 1_500_000 }, { model: "claude-opus-5-5", window: 1_000_000 }] };
    assert.equal(appAnswerText(a), "on 2026-09-25 the Desktop app offered a lower auto-compact window for Opus 5.5 and you kept yours (1M)");
    const lines = appWindowLines(a).join("\n");
    assert.match(lines, /1\.5M for Fable 5\.1, 1M for Opus 5\.5/);
    assert.ok(!/\d000k/.test(lines), lines);
});
