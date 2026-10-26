/**
 * The A/B quality harness (`context-doctor ab`), verified without a key:
 * every task is a real task (its hidden check fails as given and passes
 * with the reference fix; the smoke test the agent can run gives no
 * answers; the big-file tasks keep their facts in the big file), and the
 * whole harness runs end to end, through the CLI, against a local mock of
 * the Messages API whose scripted model solves each task the same way every
 * time. The mock's request log shows what each arm sent; the harness's
 * hidden check, not the model's word, decides pass. The agent's code runs
 * without the API key, cannot outlive its run, and cannot write through a
 * link; the budget is never passed, a refused key stops the suite, and a
 * body cut short is retried.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "./sandbox.js";
import { AB_TASKS } from "../abtasks.js";
import { AB_API_VERSION, abVerify, anthropicProvider, armsFor, estimateAb, renderAb, runAbSuite } from "../ab.js";
import { pricingFor } from "../pricing.js";
import { SERVER_INSTRUCTIONS } from "../rules.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const windows = process.platform === "win32";
const textOf = (content) => typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => (typeof b?.text === "string" ? b.text : typeof b?.content === "string" ? b.content : "")).join("\n") : "";
/**
 * The scripted model: read the files the fix touches (and the big file, by
 * pack_context when offered), write the reference fix, run the smoke test,
 * stop. Stateless: the step is the number of assistant turns in the
 * history, so a compacted session starts over from its summary, which
 * restates the request as a model's summary would.
 */
function scriptedReply(body, ids, opts) {
    const text = (t) => ({ type: "text", text: t });
    const use = (name, input) => ({ type: "tool_use", id: `toolu_${String(++ids.n).padStart(4, "0")}`, name, input });
    const task = AB_TASKS.find((t) => textOf(body.messages[0].content).includes(t.prompt));
    if (body.tool_choice?.type === "none")
        return { content: [text(`Summary. The request: ${task?.prompt ?? "unknown"} I read the files and wrote the fix; next, check it.`)], stop_reason: "end_turn" };
    if (!task)
        return { content: [text("Which task is this?")], stop_reason: "end_turn" };
    const step = body.messages.filter((m) => m.role === "assistant").length;
    const tools = body.tools.map((t) => t.name);
    if (step === 0) {
        const calls = Object.keys(task.solution).map((p) => use("read_file", { path: p }));
        if (task.bigFile)
            calls.push(tools.includes("pack_context") ? use("pack_context", { question: task.prompt }) : use("read_file", { path: task.bigFile }));
        return { content: [text("Reading the code first."), ...calls], stop_reason: "tool_use" };
    }
    if (step === 1) {
        const files = opts.write?.(body, task) ?? task.solution;
        return { content: Object.entries(files).map(([path, content]) => use("write_file", { path, content })), stop_reason: "tool_use" };
    }
    if (step === 2)
        return { content: [use("run_check", {}), use("write_file", { path: "test.mjs", content: "console.log('ok')" })], stop_reason: "tool_use" };
    if (step < 2 + (opts.checks ?? 1))
        return { content: [use("run_check", {})], stop_reason: "tool_use" };
    return { content: [text(`Fixed ${Object.keys(task.solution).join(", ")}.`)], stop_reason: "end_turn" };
}
async function mockMessagesApi(opts = {}) {
    const requests = [];
    const ids = { n: 0 };
    let cut = 0;
    const server = createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
            if (req.method !== "POST" || req.url !== "/v1/messages") {
                res.writeHead(404).end();
                return;
            }
            const body = JSON.parse(raw);
            requests.push({ headers: req.headers, body });
            if (req.headers["x-api-key"] !== "test-key") {
                res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
                return;
            }
            if (cut < (opts.cutFirst ?? 0)) {
                cut++;
                res.writeHead(200, { "content-type": "application/json", "content-length": "5000" });
                res.write('{"id":"msg_cut","content":[');
                setTimeout(() => res.socket?.destroy(), 20);
                return;
            }
            const reply = scriptedReply(body, ids, opts);
            const usage = { input_tokens: Math.ceil(JSON.stringify(body.messages).length / 4) + 600, output_tokens: opts.usageOut ?? Math.ceil(JSON.stringify(reply.content).length / 4), cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
            setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: `msg_${requests.length}`, type: "message", role: "assistant", model: body.model, ...reply, usage })), opts.delayMs ?? 0);
        });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
