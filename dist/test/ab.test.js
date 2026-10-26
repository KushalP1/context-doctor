/**
 * The A/B quality harness (`context-doctor ab`), verified without a key:
 * every task is a real task (its check fails as given and passes with the
 * reference fix), and the whole harness runs end to end, through the CLI,
 * against a local mock of the Messages API whose scripted model solves each
 * task the same way every time. The mock's request log shows what each arm
 * sent; the harness's own check, not the model's word, decides pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "./sandbox.js";
import { AB_TASKS } from "../abtasks.js";
import { AB_API_VERSION, armsFor, estimateAb, renderAb, runAbSuite, anthropicProvider } from "../ab.js";
import { pricingFor } from "../pricing.js";
import { SERVER_INSTRUCTIONS } from "../rules.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const textOf = (content) => typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => (typeof b?.text === "string" ? b.text : typeof b?.content === "string" ? b.content : "")).join("\n") : "";
/**
 * The scripted model: read the files the fix touches (and the big file, by
 * pack_context when offered), write the reference fix, run the check, stop.
 * Stateless: the step is the number of assistant turns in the history, so a
 * compacted session starts over from its summary. `sabotage` makes it write
 * the fixture back instead of the fix, for one arm and task.
 */
function scriptedReply(body, ids, sabotage) {
    const text = (t) => ({ type: "text", text: t });
    const use = (name, input) => ({ type: "tool_use", id: `toolu_${String(++ids.n).padStart(4, "0")}`, name, input });
    if (body.tool_choice?.type === "none")
        return { content: [text("Summary: read the files, wrote the fix; next, write it again if needed and run the check.")], stop_reason: "end_turn" };
    const task = AB_TASKS.find((t) => textOf(body.messages[0].content).includes(t.prompt));
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
        const files = sabotage?.(body, task) ? Object.fromEntries(Object.keys(task.solution).map((p) => [p, task.files[p] ?? ""])) : task.solution;
        return { content: Object.entries(files).map(([path, content]) => use("write_file", { path, content })), stop_reason: "tool_use" };
    }
    if (step === 2)
        return { content: [use("run_check", {}), use("write_file", { path: "test.mjs", content: "console.log('ok')" })], stop_reason: "tool_use" };
    return { content: [text(`Fixed ${Object.keys(task.solution).join(", ")}.`)], stop_reason: "end_turn" };
}
async function mockMessagesApi(sabotage) {
    const requests = [];
    const ids = { n: 0 };
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
            const reply = scriptedReply(body, ids, sabotage);
            const usage = { input_tokens: Math.ceil(JSON.stringify(body.messages).length / 4) + 600, output_tokens: Math.ceil(JSON.stringify(reply.content).length / 4), cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: `msg_${requests.length}`, type: "message", role: "assistant", model: body.model, ...reply, usage }));
        });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}
