/** fix for Codex: its auto-compact limit replayed on rollouts, written key by key in config.toml, undone byte for byte, planned on a machine with no Claude Code. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexCompactOverrides, codexCompactSavedSince, profileValues, replayCodexCompact, setTopLevelInt, topLevelValue } from "../codexcompact.js";
import { applyFix, fixRecordPath, parseFixIds, planFixes, readFixRecords, renderFixPlan, savedSince, undoFixes } from "../fix.js";
import { sandboxEnv } from "./sandbox.js";
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const near = (a, b, what = "") => assert.ok(Math.abs(a - b) < 1e-9, `${what} ${a} vs ${b}`);
process.env.CONTEXT_DOCTOR_CACHE_DIR = mkdtempSync(join(tmpdir(), "cd-fcx-cache-"));
const DAY = 86_400_000;
const t0 = Date.now() - 2 * DAY;
// gpt-5.5 in the price table: $1.25 in, $0.125 cached, $10 out.
const IN = 1.25, READ = 0.125, OUT = 10;
/** A rollout's lines: requests [input, cached, output], "c" for a compaction (the item and its event, as Codex writes them). */
function rollout(steps, start = t0) {
    const lines = [
        JSON.stringify({ timestamp: new Date(start).toISOString(), type: "session_meta", payload: { id: "s", cwd: "/tmp/p" } }),
        JSON.stringify({ timestamp: new Date(start).toISOString(), type: "turn_context", payload: { model: "gpt-5.5", cwd: "/tmp/p" } }),
    ];
    let total = 0;
    steps.forEach((s, i) => {
        const ts = new Date(start + (i + 1) * 10_000).toISOString();
        if (s === "c") {
            lines.push(JSON.stringify({ timestamp: ts, type: "compacted", payload: { message: "", replacement_history: [] } }));
            lines.push(JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "context_compacted" } }));
            return;
        }
        const [input, cached, output] = s;
        total += input + output;
        const last = { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output };
        const info = { total_token_usage: { ...last, total_tokens: total }, last_token_usage: last, model_context_window: 258_400 };
        lines.push(JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info } }));
        // Codex repeats the last request when only the limits were refreshed: not a request.
        if (i === 0)
            lines.push(JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info } }));
    });
    return lines;
}
function file(lines, dir = mkdtempSync(join(tmpdir(), "cd-cx-")), name = "rollout-2026-11-02T10-00-00-a.jsonl") {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, name);
    writeFileSync(p, lines.join("\n") + "\n");
    return p;
}
const billed = (input, cached) => ((input - cached) * IN + cached * READ) / 1e6;
test("replay: a compaction at the limit, the request after it uncached, the context it removed read no more", () => {
    const p = file(rollout([[140_000, 130_000, 1_000], [150_000, 140_000, 1_000], [160_000, 150_000, 1_000], [170_000, 160_000, 1_000]]));
    const r = replayCodexCompact({ days: 30, paths: [p], limits: [150_000, 300_000] });
    assert.equal(r.requests, 4, "the repeated token_count is not a request");
    const asBilled = billed(140_000, 130_000) + billed(150_000, 140_000) + billed(160_000, 150_000) + billed(170_000, 160_000);
    near(r.billedUsd, asBilled, "billed");
    assert.equal(r.afterCompact, 25_000, "no compaction of the user's own: 25k");
    // At 150k: the second turn (150k + 1k out) compacts: a request reading 150k and a 5k summary.
    // The third request starts from 25k plus what it added (160k - 151k), all uncached; the fourth reads 126k less.
    const removed = 151_000 - 25_000;
    const sim = billed(140_000, 130_000) + billed(150_000, 140_000) + (150_000 * READ + 5_000 * OUT) / 1e6 + ((160_000 - removed) * IN) / 1e6 + billed(170_000, 160_000) - (removed * READ) / 1e6;
    const [at150, at300] = r.estimates;
    near(at150.savedUsd, asBilled - sim, "saved");
    assert.equal(at150.compactions, 1);
    // Over Codex's own trigger (90% of 272k = 244.8k) a limit changes nothing.
    near(at300.savedUsd, 0);
    assert.equal(at300.compactions, 0);
});
test("replay: a long session pays; real compactions reset the arm and set the context after; forks are billed once", () => {
    const long = [];
    for (let i = 0; i < 200; i++)
        long.push([140_000 + i * 500, 138_000 + i * 500, 500]);
    const dir = mkdtempSync(join(tmpdir(), "cd-cx-long-"));
    const p = file(rollout(long), dir);
    const r = replayCodexCompact({ days: 30, paths: [p] });
    const at150 = r.estimates.find((e) => e.limit === 150_000);
    assert.ok(at150.savedUsd > 1 && at150.savedShare > 0.3, JSON.stringify(at150));
    // A fork copies its parent's events: the same requests again, not billed twice.
    const fork = file(rollout(long), dir, "rollout-2026-11-02T11-00-00-b.jsonl");
    const both = replayCodexCompact({ days: 30, paths: [p, fork] });
    assert.equal(both.requests, r.requests);
    near(both.billedUsd, r.billedUsd);
    near(both.estimates[1].savedUsd, at150.savedUsd);
    // A real compaction: counted, and the context after it is what the replay compacts to.
    const real = file(rollout([[200_000, 190_000, 1_000], [240_000, 200_000, 1_000], "c", [22_000, 0, 500], [30_000, 22_000, 500]]));
    const rr = replayCodexCompact({ days: 30, paths: [real], limits: [150_000] });
    assert.equal(rr.actualCompactions, 1);
    assert.equal(rr.afterCompact, 22_000);
});
test("since: a compaction before the old trigger, priced at the requests after it until the session would have reached it", () => {
    const p = file(rollout([[150_000, 140_000, 1_000], "c", [25_000, 0, 500], [35_000, 25_000, 500], [45_000, 35_000, 500]]));
    const s = codexCompactSavedSince(t0 - DAY, undefined, [p]);
    assert.equal(s.compactions, 1);
    // 151k before; each later request would have carried it: 151k + growth since 25k, less what it holds now.
    near(s.usd, -(151_000 * READ + 5_000 * OUT) / 1e6 + ((151_000 + 10_000 - 35_000) * READ + (151_000 + 20_000 - 45_000) * READ) / 1e6);
    const [r] = savedSince([{ id: "codex-compact", at: t0 - DAY, value: 150_000 }], { codexPaths: [p] });
    near(r.savedUsd, s.usd);
    assert.match(r.detail, /1 earlier Codex compaction/);
});
test("config.toml: the key set and removed byte for byte (comments, CRLF, tables, no final newline), profiles named", () => {
    const K = "model_auto_compact_token_limit";
    assert.equal(setTopLevelInt(undefined, K, 150_000), `${K} = 150000\n`);
    const crlf = '# my config\r\nmodel = "gpt-5.5"  # pinned\r\n\r\n# servers\r\n[mcp_servers.x]\r\ncommand = "x"\r\n';
    const set = setTopLevelInt(crlf, K, 150_000);
    assert.equal(set, `# my config\r\nmodel = "gpt-5.5"  # pinned\r\n${K} = 150000\r\n\r\n# servers\r\n[mcp_servers.x]\r\ncommand = "x"\r\n`);
    assert.equal(setTopLevelInt(set, K, undefined), crlf);
    assert.deepEqual(topLevelValue(set), { raw: "150000", value: 150_000 });
    // Only tables: the key goes first, every table untouched.
    const tables = "[profiles.fast]\nmodel = \"gpt-5.5\"\n" + `${K} = 90000\n`;
    assert.equal(setTopLevelInt(tables, K, 150_000), `${K} = 150000\n${tables}`);
    assert.equal(topLevelValue(tables), undefined, "a profile's value is not the top-level one");
    // Replaced in place, its line end kept; no final newline stays none.
    assert.equal(setTopLevelInt(`a = 1\n${K} = 1_000  # mine\r\nb = 2`, K, 5), `a = 1\n${K} = 5\r\nb = 2`);
    assert.deepEqual(topLevelValue(`${K} = 1_000  # mine\n`), { raw: "1_000", value: 1000 });
    assert.equal(setTopLevelInt("a = 1", K, 5), `a = 1\n${K} = 5`);
    assert.deepEqual(profileValues(`profile = "fast"\n${tables}[profiles."slow one"]\n${K} = 50000\n`), [{ profile: "fast", raw: "90000", selected: true }, { profile: "slow one", raw: "50000", selected: false }]);
});
/** A report whose figures the plan tests choose. */
function report(savedUsd, billedUsd = 10) {
    return { days: 30, rollouts: 3, requests: 400, billedUsd, unpriced: 0, actualCompactions: 1, afterCompact: 25_000, estimates: [100_000, 150_000, 200_000].map((limit) => ({ limit, savedUsd: limit === 150_000 ? savedUsd : savedUsd / 2, savedShare: (limit === 150_000 ? savedUsd : savedUsd / 2) / billedUsd, compactions: 4 })) };
}
const base = { days: 30, billedUsd: 0 };
test("plan: offered over $1 and 2% of Codex's input, in --apply all; a limit you set is yours; a profile's is named", () => {
    const fixes = planFixes({ ...base, codexCompact: report(4) });
    assert.deepEqual(fixes.map((f) => f.id), ["codex-compact"]);
    const f = fixes[0];
    assert.equal(f.title, "Codex: compact earlier, at 150k tokens");
    assert.equal(f.value, 150_000);
    assert.match(f.change.replace(/\\/g, "/"), /\.codex\/config\.toml: model_auto_compact_token_limit = 150000/);
    assert.match(f.basis, /your 400 Codex requests replayed at a 150k limit: 0\.9 compactions a week instead of 0\.2/);
    assert.match(f.quality, /detail for money/);
    const text = renderFixPlan(30, 0, fixes, [], undefined, undefined, undefined, 10);
    assert.match(text, /Last 30 days of your Codex sessions, \$10\.00 of input at list prices/);
    assert.match(text, /1\. Codex: compact earlier, at 150k tokens\s+\$4\.00 \(40% of Codex input\)/);
    assert.match(text, /150k\s+\$4\.00   0\.9  ←/);
    assert.match(renderFixPlan(30, 50, fixes, [], undefined, undefined, undefined, 10), /Last 30 days of your sessions: Claude Code \$50\.00 of input, Codex \$10\.00, at list prices/);
    assert.deepEqual(parseFixIds("all", fixes).ids, ["codex-compact"]);
    assert.deepEqual(planFixes({ ...base, codexCompact: report(0.5) }), []);
    assert.deepEqual(planFixes({ ...base, codexCompact: report(1.5, 100) }), []);
    const mine = planFixes({ ...base, codexCompact: report(4), codexCompactSet: { raw: "200_000", where: "~/.codex/config.toml" } });
    assert.deepEqual(mine.map((x) => [x.id, x.state]), [["codex-compact", "applied"]]);
    assert.match(renderFixPlan(30, 0, mine, [], undefined, undefined, undefined, 10), /✓ Codex auto-compact limit: model_auto_compact_token_limit = 200_000 in ~\/\.codex\/config\.toml/);
    const over = planFixes({ ...base, codexCompact: report(4), overrides: { "codex-compact": ["model_auto_compact_token_limit = 90000 in [profiles.fast] of ~/.codex/config.toml (the profile it selects)"] } });
    assert.match(renderFixPlan(30, 0, over, [], undefined, undefined, undefined, 10), /⚠ would not take effect: model_auto_compact_token_limit = 90000 in \[profiles\.fast\]/);
});
test("apply then undo: config.toml byte for byte, a missing one removed again, a value you set left alone, a profile named", async () => {
    const home = mkdtempSync(join(tmpdir(), "cd-cx-rt-"));
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".codex"));
    const config = join(home, ".codex", "config.toml");
    const [fix] = planFixes({ ...base, codexCompact: report(4) });
    const deps = { home, cwd: home, now: 5_000 };
    for (const original of [undefined, '# mine\r\nmodel = "gpt-5.5"\r\n\r\n[mcp_servers.x] # tools\r\ncommand = "x"\r\n', 'approval_policy = "never"']) {
        if (original === undefined)
            assert.ok(!existsSync(config));
        else
            writeFileSync(config, original);
        const r = await applyFix(fix, deps);
        assert.equal(r.ok, true, r.lines.join("\n"));
        assert.equal(topLevelValue(readFileSync(config, "utf8"))?.value, 150_000);
        const rec = readFixRecords(home).find((x) => x.id === "codex-compact");
        assert.equal(rec.hadPrevious, false);
        assert.equal(fixRecordPath(home), join(home, ".claude", ".context-doctor-fixes.json"), "with a ~/.claude, the records stay there");
        assert.match((await undoFixes(["codex-compact"], deps)).join("\n"), /✓ model_auto_compact_token_limit removed/);
        if (original === undefined)
            assert.ok(!existsSync(config), "the file fix created goes again");
        else
            assert.equal(readFileSync(config, "utf8"), original);
    }
    // Changed since (another key): undo takes out just the key.
    writeFileSync(config, "a = 1\n");
    await applyFix(fix, deps);
    writeFileSync(config, readFileSync(config, "utf8").replace("a = 1", "a = 2"));
    await undoFixes(["codex-compact"], deps);
    assert.equal(readFileSync(config, "utf8"), "a = 2\n");
    // A value you set: refused, untouched, nothing recorded.
    const yours = "model_auto_compact_token_limit = 200000\n";
    writeFileSync(config, yours);
    const r = await applyFix(fix, deps);
    assert.equal(r.ok, false);
    assert.match(r.lines[0], /model_auto_compact_token_limit is 200000 in .*config\.toml, a value you set: left as it is/);
    assert.equal(readFileSync(config, "utf8"), yours);
    assert.deepEqual(readFixRecords(home), []);
    // A profile that sets its own: written, and named.
    writeFileSync(config, '[profiles.fast]\nmodel_auto_compact_token_limit = 90000\n');
    assert.match(codexCompactOverrides(home, home)[0], /model_auto_compact_token_limit = 90000 in \[profiles\.fast\] of .*config\.toml \(when Codex runs with --profile fast\)/);
    const o = await applyFix(fix, deps);
    assert.equal(o.ok, false);
    assert.match(o.lines.join("\n"), /⚠ written, but it will not take effect while .*\[profiles\.fast\].* sets it too/);
    await undoFixes(undefined, deps);
    assert.equal(readFileSync(config, "utf8"), '[profiles.fast]\nmodel_auto_compact_token_limit = 90000\n');
});
test("a Codex-only machine: fix plans and applies Codex's limit, makes no ~/.claude, and undo puts config.toml back", () => {
    const home = mkdtempSync(join(tmpdir(), "cd-cx-only-"));
    const day = new Date(t0);
    const dir = join(home, ".codex", "sessions", String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, "0"), String(day.getUTCDate()).padStart(2, "0"));
    const long = [];
    for (let i = 0; i < 200; i++)
        long.push([140_000 + i * 500, 138_000 + i * 500, 500]);
    file(rollout(long), dir);
    const config = join(home, ".codex", "config.toml");
    const original = '# Codex\nmodel = "gpt-5.5"\n\n[mcp_servers.docs]\ncommand = "docs"\n';
    writeFileSync(config, original);
    const cwd = mkdtempSync(join(tmpdir(), "cd-cx-cwd-"));
    const run = (...args) => spawnSync(process.execPath, [cli, "fix", ...args], { encoding: "utf8", cwd, env: { ...sandboxEnv(home), CONTEXT_DOCTOR_CACHE_DIR: mkdtempSync(join(tmpdir(), "cd-cx-c-")), CONTEXT_DOCTOR_NO_MANAGED_SETTINGS: "1" }, input: "" });
    let r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Last 30 days of your Codex sessions/);
    assert.match(r.stdout, /Codex: compact earlier, at 150k tokens/);
    assert.match(r.stdout, /\[codex-compact\]/);
    assert.equal(readFileSync(config, "utf8"), original, "nothing written without --apply");
    r = run("--apply", "codex-compact");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /New Codex sessions pick these up/);
    assert.equal(readFileSync(config, "utf8"), original.replace('model = "gpt-5.5"\n', 'model = "gpt-5.5"\nmodel_auto_compact_token_limit = 150000\n'));
    assert.ok(!existsSync(join(home, ".claude")), "no ~/.claude made");
    // The state folder: ~/.local/state, or %LOCALAPPDATA% on Windows (ledger.ts fallbackStateDir).
    const stateFolder = process.platform === "win32" ? join(home, "AppData", "Local", "context-doctor") : join(home, ".local", "state", "context-doctor");
    assert.ok(existsSync(join(stateFolder, ".context-doctor-fixes.json")), "the record in the state folder");
    r = run();
    assert.match(r.stdout, /✓ Codex auto-compact limit: model_auto_compact_token_limit = 150000 in .*config\.toml since \d{4}-\d\d-\d\d: no earlier Codex compaction yet/);
    r = run("undo");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(config, "utf8"), original);
    assert.ok(!existsSync(join(home, ".claude")), "still no ~/.claude");
});