function cli(args, env) {
    return new Promise((resolve) => {
        execFile(process.execPath, [cliPath, ...args], { env, maxBuffer: 32 * 1024 * 1024 }, (err, out, errOut) => resolve({ code: err ? (err.code ?? 1) : 0, out, err: errOut }));
    });
}
const leftovers = (dir) => readdirSync(dir).filter((n) => n.startsWith("ctxdoc-ab-"));
test("every task: the hidden check fails as given and passes with the fix; the smoke test passes with the fix and gives no answers", async () => {
    assert.ok(AB_TASKS.length >= 6 && AB_TASKS.length <= 10);
    assert.equal(new Set(AB_TASKS.map((t) => t.id)).size, AB_TASKS.length);
    for (const task of AB_TASKS) {
        assert.ok(task.files["test.mjs"], `${task.id} has a smoke test`);
        assert.doesNotMatch(task.files["test.mjs"], /assert|deepEqual|\.equal\(/, `${task.id}'s smoke test asserts no results`);
        assert.ok(!("test.mjs" in task.solution), `${task.id}'s fix leaves the smoke test alone`);
        assert.equal(await abVerify(task), false, `${task.id}: the fixture should fail the hidden check`);
        assert.equal(await abVerify(task, { ...task.files, ...task.solution }), true, `${task.id}: the fix should pass the hidden check`);
        const dir = mkdtempSync(join(tmpdir(), "ctxdoc-absmoke-"));
        for (const [p, text] of Object.entries({ ...task.files, ...task.solution })) {
            mkdirSync(dirname(join(dir, p)), { recursive: true });
            writeFileSync(join(dir, p), text);
        }
        const r = spawnSync(process.execPath, ["test.mjs"], { cwd: dir, encoding: "utf8", timeout: 30_000 });
        rmSync(dir, { recursive: true, force: true });
        assert.equal(r.status, 0, `${task.id}: the smoke test passes with the fix\n${r.stderr}`);
    }
});
test("the big-file tasks keep the facts their fix needs in the big file only", () => {
    const facts = {
        "retry-backoff": ["baseDelayMs", "4 attempts in all"],
        "ini-parser": ["SyntaxError", "dotted name", "Version 1 of the format also allowed"],
        "ttl-cache": ["least recently used", "reading does not extend", "sliding expiry"],
    };
    for (const [id, needles] of Object.entries(facts)) {
        const task = AB_TASKS.find((t) => t.id === id);
        for (const needle of needles) {
            assert.ok(task.files[task.bigFile].includes(needle), `${id}: "${needle}" is in ${task.bigFile}`);
            assert.ok(!task.prompt.includes(needle), `${id}: "${needle}" is not in the request`);
            for (const [path, text] of Object.entries(task.files))
                if (path !== task.bigFile)
                    assert.ok(!text.includes(needle), `${id}: "${needle}" is not in ${path}`);
        }
    }
});
test("end to end through the CLI against a local mock Messages API: every arm, each lever acting, the hidden check deciding", async () => {
    const api = await mockMessagesApi();
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-ab-e2e-"));
    const tmp = mkdtempSync(join(tmpdir(), "ctxdoc-ab-tmp-"));
    const out = join(home, "ab.json");
    try {
        const env = { ...sandboxEnv(home), ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: api.url, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
        const r = await cli(["ab", "--yes", "--tasks", "range-inclusive,ini-parser,retry-backoff", "--out", out], env);
        assert.equal(r.code, 0, r.err);
        const result = JSON.parse(readFileSync(out, "utf8"));
        assert.deepEqual(result.arms, ["none", "rules", "autoclear", "pack", "compact-generic", "compact"]);
        assert.equal(result.runs.length, 3 * 6);
        for (const run of result.runs) {
            assert.equal(run.pass, true, `${run.task} ${run.arm}: ${run.stop} ${run.error ?? ""}`);
            assert.equal(run.stop, "end_turn");
            assert.ok(run.requests >= 4 && run.inputTokens > 0 && run.outputTokens > 0 && run.costUsd > 0);
        }
        for (const arm of result.arms)
            assert.equal(result.summary[arm].passed, 3);
        assert.deepEqual(leftovers(tmp), [], "no run folder left behind");
        const runOf = (task, arm) => result.runs.find((x) => x.task === task && x.arm === arm);
        // Autopilot cleared the production log the agent had read, and only in its own arm.
        assert.ok(runOf("retry-backoff", "autoclear").leverUses > 0, "autopilot changed requests");
        assert.ok(runOf("retry-backoff", "autoclear").leverTokens > 1000, "and kept the log off the wire");
        assert.equal(runOf("retry-backoff", "none").leverUses, 0);
        const cleared = api.requests.filter((q) => JSON.stringify(q.body.messages).includes("[context-doctor: old tool output cleared"));
        assert.ok(cleared.length > 0 && cleared.every((q) => !q.body.system.includes("Context hygiene") && !q.body.tools.some((t) => t.name === "pack_context")));
        // pack_context answered the spec question instead of a whole-file read.
        assert.equal(runOf("ini-parser", "pack").leverUses, 1);
        const packed = api.requests.find((q) => q.body.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result" && String(b.content).startsWith("PACKED"))));
        assert.match(JSON.stringify(packed?.body.messages), /Parsing rules/);
        // Each compact arm compacted once; only ours carried the hook's facts; both went on from the summary alone.
        assert.equal(runOf("range-inclusive", "compact").leverUses, 1);
        assert.equal(runOf("range-inclusive", "compact-generic").leverUses, 1);
        const summaries = api.requests.filter((q) => q.body.tool_choice?.type === "none");
        assert.equal(summaries.length, 3 * 2);
        const withFacts = summaries.filter((q) => textOf(q.body.messages.at(-1).content).includes("context-doctor, from this session's transcript"));
        assert.equal(withFacts.length, 3, "one per task: the compact arm's");
        for (const q of withFacts)
            assert.match(textOf(q.body.messages.at(-1).content), /Files changed in this session[\s\S]*src\//);
        const afterCompaction = api.requests.filter((q) => textOf(q.body.messages[0].content).startsWith("This session was compacted"));
        assert.ok(afterCompaction.length >= 3 * 2 * 3);
        for (const q of afterCompaction)
            assert.doesNotMatch(textOf(q.body.messages[0].content), /Repository files:/, "the request is not repeated after a compaction");
        // What went on the wire: the version header, the key, the rules only in their arm, no sampling parameters.
        for (const q of api.requests) {
            assert.equal(q.headers["anthropic-version"], AB_API_VERSION);
            assert.equal(q.headers["x-api-key"], "test-key");
            assert.equal(q.body.model, "claude-opus-5-5");
            assert.deepEqual(q.body.cache_control, { type: "ephemeral" });
            assert.equal("temperature" in q.body, false);
        }
        assert.equal(api.requests.filter((q) => q.body.system.includes(SERVER_INSTRUCTIONS)).length, result.runs.filter((x) => x.arm === "rules").reduce((n, x) => n + x.requests, 0));
        // The agent's write to the smoke test was refused, and the smoke test it runs gives no answers.
        assert.ok(api.requests.some((q) => JSON.stringify(q.body.messages).includes("test.mjs is the smoke test and cannot be changed")));
        assert.ok(api.requests.some((q) => JSON.stringify(q.body.messages).includes("This test does not check results")));
        // The table.
        assert.match(r.out, /rules: the standing context rules/);
        assert.match(r.out, /passed\s+3\/3 completed\s+3\/3 completed/);
        assert.match(r.out, /Same pass count with and without autoclear \(3\/3\)\./);
        assert.match(r.out, /requests autopilot changed: [1-9]/);
        assert.match(r.err, /\[18\/18\]/, "progress on stderr");
    }
    finally {
        await api.close();
        rmSync(home, { recursive: true, force: true });
        rmSync(tmp, { recursive: true, force: true });
    }
});
test("a lever that breaks a task shows up as a failed run, decided by the hidden check", async () => {
    // The scripted model writes the fixture back instead of the fix when the rules are in its prompt.
    const api = await mockMessagesApi({ write: (body, task) => (task.id === "csv-quotes" && String(body.system).includes("Context hygiene") ? { "src/csv.js": task.files["src/csv.js"] } : undefined) });
    try {
        const result = await runAbSuite({ provider: anthropicProvider({ apiKey: "test-key", baseUrl: api.url, retries: 0 }), tasks: AB_TASKS.filter((t) => t.id === "csv-quotes" || t.id === "money-format"), levers: ["rules"], concurrency: 2 });
        const csv = result.runs.filter((r) => r.task === "csv-quotes");
        assert.equal(csv.find((r) => r.arm === "none").pass, true);
        const broken = csv.find((r) => r.arm === "rules");
        assert.equal(broken.pass, false, "the model said it fixed it, and the smoke test passed; the hidden check says otherwise");
        assert.equal(broken.stop, "end_turn");
        const text = renderAb(result);
        assert.match(text, /csv-quotes\s+PASS.*FAIL/);
        assert.match(text, /1 fewer pass with rules \(1\/2 vs 2\/2\): read those runs/);
    }
    finally {
        await api.close();
    }
});
test("runs stopped by the API, the budget or a cap are counted apart, not as failures", () => {
    const run = (arm, task, pass, stop) => ({ task, arm, rep: 1, pass, stop, requests: 1, inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, costUsd: 0.01, wallMs: 1, leverUses: 0, leverTokens: 0 });
    const result = {
        model: "claude-opus-5-5", provider: "test", tasks: ["a", "b", "c"], levers: ["rules"], arms: ["none", "rules"], repeat: 1, spentUsd: 0.06,
        runs: [run("none", "a", true, "end_turn"), run("rules", "a", true, "end_turn"), run("none", "b", true, "end_turn"), run("rules", "b", false, "error"), run("none", "c", true, "end_turn"), run("rules", "c", false, "budget")],
    };
    const text = renderAb(result);
    assert.match(text, /passed\s+3\/3 completed\s+1\/1 completed/);
    assert.match(text, /stopped early\s+0\s+2/);
    assert.match(text, /Same pass rate with and without rules over the completed runs \(1\/1 vs 3\/3\)/);
    assert.doesNotMatch(text, /fewer pass/);
    assert.match(text, /b\s+PASS.*ERROR/);
});
test("gates: no key refuses after the estimate; no --yes sends nothing; a bad --out, an unknown lever or a model without its own price stop before spending", async () => {
    const api = await mockMessagesApi();
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-ab-gate-"));
    try {
        const base = { ...sandboxEnv(home), ANTHROPIC_BASE_URL: api.url };
        delete base.ANTHROPIC_API_KEY;
        const noKey = await cli(["ab", "--yes"], base);
        assert.equal(noKey.code, 1);
        assert.match(noKey.out, /Estimated cost: ~\$[\d.]+ with prompt caching, up to ~\$[\d.]+ if nothing caches/);
        assert.match(noKey.err, /ANTHROPIC_API_KEY, which is not set\. Nothing was sent\./);
        const keyed = { ...base, ANTHROPIC_API_KEY: "test-key" };
        const noYes = await cli(["ab", "--lever", "pack", "--tasks", "ini-parser"], keyed);
        assert.equal(noYes.code, 0);
        assert.match(noYes.out, /1 task x 2 arms \(none, pack\) x 1 = 2 runs on claude-opus-5-5/);
        assert.match(noYes.out, /Nothing was sent\. Run again with --yes to spend up to \$\d/);
        const folder = await cli(["ab", "--yes", "--out", home], keyed);
        assert.equal(folder.code, 1);
        assert.match(folder.err, /--out .* is a folder\. Nothing was sent\./);
        const nowhere = await cli(["ab", "--yes", "--out", join(home, "missing", "ab.json")], keyed);
        assert.equal(nowhere.code, 1);
        assert.match(nowhere.err, /cannot be written/);
        const guess = await cli(["ab", "--yes", "--model", "claude-opus-9"], keyed);
        assert.equal(guess.code, 1);
        assert.match(guess.err, /No price is known for claude-opus-9 itself/);
        const bad = await cli(["ab", "--lever", "magic"], keyed);
        assert.equal(bad.code, 1);
        assert.match(bad.err, /Unknown lever "magic"/);
        assert.equal(api.requests.length, 0, "not one request");
        assert.match((await cli(["ab", "--list"], base)).out, /ini-parser\s+.*big file: docs\/FORMAT\.md/);
    }
    finally {
        await api.close();
        rmSync(home, { recursive: true, force: true });
    }
});
test("the budget is never passed, however many runs are in flight", async () => {
    // Every answer bills a full max_tokens of output, the worst case each request reserves.
    const api = await mockMessagesApi({ usageOut: 16000 });
    try {
        const budgetUsd = 1;
        const result = await runAbSuite({ provider: anthropicProvider({ apiKey: "test-key", baseUrl: api.url, retries: 0 }), tasks: AB_TASKS.slice(0, 4), levers: ["rules"], concurrency: 4, budgetUsd });
        assert.ok(result.spentUsd <= budgetUsd, `spent ${result.spentUsd} of ${budgetUsd}`);
        assert.ok(api.requests.length >= 1 && api.requests.length <= 3, `${api.requests.length} requests`);
        assert.ok(result.runs.some((r) => r.stop === "budget"));
        const none = await runAbSuite({ provider: anthropicProvider({ apiKey: "test-key", baseUrl: api.url }), tasks: AB_TASKS.slice(0, 1), levers: ["rules"], budgetUsd: 0.0001 });
        assert.ok(none.runs.every((r) => r.stop === "budget" && r.requests === 0), "a budget below one request's worst case sends nothing");
    }
    finally {
        await api.close();
    }
});
test("a refused key stops the suite with exit 1; a body cut short is retried", async () => {
    const api = await mockMessagesApi();
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-ab-key-"));
    try {
        const env = { ...sandboxEnv(home), ANTHROPIC_API_KEY: "nope", ANTHROPIC_BASE_URL: api.url };
        const r = await cli(["ab", "--yes", "--lever", "rules,pack", "--tasks", "range-inclusive,slugify", "--concurrency", "1"], env);
        assert.equal(r.code, 1);
        assert.match(r.err, /Stopped: the API refused the key \(HTTP 401: invalid x-api-key\)/);
        assert.equal(api.requests.length, 1, "the first refusal stops every later run");
    }
    finally {
        await api.close();
        rmSync(home, { recursive: true, force: true });
    }
    const flaky = await mockMessagesApi({ cutFirst: 2 });
    try {
        const result = await runAbSuite({ provider: anthropicProvider({ apiKey: "test-key", baseUrl: flaky.url, retries: 3 }), tasks: AB_TASKS.slice(0, 1), levers: ["rules"], concurrency: 1 });
        assert.ok(result.runs.every((r) => r.pass && r.stop === "end_turn"), JSON.stringify(result.runs.map((r) => r.error)));
    }
    finally {
        await flaky.close();
    }
});
test("the compaction request counts against --max-turns", async () => {
    const api = await mockMessagesApi();
    try {
        const result = await runAbSuite({ provider: anthropicProvider({ apiKey: "test-key", baseUrl: api.url }), tasks: AB_TASKS.slice(0, 1), levers: ["compact"], maxTurns: 2, compactAfter: 2 });
        for (const run of result.runs) {
            assert.equal(run.requests, 2);
            assert.equal(run.stop, "turns");
            assert.equal(run.leverUses, 0, "no compaction past the cap");
        }
        assert.equal(api.requests.filter((q) => q.body.tool_choice?.type === "none").length, 0);
    }
    finally {
        await api.close();
    }
});
/** A fix for range-inclusive with `code` run first, as the module loads (in the smoke test and the hidden check). */
function hostileRange(code) {
    const task = AB_TASKS.find((t) => t.id === "range-inclusive");
    return { "src/range.js": ['import fs from "node:fs";', 'import os from "node:os";', 'import { spawn } from "node:child_process";', code, task.solution["src/range.js"]].join("\n") };
}
test("the agent's code runs without the API key or the real home, and cannot outlive its run", { skip: windows && "process groups and /proc or lsof are POSIX" }, async () => {
    const spy = mkdtempSync(join(tmpdir(), "ctxdoc-ab-spy-"));
    const leak = join(spy, "leak.json");
    const orphan = join(spy, "orphan.txt");
    const late = `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(orphan)}, "alive"), 4000)`;
    const code = [
        `fs.writeFileSync(${JSON.stringify(leak)}, JSON.stringify({ key: process.env.ANTHROPIC_API_KEY ?? null, base: process.env.ANTHROPIC_BASE_URL ?? null, home: os.homedir() }));`,
        `spawn(process.execPath, ["-e", ${JSON.stringify(late)}], { detached: true, stdio: "ignore" }).unref();`,
    ].join("\n");
    const api = await mockMessagesApi({ write: (_b, task) => (task.id === "range-inclusive" ? hostileRange(code) : undefined) });
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
    try {
        const result = await runAbSuite({ provider: anthropicProvider({ apiKey: "test-key", baseUrl: api.url }), tasks: AB_TASKS.slice(0, 1), levers: ["rules"], concurrency: 1 });
        assert.ok(result.runs.every((r) => r.pass), "the fix still works");
        const seen = JSON.parse(readFileSync(leak, "utf8"));
        assert.equal(seen.key, null, "no API key in the agent's environment");
        assert.equal(seen.base, null);
        assert.match(seen.home, /ctxdoc-ab-range-inclusive-/, "a throwaway home");
        await new Promise((r) => setTimeout(r, 5000));
        assert.equal(existsSync(orphan), false, "the detached child was killed with the run");
    }
    finally {
        if (saved === undefined)
            delete process.env.ANTHROPIC_API_KEY;
        else
            process.env.ANTHROPIC_API_KEY = saved;
        await api.close();
        rmSync(spy, { recursive: true, force: true });
    }
});
test("the smoke test is restored without writing through a link, and a locked or looping repository is still cleaned up", { skip: windows && "symlinks and chmod differ on Windows" }, async () => {
    const spy = mkdtempSync(join(tmpdir(), "ctxdoc-ab-victim-"));
    const victim = join(spy, "victim.txt");
    writeFileSync(victim, "victim");
    const tmp = mkdtempSync(join(tmpdir(), "ctxdoc-ab-tmp-"));
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
        for (const code of [
            `try { fs.rmSync("test.mjs", { force: true }); fs.symlinkSync(${JSON.stringify(victim)}, "test.mjs"); } catch {}`,
            'try { fs.rmSync("test.mjs", { force: true }); fs.mkdirSync("test.mjs"); } catch {}',
            'try { fs.chmodSync("test.mjs", 0o444); fs.chmodSync(".", 0o555); fs.chmodSync("..", 0o555); } catch {}',
        ]) {
            const api = await mockMessagesApi({ checks: 2, write: (_b, task) => (task.id === "range-inclusive" ? hostileRange(code) : undefined) });
            try {
                const result = await runAbSuite({ provider: anthropicProvider({ apiKey: "test-key", baseUrl: api.url }), tasks: AB_TASKS.slice(0, 1), levers: ["rules"], concurrency: 1 });
                assert.ok(result.runs.every((r) => r.stop === "end_turn"), code);
                // The second smoke run found the planted thing at test.mjs and ran the real smoke test again.
                const second = api.requests.filter((q) => JSON.stringify(q.body.messages).includes("This test does not check results"));
                assert.ok(second.length > 0, code);
            }
            finally {
                await api.close();
            }
            assert.equal(readFileSync(victim, "utf8"), "victim", "never written through the link");
            assert.deepEqual(leftovers(tmp), [], `no run folder left behind: ${code}`);
        }
        // A check that never ends is killed at the time limit and fails.
        const api = await mockMessagesApi({ write: (_b, task) => (task.id === "range-inclusive" ? hostileRange("while (true) {}") : undefined) });
        try {
            const started = Date.now();
            const result = await runAbSuite({ provider: anthropicProvider({ apiKey: "test-key", baseUrl: api.url }), tasks: AB_TASKS.slice(0, 1), levers: ["rules"], concurrency: 2, checkTimeoutMs: 800 });
            assert.ok(result.runs.every((r) => !r.pass && r.stop === "end_turn"));
            assert.ok(Date.now() - started < 20_000);
            assert.ok(api.requests.some((q) => JSON.stringify(q.body.messages).includes("killed after 0.8 s")));
        }
        finally {
            await api.close();
        }
        assert.deepEqual(leftovers(tmp), []);
    }
    finally {
        if (saved === undefined)
            delete process.env.TMPDIR;
        else
            process.env.TMPDIR = saved;
        rmSync(tmp, { recursive: true, force: true });
        rmSync(spy, { recursive: true, force: true });
    }
});
test("Ctrl-C mid-suite removes every run folder and exits 130", { skip: windows && "no SIGINT to a child on Windows" }, async () => {
    const api = await mockMessagesApi({ delayMs: 400 });
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-ab-int-"));
    const tmp = mkdtempSync(join(tmpdir(), "ctxdoc-ab-tmp-"));
    try {
        const child = spawn(process.execPath, [cliPath, "ab", "--yes", "--lever", "rules"], { env: { ...sandboxEnv(home), ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: api.url, TMPDIR: tmp }, stdio: "ignore" });
        const exited = new Promise((r) => child.on("exit", (code) => r(code)));
        while (api.requests.length < 2)
            await new Promise((r) => setTimeout(r, 50));
        assert.ok(leftovers(tmp).length > 0, "runs are in flight");
        child.kill("SIGINT");
        assert.equal(await exited, 130);
        assert.deepEqual(leftovers(tmp), []);
    }
    finally {
        await api.close();
        rmSync(home, { recursive: true, force: true });
        rmSync(tmp, { recursive: true, force: true });
    }
});
test("the estimate grows with arms and repeats, and counts the shared baseline once", () => {
    assert.deepEqual(armsFor(["rules", "pack"]), ["none", "rules", "pack"]);
    assert.deepEqual(armsFor(["compact"]), ["compact-generic", "compact"]);
    const p = pricingFor("claude-opus-5-5");
    const one = estimateAb(AB_TASKS, armsFor(["rules"]), 1, p);
    const three = estimateAb(AB_TASKS, armsFor(["rules"]), 3, p);
    assert.equal(one.runs, AB_TASKS.length * 2);
    assert.ok(Math.abs(three.expectedUsd - one.expectedUsd * 3) < 1e-9);
    assert.ok(one.expectedUsd > 0 && one.expectedUsd < one.upperUsd);
});