function cli(args, env) {
    return new Promise((resolve) => {
        execFile(process.execPath, [cliPath, ...args], { env, maxBuffer: 32 * 1024 * 1024 }, (err, out, errOut) => resolve({ code: err ? (err.code ?? 1) : 0, out, err: errOut }));
    });
}
test("every task fails as given and passes with its reference fix", () => {
    assert.ok(AB_TASKS.length >= 6 && AB_TASKS.length <= 10);
    assert.equal(new Set(AB_TASKS.map((t) => t.id)).size, AB_TASKS.length);
    for (const task of AB_TASKS) {
        assert.ok(task.files["test.mjs"], `${task.id} has a check`);
        assert.ok(!("test.mjs" in task.solution), `${task.id}'s fix leaves the check alone`);
        if (task.bigFile)
            assert.ok(task.files[task.bigFile], `${task.id}'s big file is in the fixture`);
        for (const [label, files, want] of [["fixture", task.files, false], ["fix", { ...task.files, ...task.solution }, true]]) {
            const dir = mkdtempSync(join(tmpdir(), "ctxdoc-abtask-"));
            for (const [p, text] of Object.entries(files)) {
                mkdirSync(dirname(join(dir, p)), { recursive: true });
                writeFileSync(join(dir, p), text);
            }
            const r = spawnSync(process.execPath, ["test.mjs"], { cwd: dir, encoding: "utf8", timeout: 30_000 });
            rmSync(dir, { recursive: true, force: true });
            assert.equal(r.status === 0, want, `${task.id}: the ${label} should ${want ? "pass" : "fail"} its check\n${r.stderr}`);
        }
    }
});
test("end to end through the CLI against a local mock Messages API: every arm, each lever acting, the check deciding", async () => {
    const api = await mockMessagesApi();
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-ab-e2e-"));
    const out = join(home, "ab.json");
    try {
        const env = { ...sandboxEnv(home), ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: api.url };
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
            assert.deepEqual(result.summary[arm].passed, 3);
        const runOf = (task, arm) => result.runs.find((x) => x.task === task && x.arm === arm);
        // Autopilot cleared the production log the agent had read, and only in its own arm.
        assert.ok(runOf("retry-backoff", "autoclear").leverUses > 0, "autopilot changed requests");
        assert.ok(runOf("retry-backoff", "autoclear").leverTokens > 1000, "and kept the log off the wire");
        assert.equal(runOf("retry-backoff", "none").leverUses, 0);
        const cleared = api.requests.filter((q) => JSON.stringify(q.body.messages).includes("[context-doctor: old tool output cleared"));
        assert.ok(cleared.length > 0 && cleared.every((q) => !q.body.system.includes("Context hygiene") && !q.body.tools.some((t) => t.name === "pack_context")));
        // pack_context answered the spec question instead of a whole-file read.
        assert.equal(runOf("ini-parser", "pack").leverUses, 1);
        assert.match(textOf(api.requests.find((q) => q.body.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result" && String(b.content).startsWith("PACKED"))))?.body.messages.at(-1).content), /Parsing rules/);
        // Each compact arm compacted once; only ours carried the hook's facts.
        assert.equal(runOf("range-inclusive", "compact").leverUses, 1);
        assert.equal(runOf("range-inclusive", "compact-generic").leverUses, 1);
        const summaries = api.requests.filter((q) => q.body.tool_choice?.type === "none");
        assert.equal(summaries.length, 3 * 2);
        const withFacts = summaries.filter((q) => textOf(q.body.messages.at(-1).content).includes("context-doctor, from this session's transcript"));
        assert.equal(withFacts.length, 3, "one per task: the compact arm's");
        for (const q of withFacts)
            assert.match(textOf(q.body.messages.at(-1).content), /Files changed in this session[\s\S]*src\//);
        // What went on the wire: the version header, the key, the rules only in their arm, no sampling parameters.
        for (const q of api.requests) {
            assert.equal(q.headers["anthropic-version"], AB_API_VERSION);
            assert.equal(q.headers["x-api-key"], "test-key");
            assert.equal(q.body.model, "claude-opus-5-5");
            assert.deepEqual(q.body.cache_control, { type: "ephemeral" });
            assert.equal("temperature" in q.body, false);
        }
        assert.equal(api.requests.filter((q) => q.body.system.includes(SERVER_INSTRUCTIONS)).length, result.runs.filter((x) => x.arm === "rules").reduce((n, x) => n + x.requests, 0));
        // The agent's write to test.mjs was refused, so the check that decided is the shipped one.
        assert.ok(api.requests.some((q) => JSON.stringify(q.body.messages).includes("test.mjs is the check and cannot be changed")));
        // The table.
        assert.match(r.out, /rules: the standing context rules/);
        assert.match(r.out, /passed\s+3\/3\s+3\/3/);
        assert.match(r.out, /Same pass count with and without autoclear\./);
        assert.match(r.out, /requests autopilot changed: [1-9]/);
        assert.match(r.err, /\[18\/18\]/, "progress on stderr");
    }
    finally {
        await api.close();
        rmSync(home, { recursive: true, force: true });
    }
});
test("a lever that breaks a task shows up as a failed run, decided by the check", async () => {
    // The scripted model writes the fixture back instead of the fix when the rules are in its prompt.
    const api = await mockMessagesApi((body, task) => task.id === "csv-quotes" && String(body.system).includes("Context hygiene"));
    try {
        const result = await runAbSuite({ provider: anthropicProvider({ apiKey: "test-key", baseUrl: api.url, retries: 0 }), tasks: AB_TASKS.filter((t) => t.id === "csv-quotes" || t.id === "money-format"), levers: ["rules"], concurrency: 2 });
        const csv = result.runs.filter((r) => r.task === "csv-quotes");
        assert.equal(csv.find((r) => r.arm === "none").pass, true);
        const broken = csv.find((r) => r.arm === "rules");
        assert.equal(broken.pass, false, "the model said it fixed it; the check says otherwise");
        assert.equal(broken.stop, "end_turn");
        const text = renderAb(result);
        assert.match(text, /csv-quotes\s+PASS.*FAIL/);
        assert.match(text, /1 fewer pass with rules: read those runs/);
    }
    finally {
        await api.close();
    }
});
test("without a key it refuses after printing the estimate; without --yes it sends nothing", async () => {
    const api = await mockMessagesApi();
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-ab-gate-"));
    try {
        const base = { ...sandboxEnv(home), ANTHROPIC_BASE_URL: api.url };
        delete base.ANTHROPIC_API_KEY;
        const noKey = await cli(["ab", "--yes"], base);
        assert.equal(noKey.code, 1);
        assert.match(noKey.out, /Estimated cost: ~\$[\d.]+ with prompt caching, up to ~\$[\d.]+ if nothing caches/);
        assert.match(noKey.err, /ANTHROPIC_API_KEY, which is not set\. Nothing was sent\./);
        const noYes = await cli(["ab", "--lever", "pack", "--tasks", "ini-parser"], { ...base, ANTHROPIC_API_KEY: "test-key" });
        assert.equal(noYes.code, 0);
        assert.match(noYes.out, /1 task x 2 arms \(none, pack\) x 1 = 2 runs on claude-opus-5-5/);
        assert.match(noYes.out, /Nothing was sent\. Run again with --yes to spend up to \$\d/);
        assert.equal(api.requests.length, 0, "not one request without consent");
        const bad = await cli(["ab", "--lever", "magic"], base);
        assert.equal(bad.code, 1);
        assert.match(bad.err, /Unknown lever "magic"/);
        const list = await cli(["ab", "--list"], base);
        assert.match(list.out, /ini-parser\s+.*big file: docs\/FORMAT\.md/);
    }
    finally {
        await api.close();
        rmSync(home, { recursive: true, force: true });
    }
});
test("the budget stops new requests, and a wrong key fails every run with exit 1", async () => {
    const api = await mockMessagesApi();
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-ab-budget-"));
    try {
        const env = { ...sandboxEnv(home), ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: api.url };
        const capped = await cli(["ab", "--yes", "--json", "--lever", "rules", "--tasks", "range-inclusive,slugify", "--budget", "0.0001", "--concurrency", "1"], env);
        assert.equal(capped.code, 0, capped.err);
        const result = JSON.parse(capped.out);
        assert.equal(api.requests.length, 1, "the first request spends past the cap; nothing after it is sent");
        assert.ok(result.runs.every((r) => r.stop === "budget"));
        assert.match(capped.err, /Requests stop once \$0\.0001 is spent/);
        const wrongKey = await cli(["ab", "--yes", "--lever", "rules", "--tasks", "range-inclusive"], { ...env, ANTHROPIC_API_KEY: "nope" });
        assert.equal(wrongKey.code, 1);
        assert.match(wrongKey.err, /HTTP 401: invalid x-api-key/);
    }
    finally {
        await api.close();
        rmSync(home, { recursive: true, force: true });
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
