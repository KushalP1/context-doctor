/** fix's `subagent-model` lever: offered with its quality cost said, applied only by name, undone exactly, a value you set left alone. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyFix, fixOverrides, parseFixIds, planFixes, readFixRecords, renderFixPlan, savedSince, undoFixes } from "../fix.js";
import { sandboxEnv } from "./sandbox.js";
import { at, DAY, history, now, OPUS, reply, SONNET } from "./subagent-fixture.js";
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const near = (a, b, what = "") => assert.ok(Math.abs(a - b) < 1e-9, `${what} ${a} vs ${b}`);
// The transcript cache of this file's runs: never the developer's own.
process.env.CONTEXT_DOCTOR_CACHE_DIR = mkdtempSync(join(tmpdir(), "cd-fsm-cache-"));
/** A replay whose figures the plan tests choose. */
function replay(savedUsd, billedUsd = 1000) {
    return {
        candidate: "claude-sonnet-5-5", agents: 200, requests: 9000, billedUsd, atCandidateUsd: billedUsd - savedUsd, savedUsd, unpriced: 0, movedFrom: { "claude-opus-5-5": 900 }, before: { "claude-opus-5-5": 450 },
        byType: [
            { type: "general-purpose", agents: 180, requests: 8000, billedUsd: 900, atCandidateUsd: 900 - savedUsd, atHaikuUsd: 30, over100k: 10, moves: true, readOnly: false },
            { type: "Explore", agents: 20, requests: 1000, billedUsd: 100, atCandidateUsd: 100, atHaikuUsd: 3, over100k: 0, moves: false, why: "built in, on the main conversation's model", readOnly: true },
        ],
    };
}
const base = { days: 30, billedUsd: 2000 };
test("plan: ranked by dollars, says plainly it changes the model, never in --apply all, a value you set is left alone", () => {
    const fixes = planFixes({ ...base, compactWindow: { window: 400_000, savedUsd: 500, savedShare: 0.25, compactionsPerWeek: 9, nowPerWeek: 3 }, subagentModel: replay(600) });
    assert.deepEqual(fixes.map((f) => f.id), ["subagent-model", "compact-window"]);
    const f = fixes[0];
    assert.equal(f.title, "Subagents on Sonnet 5.5, not Opus 5.5");
    assert.equal(f.value, "claude-sonnet-5-5");
    near(f.savedShare, 0.6);
    assert.match(f.quality, /changes the model your subagents run on \(general-purpose\)/);
    assert.match(f.quality, /not measured here/);
    assert.match(f.quality, /context-doctor ab/);
    assert.match(f.basis, /an estimate/);
    assert.match(f.change, /env\.CLAUDE_CODE_SUBAGENT_MODEL = "claude-sonnet-5-5"/);
    const text = renderFixPlan(30, 2000, fixes, []);
    assert.match(text, /1\. Subagents on Sonnet 5\.5, not Opus 5\.5 +\$600 \(60%\)/);
    assert.match(text, /Explore .* unchanged/);
    assert.match(text, /Explore, \$100\) at Haiku 5\.5: ~\$3\.00\./);
    // --apply all leaves it out; naming it applies it.
    assert.deepEqual(parseFixIds("all", fixes).ids, ["compact-window"]);
    assert.deepEqual(parseFixIds("all,subagent-model", fixes).ids, ["compact-window", "subagent-model"]);
    assert.deepEqual(parseFixIds("subagent-model", fixes).ids, ["subagent-model"]);
    // Subagents already on Sonnet (nothing to save): not offered.
    assert.deepEqual(planFixes({ ...base, subagentModel: replay(0) }), []);
    // A value the user set is named, not offered; "inherit" is their choice too.
    const set = planFixes({ ...base, subagentModel: replay(600), subagentModelSet: { value: "claude-haiku-5-5", where: "~/.claude/settings.json env" } });
    assert.deepEqual(set.map((x) => [x.id, x.state]), [["subagent-model", "applied"]]);
    assert.match(set[0].note, /CLAUDE_CODE_SUBAGENT_MODEL=claude-haiku-5-5 in ~\/\.claude\/settings\.json env/);
    const inherit = planFixes({ ...base, subagentModel: replay(600), subagentModelSet: { value: "inherit", where: "the environment" } });
    assert.equal(inherit[0].state, "not-here");
    assert.match(renderFixPlan(30, 2000, inherit, []), /- Subagent model: CLAUDE_CODE_SUBAGENT_MODEL=inherit in the environment: left as you set it \(Sonnet 5\.5 would have cost \$600 less\)/);
    // Blank is unset to Claude Code (subagents inherit): left alone like "inherit", not reported as applied.
    const blank = planFixes({ ...base, subagentModel: replay(600), subagentModelSet: { value: "", where: "~/.claude/settings.json env" } });
    assert.equal(blank[0].state, "not-here");
    assert.match(renderFixPlan(30, 2000, blank, []), /- Subagent model: CLAUDE_CODE_SUBAGENT_MODEL="" in ~\/\.claude\/settings\.json env: left as you set it/);
    // A project setting that overrides it is named.
    const over = planFixes({ ...base, subagentModel: replay(600), overrides: { "subagent-model": ["CLAUDE_CODE_SUBAGENT_MODEL=inherit in /p/.claude/settings.json env"] } });
    assert.match(renderFixPlan(30, 2000, over, []), /⚠ would not take effect: CLAUDE_CODE_SUBAGENT_MODEL=inherit in \/p\/\.claude\/settings\.json env/);
});
test("apply then undo: settings.json byte for byte; an existing value, in the file or the environment, is never overwritten", async () => {
    const home = mkdtempSync(join(tmpdir(), "cd-sm-rt-"));
    mkdirSync(join(home, ".claude"));
    const settings = join(home, ".claude", "settings.json");
    const [fix] = planFixes({ ...base, subagentModel: replay(600) });
    const deps = { home, now: 5_000, env: {}, cwd: home };
    for (const original of [undefined, '{\r\n    "model": "opus",\r\n    "env": {\r\n        "FOO": "1"\r\n    }\r\n}\r\n', '{"theme":"dark","n":1.0}']) {
        if (original === undefined)
            assert.ok(!existsSync(settings));
        else
            writeFileSync(settings, original);
        const r = await applyFix(fix, deps, { modelsBefore: { "claude-opus-5-5": 1 } });
        assert.equal(r.ok, true, r.lines.join("\n"));
        assert.equal(JSON.parse(readFileSync(settings, "utf8")).env.CLAUDE_CODE_SUBAGENT_MODEL, "claude-sonnet-5-5");
        const rec = readFixRecords(home).find((x) => x.id === "subagent-model");
        assert.deepEqual(rec.modelsBefore, { "claude-opus-5-5": 1 });
        assert.equal(rec.hadPrevious, false);
        const lines = await undoFixes(["subagent-model"], deps);
        assert.match(lines.join("\n"), /✓ env\.CLAUDE_CODE_SUBAGENT_MODEL removed/);
        if (original === undefined)
            assert.ok(!existsSync(settings), "the file fix created goes again");
        else
            assert.equal(readFileSync(settings, "utf8"), original);
    }
    // Set by the user, even to "inherit": refused, the file untouched, nothing recorded.
    const mine = '{\n  "env": { "CLAUDE_CODE_SUBAGENT_MODEL": "inherit" }\n}\n';
    writeFileSync(settings, mine);
    const r = await applyFix(fix, deps);
    assert.equal(r.ok, false);
    assert.match(r.lines[0], /"inherit" in .*settings\.json, a value you set: left as it is/);
    assert.equal(readFileSync(settings, "utf8"), mine);
    assert.deepEqual(readFixRecords(home), []);
    // Set in the environment Claude Code starts in: a settings value would override it, so refused too.
    writeFileSync(settings, "{}\n");
    const e = await applyFix(fix, { ...deps, env: { CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-5-5" } });
    assert.equal(e.ok, false);
    assert.match(e.lines[0], /CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-5-5 in the environment/);
    assert.equal(readFileSync(settings, "utf8"), "{}\n");
});
test("a project or managed settings env that overrides the value is named, and applying says so", async () => {
    const home = mkdtempSync(join(tmpdir(), "cd-sm-ov-"));
    mkdirSync(join(home, ".claude"));
    const cwd = mkdtempSync(join(tmpdir(), "cd-sm-ov-proj-"));
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, ".claude", "settings.local.json"), '{"env": {"CLAUDE_CODE_SUBAGENT_MODEL": "claude-opus-5-5"}}');
    const managed = join(cwd, "managed.json");
    writeFileSync(managed, '{"env": {"CLAUDE_CODE_SUBAGENT_MODEL": "inherit"}}');
    const env = { CLAUDE_CODE_MANAGED_SETTINGS_PATH: managed };
    const over = fixOverrides("subagent-model", { home, cwd, env });
    assert.equal(over.length, 2);
    assert.match(over[0], /CLAUDE_CODE_SUBAGENT_MODEL=inherit in .*managed\.json env/);
    assert.match(over[1], /CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-5-5 in .*settings\.local\.json env/);
    const [fix] = planFixes({ ...base, subagentModel: replay(600) });
    const r = await applyFix(fix, { home, cwd, env });
    assert.equal(r.ok, false);
    assert.match(r.lines.join("\n"), /⚠ written, but it will not take effect while .*managed\.json env; .*settings\.local\.json env override it/);
});
test("since: the moved requests priced at the models they ran on before, against as billed", () => {
    const { sub } = history((cwd) => [{ id: "f1", type: "general-purpose", rows: reply(at, "claude-sonnet-5-5", cwd) }]);
    const paths = [join(sub, "agent-f1.jsonl")];
    const [r] = savedSince([{ id: "subagent-model", at: now - 30 * DAY, value: "claude-sonnet-5-5", modelsBefore: { "claude-opus-5-5": 1 } }], { subagentPaths: paths });
    near(r.savedUsd, OPUS - SONNET);
    assert.match(r.detail, /1 subagent requests, priced at the model they ran on before \(Opus 5\.5\)/);
});
test("CLI: fix offers it in a throwaway home, applies it only when named, undo removes exactly that", () => {
    const { home, cwd } = history((cwd) => [
        ...Array.from({ length: 12 }, (_, k) => ({ id: `e${k}`, type: "general-purpose", rows: Array.from({ length: 5 }, (_, i) => reply(at + k * 60_000 + i * 1000, "claude-opus-5-5", cwd)).flat() })),
        // As many requests from a Sonnet session: not moved, but half the mix "saved since" compares against.
        { id: "s0", type: "general-purpose", rows: Array.from({ length: 60 }, (_, i) => reply(at + i * 1000, "claude-sonnet-5-5", cwd)).flat() },
    ]);
    const settings = join(home, ".claude", "settings.json");
    const original = '{\n  "model": "opus"\n}\n';
    writeFileSync(settings, original);
    const run = (...args) => spawnSync(process.execPath, [cli, "fix", ...args], { encoding: "utf8", cwd, env: { ...sandboxEnv(home), CLAUDE_CODE_SUBAGENT_MODEL: "", CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS: "2.1.309" }, input: "" });
    let r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Subagents on Sonnet 5\.5, not Opus 5\.5/);
    assert.match(r.stdout, /general-purpose\s+13/);
    assert.equal(readFileSync(settings, "utf8"), original, "nothing written without --apply");
    r = run("--apply", "subagent-model");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(JSON.parse(readFileSync(settings, "utf8")).env.CLAUDE_CODE_SUBAGENT_MODEL, "claude-sonnet-5-5");
    const mix = readFixRecords(home).find((x) => x.id === "subagent-model").modelsBefore;
    near(mix["claude-opus-5-5"], 0.5, "opus share");
    near(mix["claude-sonnet-5-5"], 0.5, "sonnet share");
    r = run();
    assert.match(r.stdout, /✓ Subagent model: CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-5-5 in .*settings\.json env since \d{4}-\d\d-\d\d: no subagent requests it moves yet/);
    r = run("undo", "subagent-model");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(readFileSync(settings, "utf8")).env, undefined);
    r = run("undo");
    assert.equal(r.status, 0, r.stderr);
});
