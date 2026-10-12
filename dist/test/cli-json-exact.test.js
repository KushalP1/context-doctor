/**
 * Machine-readable CLI paths: what a script or CI job reads must be complete
 * and parseable, and messages must only claim what happened.
 *
 *  - `session --json --fail-over-budget` exits 1 over budget, like analyze;
 *  - `analyze --json --exact` prints ONE JSON object, exact count inside;
 *  - "Remembered: … calibrated" only when the sample was actually stored, and
 *    CONTEXT_DOCTOR_NO_CALIBRATION=1 stores nothing.
 *
 * The count-tokens API is never called: a preloaded module answers fetch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sandboxEnv } from "./sandbox.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
function run(args, opts) {
    const argv = opts.preload ? ["--import", pathToFileURL(opts.preload).href, cliPath, ...args] : [cliPath, ...args];
    return new Promise((resolve) => {
        execFile(process.execPath, argv, { cwd: opts.cwd, env: opts.env, timeout: 30_000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
    });
}
test("session --json --fail-over-budget exits 1 over budget, as analyze --json does", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-sessjson-"));
    const cwd = mkdtempSync(join(tmpdir(), "ctxdoc-sessjson-cwd-"));
    writeFileSync(join(cwd, ".contextdoctorrc"), JSON.stringify({ budget: { maxTokens: 10 } }));
    const line = (role, text) => JSON.stringify({ type: role, message: { role, content: text } });
    writeFileSync(join(cwd, "s.jsonl"), [line("user", "please do a long task with many words in it"), line("assistant", "sure, a long answer with plenty of words")].join("\n") + "\n");
    const json = await run(["session", "s.jsonl", "--json", "--fail-over-budget"], { cwd, env: sandboxEnv(home) });
    assert.doesNotThrow(() => JSON.parse(json.stdout), "stdout stays one JSON document");
    assert.equal(json.code, 1, "the gate must hold in --json mode, which is what CI pipes");
    assert.match(json.stderr, /over budget/);
    const ungated = await run(["session", "s.jsonl", "--json"], { cwd, env: sandboxEnv(home) });
    assert.equal(ungated.code, 0, "without the flag a breach is reported, not fatal");
});
/** A preload that answers the count-tokens API with MOCK_EXACT_TOKENS. */
function mockFetchModule(dir) {
    const path = join(dir, "mock-fetch.mjs");
    writeFileSync(path, `globalThis.fetch = async (url) => {
  if (!String(url).includes("count_tokens")) throw new Error("unexpected fetch " + url);
  return new Response(JSON.stringify({ input_tokens: Number(process.env.MOCK_EXACT_TOKENS) }), { status: 200, headers: { "content-type": "application/json" } });
};
`);
    return path;
}
/**
 * A conversation, a mocked count-tokens API, and a fresh calibration location
 * per call (calibration lives beside CONTEXT_DOCTOR_HOOK_STATE). `heuristic`
 * is the uncalibrated estimate, so a test can pick an exact count in or out of
 * the accepted 0.5-2x range.
 */
async function exactSetup() {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-exact-"));
    const cwd = mkdtempSync(join(tmpdir(), "ctxdoc-exact-cwd-"));
    const preload = mockFetchModule(cwd);
    writeFileSync(join(cwd, "c.json"), JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hello world ".repeat(40) }] }));
    const analyze = async (args, exact, opts = {}) => {
        const stateDir = mkdtempSync(join(tmpdir(), "ctxdoc-exact-state-"));
        const env = {
            ...sandboxEnv(home),
            CONTEXT_DOCTOR_HOOK_STATE: join(stateDir, "state.json"),
            ANTHROPIC_API_KEY: "test-key-not-real", // fetch is mocked; nothing leaves the machine
            MOCK_EXACT_TOKENS: String(exact),
        };
        // The test runner switches calibration off globally; these cases choose.
        if (opts.calibrationOff)
            env.CONTEXT_DOCTOR_NO_CALIBRATION = "1";
        else
            delete env.CONTEXT_DOCTOR_NO_CALIBRATION;
        const r = await run(["analyze", "c.json", ...args], { cwd, env, preload });
        return { ...r, calibrationWritten: existsSync(join(stateDir, ".context-doctor-calibration.json")) };
    };
    const plain = await analyze(["--json"], 1, { calibrationOff: true });
    const heuristic = JSON.parse(plain.stdout).totalTokens;
    assert.ok(heuristic > 0);
    return { analyze, heuristic };
}
test("analyze --json --exact prints one JSON object with the exact count inside", async () => {
    const { analyze, heuristic } = await exactSetup();
    const inRange = Math.round(heuristic * 1.1);
    const json = await analyze(["--json", "--exact"], inRange);
    let parsed;
    assert.doesNotThrow(() => (parsed = JSON.parse(json.stdout)), `stdout must be valid JSON, got: ${json.stdout.slice(-200)}`);
    assert.equal(parsed.exact?.tokens, inRange);
    assert.match(parsed.exact.source, /count-tokens/);
    assert.equal(parsed.exact.calibrationRecorded, true);
    assert.ok(json.calibrationWritten, "--json still learns from the sample");
});
test("'Remembered' is printed only when the sample was stored", async () => {
    const { analyze, heuristic } = await exactSetup();
    const inRange = Math.round(heuristic * 1.1);
    // An out-of-range sample is rejected, so nothing may claim it was remembered.
    const rejected = await analyze(["--exact"], heuristic * 10);
    assert.match(rejected.stdout, /Exact input tokens: \d+/);
    assert.doesNotMatch(rejected.stdout, /Remembered/, "a rejected sample is not 'remembered'");
    assert.equal(rejected.calibrationWritten, false);
    // The advertised off switch: nothing stored, nothing claimed.
    const off = await analyze(["--exact"], inRange, { calibrationOff: true });
    assert.match(off.stdout, /Exact input tokens/);
    assert.doesNotMatch(off.stdout, /Remembered/);
    assert.equal(off.calibrationWritten, false, "CONTEXT_DOCTOR_NO_CALIBRATION=1 must not write the file");
    // An accepted sample still says so, and is stored.
    const ok = await analyze(["--exact"], inRange);
    assert.match(ok.stdout, /Remembered: future claude estimates/);
    assert.equal(ok.calibrationWritten, true);
});
