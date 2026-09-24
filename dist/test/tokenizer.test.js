/**
 * 0.19: token estimates follow the model's tokenizer. Claude's current
 * tokenizer packs ~2.75 chars per token on prose and ~2.4 on code (measured
 * from the API's own counts); the old provider-neutral 4.0 / 3.2 undercounted
 * Claude by ~40%. These tests pin the ratios and every place the old constant
 * leaked into behaviour: the hook's fast path, the proxy's cache threshold,
 * calibration files learned against the old heuristic, and the sketch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { CHARS_PER_TOKEN, estimateTokens } from "../tokens.js";
import { parseConversation } from "../parse.js";
import { profileConversation } from "../profile.js";
import { optimizeConversation } from "../optimize.js";
import { measureTokenizer, renderTokenizer } from "../tokenizer-measure.js";
import { startProxy } from "../proxy.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const prose = "The deployment pipeline moved to a staged rollout last week. ";
test("estimateTokens: Claude ratios for Claude models, the neutral ones otherwise", () => {
    const text = prose.repeat(50); // 3,100 chars of prose
    assert.equal(estimateTokens(text, "claude-opus-5"), Math.ceil(text.length / 2.75));
    assert.equal(estimateTokens(text, "gpt-5"), Math.ceil(text.length / 4.0));
    assert.equal(estimateTokens(text), Math.ceil(text.length / 4.0), "no model: unchanged default for library callers");
    const code = 'const x = {a: [1,2,3], b: "q"}; if (x.a) { return x.b; }\n'.repeat(40);
    assert.equal(estimateTokens(code, "claude-fable-5-1"), Math.ceil(code.length / 2.4));
    assert.equal(estimateTokens(code, "gpt-4o"), Math.ceil(code.length / 3.2));
    assert.deepEqual(CHARS_PER_TOKEN.anthropic, { prose: 2.75, code: 2.4 });
});
test("the conversation's own model field picks the ratios in profile and optimize", () => {
    const body = (model) => JSON.stringify({ model, messages: [{ role: "user", content: prose.repeat(100) }] });
    const claude = parseConversation(body("claude-sonnet-5"));
    assert.equal(claude.model, "claude-sonnet-5");
    const c = profileConversation(claude).totalTokens;
    const g = profileConversation(parseConversation(body("gpt-5"))).totalTokens;
    assert.ok(c > g * 1.35, `Claude ${c} should be ~1.45x GPT ${g}`);
    assert.equal(profileConversation(claude, "gpt-5").totalTokens, g, "an explicit model still wins");
    const oc = optimizeConversation(body("claude-sonnet-5")).tokensBefore;
    const og = optimizeConversation(body("gpt-5")).tokensBefore;
    assert.ok(oc > og * 1.35, "optimizer savings are counted in the model's tokens too");
});
test("trim budgets are in the model's tokens: a Claude trim keeps fewer chars", () => {
    const big = "row | ".repeat(3000);
    const conv = (model) => JSON.stringify({
        model,
        messages: [
            { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] },
            ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i}` })),
        ],
    });
    const kept = (model) => {
        const r = optimizeConversation(conv(model), { strategies: ["trim-tool-results"], keepRecent: 2, maxToolResultTokens: 300 });
        const msg = r.conversation.messages[1];
        return String(msg.content[0].content).length;
    };
    assert.ok(kept("claude-opus-5") < kept("gpt-5"), "same token budget, denser tokenizer, fewer chars kept");
});
test("measureTokenizer recovers exact ratios from usage in a transcript", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-tok-"));
    const path = join(dir, "s.jsonl");
    const usage = (prompt, output) => ({ input_tokens: 2, cache_read_input_tokens: prompt - 2, cache_creation_input_tokens: 0, output_tokens: output });
    const lines = [
        // A thinking-free reply: 2,750 chars billed as exactly 1,000 output tokens.
        { type: "assistant", message: { id: "m1", model: "claude-opus-5", content: [{ type: "text", text: "a".repeat(2750) }], usage: usage(5000, 1000) } },
        { type: "user", message: { role: "user", content: "next" } },
        // A tool call, then a single 6,000-char result, then the next call's prompt
        // grows by the call's output (100) plus exactly 2,500 tokens for the result.
        { type: "assistant", message: { id: "m2", model: "claude-opus-5", content: [{ type: "tool_use", id: "t", name: "Read", input: {} }], usage: usage(7000, 100) } },
        { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x".repeat(6000) }] } },
        { type: "assistant", message: { id: "m3", model: "claude-opus-5", content: [{ type: "text", text: "done" }], usage: usage(9600, 5) } },
    ];
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
    const report = measureTokenizer(1, [path]);
    const m = report.models.find((x) => x.model === "claude-opus-5");
    assert.equal(m.prose?.median, 2.75);
    assert.equal(m.blocks?.median, 2.4);
    assert.match(renderTokenizer(report), /→ exact/);
});
test("calibration learned against the old heuristic is ignored, then restarted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-cal-"));
    const saved = { state: process.env.CONTEXT_DOCTOR_HOOK_STATE, off: process.env.CONTEXT_DOCTOR_NO_CALIBRATION };
    process.env.CONTEXT_DOCTOR_HOOK_STATE = join(dir, "state.json");
    delete process.env.CONTEXT_DOCTOR_NO_CALIBRATION;
    try {
        const { calibrationFor, calibrationPath, recordCalibration, HEURISTIC_VERSION } = await import("../calibration.js");
        // A pre-0.19 file: a 1.4x factor that corrected the old undercount.
        writeFileSync(calibrationPath(), JSON.stringify({ claude: { exactSum: 1400, heuristicSum: 1000, samples: 3 } }));
        assert.equal(calibrationFor("claude-opus-5").factor, 1, "old factor would double-correct: ignored");
        recordCalibration("claude-opus-5", 1050, 1000);
        const rec = JSON.parse(readFileSync(calibrationPath(), "utf8")).claude;
        assert.deepEqual(rec, { exactSum: 1050, heuristicSum: 1000, samples: 1, v: HEURISTIC_VERSION }, "restarted, not blended");
        assert.ok(Math.abs(calibrationFor("claude-opus-5").factor - 1.05) < 1e-9);
    }
    finally {
        if (saved.state === undefined)
            delete process.env.CONTEXT_DOCTOR_HOOK_STATE;
        else
            process.env.CONTEXT_DOCTOR_HOOK_STATE = saved.state;
        if (saved.off !== undefined)
            process.env.CONTEXT_DOCTOR_NO_CALIBRATION = saved.off;
    }
});
test("hook: a Claude session past the threshold is not skipped by the byte fast path", async () => {
    // ~270k chars of prose: ~98k Claude tokens (over the 80k default), but under
    // the old 4-bytes-per-token gate (320k bytes) the hook never read the file.
    const dir = mkdtempSync(join(tmpdir(), "cd-hookfast-"));
    const path = join(dir, "claude.jsonl");
    const turn = prose.repeat(45); // ~2.8k chars
    const lines = [];
    for (let i = 0; i < 96; i++) {
        lines.push(i % 2
            ? JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: turn }] } })
            : JSON.stringify({ type: "user", message: { role: "user", content: turn } }));
    }
    writeFileSync(path, lines.join("\n"));
    const bytes = statSync(path).size;
    assert.ok(bytes < 80_000 * 4 && bytes > 80_000 * 2.4, `fixture must sit between the old and new gates (${bytes} bytes)`);
    const out = await new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [cliPath, "hook"], { env: { ...process.env, CONTEXT_DOCTOR_HOOK_STATE: join(dir, "state.json") } }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
        child.stdin.end(JSON.stringify({ session_id: "fastpath", transcript_path: path }));
    });
    assert.match(out, /context is at ~\d/, "the hook parsed the session and warned");
});
test("proxy: the missing-cache_control advice fires from 1,024 Claude tokens, not 4,000 chars", async () => {
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 1 } })); });
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const proxy = startProxy({ port: 0, anthropicUpstream: `http://127.0.0.1:${upstream.address().port}` });
    await new Promise((r) => proxy.once("listening", r));
    const port = proxy.address().port;
    try {
        // ~3,300 chars of system prompt: ~1,375 Claude tokens, cacheable, but under the old 4,000-char gate.
        const system = "Answer in the house style; cite the runbook section. ".repeat(62);
        await fetch(`http://127.0.0.1:${port}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": "k" },
            body: JSON.stringify({ model: "claude-sonnet-5", system, messages: [{ role: "user", content: "hi" }] }),
        });
        const stats = (await fetch(`http://127.0.0.1:${port}/stats`).then((r) => r.json()));
        assert.ok(stats.advice.some((a) => /without cache_control/.test(a)), `expected advice, got ${JSON.stringify(stats.advice)}`);
    }
    finally {
        proxy.close();
        upstream.close();
    }
});
test("an Anthropic-format request with no model field is counted with Claude's ratios", () => {
    const body = JSON.stringify({ system: "Be brief.", messages: [{ role: "user", content: prose.repeat(100) }] });
    const conv = parseConversation(body);
    assert.equal(conv.sourceFormat, "anthropic");
    const p = profileConversation(conv);
    assert.equal(p.model, undefined, "no model is invented for pricing or the window");
    assert.ok(p.totalTokens > profileConversation(parseConversation(JSON.stringify({ messages: [{ role: "system", content: "Be brief." }, { role: "user", content: prose.repeat(100) }] }))).totalTokens * 1.35);
    assert.ok(optimizeConversation(body).tokensBefore > optimizeConversation(JSON.stringify({ messages: [{ role: "user", content: prose.repeat(100) }] })).tokensBefore * 1.35);
});
test("session --list honours --limit", async () => {
    const home = mkdtempSync(join(tmpdir(), "cd-list-"));
    const { mkdirSync } = await import("node:fs");
    const proj = join(home, ".claude", "projects", "p");
    mkdirSync(proj, { recursive: true });
    for (let i = 0; i < 25; i++)
        writeFileSync(join(proj, `s${i}.jsonl`), JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }));
    const run = (args) => new Promise((resolve, reject) => {
        execFile(process.execPath, [cliPath, "session", "--list", ...args], { env: { ...process.env, HOME: home, USERPROFILE: home } }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    assert.equal((await run([])).trim().split("\n").length, 20);
    assert.equal((await run(["--limit", "25"])).trim().split("\n").length, 25);
});
