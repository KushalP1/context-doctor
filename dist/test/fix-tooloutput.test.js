/** fix's `tool-output` lever: long Bash output replayed at lower caps, priced as billed, applied key by key, a value you set left alone. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { breakEven, replayToolOutput, toolOutputSavedSince } from "../tooloutput.js";
import { applyFix, fixOverrides, parseFixIds, planFixes, readFixRecords, renderFixPlan, savedSince, undoFixes } from "../fix.js";
import { sandboxEnv } from "./sandbox.js";
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const near = (a, b, what = "") => assert.ok(Math.abs(a - b) < 1e-9, `${what} ${a} vs ${b}`);
process.env.CONTEXT_DOCTOR_CACHE_DIR = mkdtempSync(join(tmpdir(), "cd-fto-cache-"));
const DAY = 86_400_000;
const t0 = Date.now() - 2 * DAY;
const OPUS = "claude-opus-5-5"; // $4 in, $0.20 cache read; 1-hour writes at 2x
let n = 0;
/** A reply calling one tool: usage `read` cached + `write` written at 1 hour. */
function call(at, read, write, tool, extra = {}) {
    const id = `msg_to${n++}`;
    return JSON.stringify({
        type: "assistant", uuid: `u-${id}`, timestamp: new Date(at).toISOString(), ...extra,
        message: { id, model: OPUS, content: tool ? [{ type: "tool_use", id: tool.id, name: tool.name, input: { command: "x" } }] : [{ type: "text", text: "ok" }], usage: { input_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write } } },
    });
}
const result = (id, content, extra = {}) => JSON.stringify({ type: "user", uuid: `r-${id}`, timestamp: new Date(t0).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...extra }] } });
const compact = () => JSON.stringify({ type: "system", subtype: "compact_boundary", uuid: `c${n++}`, timestamp: new Date(t0).toISOString(), compactMetadata: { trigger: "auto", preTokens: 300_000 } });
/** A transcript in a folder of its own. */
function transcript(rows) {
    const p = join(mkdtempSync(join(tmpdir(), "cd-to-")), "s.jsonl");
    writeFileSync(p, rows.join("\n") + "\n");
    return p;
}
// 20,000 characters of prose: 7,273 tokens at Claude's 2.75 a token; the preview and its wrapper (2,250) 819.
const LONG = "a ".repeat(10_000);
const E = Math.ceil(20_000 / 2.75) - Math.ceil(2_250 / 2.75);
test("replay: the tokens past the preview, written once, then read by every later request until a compaction", () => {
    const p = transcript([
        call(t0, 100_000, 1_000, { id: "t1", name: "Bash" }),
        result("t1", LONG),
        call(t0 + 10_000, 101_000, 8_000),
        call(t0 + 20_000, 109_000, 500),
        compact(),
        call(t0 + 30_000, 0, 80_000),
        call(t0 + 40_000, 80_000, 500),
    ]);
    const r = replayToolOutput({ since: t0 - DAY, paths: [p], caps: [8_000, 25_000] });
    assert.equal(r.requests, 5);
    const [at8, at25] = r.bash;
    assert.equal(at8.moved, 1);
    assert.equal(at8.results, 1);
    assert.equal(at25.moved, 0);
    // The first request after it writes it (1-hour writes: 2 x $4), the next reads it ($0.20); after the compaction, nothing.
    near(at8.savedUsd, (E * 8 + E * 0.2) / 1e6, "saved");
    near(at8.tokens, 2 * E, "tokens");
    // Opening the file once costs about the context it re-reads.
    near(at8.openUsd, (109_010 * 0.2) / 1e6, "open");
    near(breakEven(at8), at8.savedUsd / (at8.savedUsd + at8.openUsd));
    assert.equal(r.recommended, 8_000);
});
test("replay: failed commands, images, output already in a file and other tools are not moved; a cold request re-writes; MCP has its own cap", () => {
    const p = transcript([
        call(t0, 100_000, 1_000, { id: "e1", name: "Bash" }),
        result("e1", LONG, { is_error: true }),
        call(t0 + 1_000, 100_000, 1_000, { id: "i1", name: "Bash" }),
        result("i1", [{ type: "text", text: LONG }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }]),
        call(t0 + 2_000, 100_000, 1_000, { id: "p1", name: "Bash" }),
        result("p1", "<persisted-output>\nOutput too large (43.1KB). Full output saved to: /x/tool-results/p1.txt\n\nPreview (first 2KB):\nabc\n...\n</persisted-output>"),
        call(t0 + 3_000, 100_000, 1_000, { id: "r1", name: "Read" }),
        result("r1", LONG),
        call(t0 + 4_000, 100_000, 1_000, { id: "m1", name: "mcp__srv__big" }),
        result("m1", [{ type: "text", text: "b ".repeat(20_000) }]),
        call(t0 + 5_000, 100_000, 1_000, { id: "b1", name: "PowerShell" }),
        result("b1", LONG),
        call(t0 + 6_000, 100_000, 2_000),
        // An hour later the cache is cold: the whole context written again, the moved tokens with it.
        call(t0 + 3_700_000, 0, 103_000),
    ]);
    const r = replayToolOutput({ since: t0 - DAY, paths: [p], caps: [8_000] });
    const [b] = r.bash;
    assert.equal(r.alreadyMoved, 1);
    assert.equal(b.moved, 1, "the PowerShell result only");
    assert.equal(b.results, 1, "a failed command, an image, output already in a file and a Read result are not Bash results a cap moves");
    near(b.savedUsd, (E * 8 + E * 8) / 1e6, "written, then written again when cold");
    // 40,000 characters of prose: 14,546 tokens, over 10k; what replaces it is a 700-character notice.
    assert.equal(r.mcp.moved, 1);
    // Written by the next request (the PowerShell call), read by one, written again when cold.
    near(r.mcp.savedUsd, (Math.ceil(40_000 / 2.75) - Math.ceil(700 / 2.75)) * (8 + 0.2 + 8) / 1e6, "mcp");
});
test("replay: a fork's copied requests are billed once; a context cut with no compaction takes the result with it", () => {
    const rows = [
        call(t0, 100_000, 1_000, { id: "t1", name: "Bash" }),
        result("t1", LONG),
        call(t0 + 10_000, 101_000, 8_000),
    ];
    const a = transcript(rows);
    // The fork copies the history (same uuids), then goes on: its own request re-reads the result.
    const b = transcript([...rows, call(t0 + 20_000, 109_000, 500)]);
    const r = replayToolOutput({ since: t0 - DAY, paths: [a, b], caps: [8_000] });
    assert.equal(r.requests, 3);
    near(r.bash[0].savedUsd, (E * 8 + E * 0.2) / 1e6);
    // A rewind: the context falls to a third without a compaction.
    const c = transcript([...rows, call(t0 + 20_000, 30_000, 500), call(t0 + 30_000, 30_500, 500)]);
    const cut = replayToolOutput({ since: t0 - DAY, paths: [c], caps: [8_000] });
    near(cut.bash[0].savedUsd, (E * 8) / 1e6);
});
test("since: output Claude Code moved to a file that the cap before left inline, priced the same way", () => {
    const persisted = (size) => `<persisted-output>\nOutput too large (${size}). Full output saved to: /x/t.txt\n\nPreview (first 2KB):\n${"c".repeat(2000)}\n...\n</persisted-output>`;
    const p = transcript([
        call(t0, 100_000, 1_000, { id: "a", name: "Bash" }),
        result("a", persisted("19.5KB")),
        call(t0 + 1_000, 100_000, 1_000, { id: "b", name: "Bash" }),
        // Over 30,000 characters: the old cap moved it too.
        result("b", persisted("40KB")),
        call(t0 + 2_000, 100_000, 1_000),
        call(t0 + 3_000, 100_000, 1_000),
    ]);
    const s = toolOutputSavedSince(t0 - DAY, 30_000, [p]);
    assert.equal(s.moved, 1);
    const preview = 2000 + "<persisted-output>\nOutput too large (19.5KB). Full output saved to: /x/t.txt\n\nPreview (first 2KB):\n\n...\n</persisted-output>".length;
    const e = Math.ceil(Math.round(19.5 * 1024) / 2.75) - Math.ceil(Math.min(preview, 2_250) / 2.75);
    near(s.savedUsd, (e * 8 + e * 0.2 + e * 0.2) / 1e6);
    const [r] = savedSince([{ id: "tool-output", at: t0 - DAY, value: 8000 }], { paths: [p] });
    near(r.savedUsd, s.savedUsd);
    assert.match(r.detail, /1 Bash results moved to a file that were inline before/);
});
/** A replay whose figures the plan tests choose. */
function replay(savedUsd, billedUsd = 1000) {
    const cap = (c, saved) => ({ cap: c, moved: 100, results: 1000, tokens: 1e6, savedUsd: saved, openUsd: saved / 4 });
    return { transcripts: 3, requests: 900, billedUsd, alreadyMoved: 4, bash: [cap(8_000, savedUsd), cap(12_000, savedUsd / 2)], mcp: { cap: 10_000, moved: 2, results: 50, tokens: 1, savedUsd: 0.4, openUsd: 0.1 }, recommended: 8_000 };
}
const base = { days: 30, billedUsd: 2000 };
test("plan: offered over $1 and 2% with the preview said plainly, in --apply all; a cap you set is yours", () => {
    const fixes = planFixes({ ...base, toolOutput: replay(300), compactWindow: { window: 400_000, savedUsd: 500, savedShare: 0.25, compactionsPerWeek: 9, nowPerWeek: 3 } });
    assert.deepEqual(fixes.map((f) => f.id), ["compact-window", "tool-output"]);
    const f = fixes[1];
    assert.equal(f.title, "Long Bash output to a file past 8k characters");
    assert.equal(f.value, 8_000);
    assert.match(f.quality, /a file the model can still open; it sees the first 2,000 characters and the path/);
    assert.match(f.basis, /100 of 1,000 Bash results were longer/);
    assert.match(f.basis, /an estimate: a file the model opens again costs about \$0\.75 a time and is not counted, and the saving covers it opening up to 80% of them/);
    assert.match(f.change, /bashOutputMaxChars = 8000 \(Claude Code 2\.1\.261\+\)/);
    const text = renderFixPlan(30, 2000, fixes, []);
    assert.match(text, /2\. Long Bash output to a file past 8k characters\s+\$300 \(30% of input, subagents included\)/);
    assert.match(text, /8k\s+100 of 1,000\s+\$300   over 80% of them  ←/);
    assert.match(text, /MCP results over 10k tokens: 2 of 50, \$0\.40 re-reading them; not offered/);
    // The content stays in a file the model can open: --apply all includes it.
    assert.deepEqual(parseFixIds("all", fixes).ids, ["compact-window", "tool-output"]);
    // Below $1, or below 2% of the input: not offered.
    assert.deepEqual(planFixes({ ...base, toolOutput: replay(0.9) }), []);
    assert.deepEqual(planFixes({ ...base, toolOutput: replay(15, 1000) }), []);
    assert.deepEqual(planFixes({ ...base, toolOutput: { ...replay(300), recommended: undefined } }), []);
    // A cap you set: applied when it is one, left alone when it asks for more.
    const mine = planFixes({ ...base, toolOutput: replay(300), toolOutputSet: { name: "bashOutputMaxChars", value: 10_000, where: "~/.claude/settings.json" } });
    assert.deepEqual(mine.map((x) => [x.id, x.state]), [["tool-output", "applied"]]);
    assert.match(renderFixPlan(30, 2000, mine, []), /✓ Long Bash output: bashOutputMaxChars=10000 in ~\/\.claude\/settings\.json/);
    const more = planFixes({ ...base, toolOutput: replay(300), toolOutputSet: { name: "bashOutputMaxChars", value: 100_000, where: "~/.claude/settings.json" } });
    assert.equal(more[0].state, "not-here");
    assert.match(renderFixPlan(30, 2000, more, []), /- Long Bash output: bashOutputMaxChars=100000 in ~\/\.claude\/settings\.json: left as you set it \(a cap of 8k characters would have cost \$300 less\)/);
    const env = planFixes({ ...base, toolOutput: replay(300), toolOutputSet: { name: "BASH_MAX_OUTPUT_LENGTH", value: "60000", where: "the environment" } });
    assert.equal(env[0].state, "not-here");
    assert.match(renderFixPlan(30, 2000, env, []), /BASH_MAX_OUTPUT_LENGTH=60000 in the environment: left as you set it/);
    // A project's value wins over the user's: named.
    const over = planFixes({ ...base, toolOutput: replay(300), overrides: { "tool-output": ["bashOutputMaxChars 50000 in /p/.claude/settings.json"] } });
    assert.match(renderFixPlan(30, 2000, over, []), /⚠ would not take effect: bashOutputMaxChars 50000 in \/p\/\.claude\/settings\.json/);
});
test("apply then undo: settings.json byte for byte; a value already there is never overwritten; overrides named", async () => {
    const home = mkdtempSync(join(tmpdir(), "cd-to-rt-"));
    mkdirSync(join(home, ".claude"));
    const settings = join(home, ".claude", "settings.json");
    const [fix] = planFixes({ ...base, toolOutput: replay(300) });
    const deps = { home, now: 5_000, env: {}, cwd: home };
    for (const original of [undefined, '{\r\n    "model": "opus",\r\n    "env": {\r\n        "FOO": "1"\r\n    }\r\n}\r\n', '{"theme":"dark","n":1.0}']) {
        if (original === undefined)
            assert.ok(!existsSync(settings));
        else
            writeFileSync(settings, original);
        const r = await applyFix(fix, deps);
        assert.equal(r.ok, true, r.lines.join("\n"));
        assert.equal(JSON.parse(readFileSync(settings, "utf8")).bashOutputMaxChars, 8000);
        if (original?.includes("\r\n"))
            assert.match(readFileSync(settings, "utf8"), /"bashOutputMaxChars": 8000\r\n/);
        assert.equal(readFixRecords(home).find((x) => x.id === "tool-output").hadPrevious, false);
        const lines = await undoFixes(["tool-output"], deps);
        assert.match(lines.join("\n"), /✓ bashOutputMaxChars removed/);
        if (original === undefined)
            assert.ok(!existsSync(settings), "the file fix created goes again");
        else
            assert.equal(readFileSync(settings, "utf8"), original);
    }
    // Changed since (another key): undo takes out just the key.
    writeFileSync(settings, '{\n  "a": 1\n}\n');
    await applyFix(fix, deps);
    writeFileSync(settings, readFileSync(settings, "utf8").replace('"a": 1', '"a": 2'));
    await undoFixes(["tool-output"], deps);
    assert.equal(readFileSync(settings, "utf8"), '{\n  "a": 2\n}\n');
    // A value you set: refused, untouched, nothing recorded.
    const yours = '{\n  "bashOutputMaxChars": 60000\n}\n';
    writeFileSync(settings, yours);
    const r = await applyFix(fix, deps);
    assert.equal(r.ok, false);
    assert.match(r.lines[0], /bashOutputMaxChars is 60000 in .*settings\.json, a value you set: left as it is/);
    assert.equal(readFileSync(settings, "utf8"), yours);
    assert.deepEqual(readFixRecords(home), []);
    // A project's or managed value wins: named, and applying says so.
    writeFileSync(settings, "{}\n");
    const cwd = mkdtempSync(join(tmpdir(), "cd-to-proj-"));
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, ".claude", "settings.json"), '{"bashOutputMaxChars": 50000}');
    const over = fixOverrides("tool-output", { home, cwd, env: {} });
    assert.deepEqual(over.length, 1);
    assert.match(over[0], /bashOutputMaxChars 50000 in .*settings\.json/);
    const o = await applyFix(fix, { home, cwd, env: {} });
    assert.equal(o.ok, false);
    assert.match(o.lines.join("\n"), /⚠ written, but it will not take effect while bashOutputMaxChars 50000 in .* overrides it/);
    await undoFixes(undefined, { home });
});
test("CLI: fix offers it in a throwaway home, --apply writes it, undo removes exactly that", () => {
    const home = mkdtempSync(join(tmpdir(), "cd-to-cli-"));
    const project = join(home, ".claude", "projects", "-tmp-proj");
    mkdirSync(project, { recursive: true });
    const cwd = mkdtempSync(join(tmpdir(), "cd-to-cwd-"));
    // A session whose long Bash outputs are re-read by many later requests.
    const rows = [];
    let ctx = 50_000;
    for (let i = 0; i < 60; i++) {
        rows.push(call(t0 + i * 20_000, ctx, 3_000, { id: `b${i}`, name: "Bash" }));
        rows.push(result(`b${i}`, i % 2 === 0 ? LONG : "short"));
        ctx += i % 2 === 0 ? 8_000 : 500;
    }
    writeFileSync(join(project, "s1.jsonl"), rows.join("\n") + "\n");
    const settings = join(home, ".claude", "settings.json");
    const original = '{\n  "model": "opus"\n}\n';
    writeFileSync(settings, original);
    const run = (...args) => spawnSync(process.execPath, [cli, "fix", ...args], { encoding: "utf8", cwd, env: { ...sandboxEnv(home), BASH_MAX_OUTPUT_LENGTH: "", CONTEXT_DOCTOR_CACHE_DIR: mkdtempSync(join(tmpdir(), "cd-to-c-")), CONTEXT_DOCTOR_NO_MANAGED_SETTINGS: "1", CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS: "2.1.309" }, input: "" });
    let r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Long Bash output to a file past 8k characters/);
    assert.match(r.stdout, /\[tool-output\]/);
    assert.equal(readFileSync(settings, "utf8"), original, "nothing written without --apply");
    r = run("--apply", "tool-output");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(JSON.parse(readFileSync(settings, "utf8")).bashOutputMaxChars, 8000);
    r = run();
    assert.match(r.stdout, /✓ Long Bash output: bashOutputMaxChars=8000 in .*settings\.json since \d{4}-\d\d-\d\d: no Bash output over the cap since/);
    r = run("undo");
    assert.equal(r.status, 0, r.stderr);
    // The file as it was.
    assert.equal(readFileSync(settings, "utf8"), original);
});
