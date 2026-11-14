/**
 * `ab --via claude-code`, verified without Claude Code or anyone's plan: a
 * fake `claude` on PATH answers --version, --help and `auth status --json`
 * as Claude Code 2.1.325 does, and for `-p` reads the prompt from stdin,
 * logs its arguments and folder, writes the task's reference fix (or not,
 * per model), and prints stream-json the way the real one does (init,
 * assistant, rate_limit_event, result with total_cost_usd and usage). The
 * real flags were verified separately against real Claude Code builds and a
 * local mock API (docs/ab.md). Every test runs in a throwaway HOME.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "./sandbox.js";
import { claudeArgs, modelsFor } from "../abclaude.js";
import { comparisonLine, latestModelComparison } from "../abstore.js";
import { planFixes } from "../fix.js";
const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "..", "cli.js");
const tasksPath = join(here, "..", "abtasks.js");
const windows = process.platform === "win32";
/** The fake Claude Code. FAKE_CFG (JSON) sets what it does; FAKE_LOG gets one line per -p run. */
const FAKE = String.raw `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
const cfg = JSON.parse(process.env.FAKE_CFG || "{}");
const argv = process.argv.slice(2);
const FLAGS = ["--print", "--model", "--output-format", "--verbose", "--restricted", "--safe-mode", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands", "--tools", "--allowedTools", "--disallowedTools", "--permission-mode", "--permission-prompts", "--settings", "dontAsk", "--max-budget-usd"];
if (argv[0] === "--version") { console.log("2.1.325 (Claude Code)"); process.exit(0); }
if (argv[0] === "--help") { console.log("Usage: claude [options]\n" + FLAGS.filter((f) => f !== cfg.dropFlag).map((f) => "  " + f).join("\n")); process.exit(0); }
if (argv[0] === "auth") {
  const auth = cfg.auth ?? "claude.ai";
  if (auth === "none") { console.log(JSON.stringify({ loggedIn: false, authMethod: "none" })); process.exit(1); }
  console.log(JSON.stringify(auth === "claude.ai" ? { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" } : { loggedIn: true, authMethod: "api_key", apiKeySource: "ANTHROPIC_API_KEY" }));
  process.exit(0);
}
if (argv[0] !== "-p") { console.error("unexpected " + argv.join(" ")); process.exit(2); }
const model = argv[argv.indexOf("--model") + 1];
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", async () => {
  // A counter shared by concurrent runs: the first free number.
  let n = 1;
  for (;; n++) { try { mkdirSync(join(cfg.state, "run-" + n)); break; } catch {} }
  appendFileSync(process.env.FAKE_LOG, JSON.stringify({ n, argv, cwd: process.cwd(), pid: process.pid, prompt, claudecode: process.env.CLAUDECODE ?? null }) + "\n");
  const out = (e) => process.stdout.write(JSON.stringify(e) + "\n");
  out({ type: "system", subtype: "init", cwd: process.cwd(), model, permissionMode: "dontAsk", apiKeySource: "none", claude_code_version: "2.1.325", tools: ["Bash", "Edit", "Glob", "Grep", "Read", "Write"] });
  if (cfg.hang === true || cfg.hang === model) { setInterval(() => {}, 1000); return; }
  if (cfg.limitAt === n) {
    out({ type: "assistant", error: "rate_limit", message: { role: "assistant", content: [{ type: "text", text: "You've hit your 5-hour limit" }] } });
    out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1794648988, rateLimitType: "five_hour" } });
    out({ type: "result", subtype: "success", is_error: true, api_error_status: 429, api_error: "usage_limit_reached", result: "You've hit your 5-hour limit · resets 3pm", num_turns: 2, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    process.exit(1);
  }
  const { AB_TASKS } = await import(pathToFileURL(process.env.FAKE_TASKS).href);
  const task = AB_TASKS.find((t) => prompt.includes(t.prompt));
  const fail = (cfg.fail?.[model] ?? []).includes(task?.id);
  if (task && !fail) for (const [p, text] of Object.entries(task.solution)) { mkdirSync(dirname(join(process.cwd(), p)), { recursive: true }); writeFileSync(join(process.cwd(), p), text); }
  out({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Fixed it." }] } });
  const cost = (cfg.costs ?? {})[model] ?? 0.05;
  out({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", num_turns: 6, result: "Fixed it.", total_cost_usd: cost, usage: { input_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500, output_tokens: 300 }, permission_denials: cfg.denials ? [{ tool_name: "Write" }] : [] });
});
`;
function rig(cfg = {}) {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-abcc-home-"));
    const tmp = mkdtempSync(join(tmpdir(), "ctxdoc-abcc-tmp-"));
    const bin = join(home, "bin");
    const state = join(home, "fake-state");
    mkdirSync(bin);
    mkdirSync(state);
    writeFileSync(join(bin, "claude"), FAKE);
    chmodSync(join(bin, "claude"), 0o755);
    const log = join(home, "fake.jsonl");
    const env = { ...sandboxEnv(home), PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, TMPDIR: tmp, TEMP: tmp, TMP: tmp, FAKE_LOG: log, FAKE_TASKS: tasksPath, FAKE_CFG: JSON.stringify({ state, ...cfg }), CLAUDECODE: "1" };
    delete env.CONTEXT_DOCTOR_CLAUDE_BIN;
    delete env.ANTHROPIC_API_KEY;
    return { home, tmp, bin, log, state, env };
}
const logged = (r) => existsSync(r.log) ? readFileSync(r.log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const leftovers = (dir) => readdirSync(dir).filter((n) => n.startsWith("ctxdoc-ab-"));
const storePath = (home) => join(home, ".local", "state", "context-doctor", ".context-doctor-ab.json");
function cli(args, env) {
    return new Promise((resolve) => {
        execFile(process.execPath, [cliPath, ...args], { env, maxBuffer: 32 * 1024 * 1024 }, (err, out, errOut) => resolve({ code: err ? (err.code ?? 1) : 0, out, err: errOut }));
    });
}
const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
};
test("the arms and the flags: Sonnet 5.5 vs Opus 5.5 by default; every run confined, sandboxed, nothing saved", () => {
    assert.deepEqual(modelsFor(undefined, undefined), ["claude-sonnet-5-5", "claude-opus-5-5"]);
    assert.deepEqual(modelsFor("claude-haiku-5-5", ["claude-sonnet-5-5,claude-opus-5-5"]), ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
    assert.deepEqual(modelsFor("claude-opus-5-5", ["none"]), ["claude-opus-5-5"]);
    const a = claudeArgs("claude-sonnet-5-5", 30);
    const after = (f) => a[a.indexOf(f) + 1];
    assert.equal(a[0], "-p");
    assert.equal(after("--model"), "claude-sonnet-5-5");
    assert.equal(after("--output-format"), "stream-json");
    assert.equal(after("--max-turns"), "30");
    assert.equal(after("--permission-mode"), "dontAsk");
    assert.equal(after("--permission-prompts"), "none");
    assert.equal(after("--allowedTools"), "Read Edit Write Glob Grep Bash(node test.mjs)");
    assert.equal(after("--disallowedTools"), "Edit(test.mjs) Write(test.mjs)");
    for (const f of ["--verbose", "--restricted", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"])
        assert.ok(a.includes(f), f);
    assert.deepEqual(JSON.parse(after("--settings")), { sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false } });
    assert.ok(!a.includes("--max-budget-usd"));
    assert.equal(claudeArgs("m", 5, 0.25).at(-1), "0.2500");
    assert.ok(!a.includes("--dangerously-skip-permissions") && !a.includes("bypassPermissions"));
});
test("without --yes: the plan, who pays (a plan's limits, not dollars), and nothing run", { skip: windows }, async () => {
    const r = rig();
    const res = await cli(["ab", "--via", "claude-code", "--tasks", "range-inclusive,slugify"], r.env);
    assert.equal(res.code, 0, res.err);
    assert.match(res.out, /2 tasks x 2 models \(claude-sonnet-5-5, claude-opus-5-5\) x 1 = 4 runs/);
    assert.match(res.out, /Claude Code 2\.1\.325/);
    assert.match(res.out, /signed in to claude\.ai \(max plan\): this draws on your plan's usage limits \(the 5-hour and weekly windows\), not dollars/);
    assert.match(res.out, /At API list prices the runs come to ~\$/);
    assert.match(res.out, /no fitted limit readings/);
    assert.match(res.out, /Nothing was run\. Run again with --yes/);
    assert.deepEqual(logged(r), [], "no claude -p was started");
    const key = rig({ auth: "api_key" });
    const k = await cli(["ab", "--via", "claude-code", "--tasks", "range-inclusive"], key.env);
    assert.equal(k.code, 0, k.err);
    assert.match(k.out, /on an API key \(ANTHROPIC_API_KEY\): this bills that key, in dollars/);
    assert.match(k.out, /No run starts once Claude Code's own costs reach \$\d/);
    assert.deepEqual(logged(key), []);
    // --budget: each run gets what is left as --max-budget-usd; none starts once it is spent.
    const out = join(key.home, "ab.json");
    const b = await cli(["ab", "--via", "claude-code", "--yes", "--tasks", "range-inclusive", "--budget", "0.06", "--concurrency", "1", "--out", out], key.env);
    assert.equal(b.code, 0, b.err);
    const runs = logged(key);
    assert.equal(runs.length, 1, "the second run was not started");
    assert.equal(runs[0].argv[runs[0].argv.indexOf("--max-budget-usd") + 1], "0.0600");
    const result = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(result.runs.map((x) => x.stop), ["end_turn", "budget"]);
    assert.match(b.out, /Claude Code's cost: \$0\.050/);
});
test("refusals before anything runs: not signed in, a Claude Code without the flags, none at all, bad arguments", { skip: windows }, async () => {
    const out = rig({ auth: "none" });
    let res = await cli(["ab", "--via", "claude-code", "--yes", "--tasks", "range-inclusive"], out.env);
    assert.equal(res.code, 1);
    assert.match(res.err, /not signed in/);
    assert.deepEqual(logged(out), []);
    const old = rig({ dropFlag: "--restricted" });
    res = await cli(["ab", "--via", "claude-code", "--yes", "--tasks", "range-inclusive"], old.env);
    assert.equal(res.code, 1);
    assert.match(res.err, /does not list --restricted/);
    assert.deepEqual(logged(old), []);
    const none = rig();
    res = await cli(["ab", "--via", "claude-code", "--yes"], { ...none.env, CONTEXT_DOCTOR_CLAUDE_BIN: join(none.home, "no-such-claude") });
    assert.equal(res.code, 1);
    assert.match(res.err, /could not be run: not found/);
    res = await cli(["ab", "--via", "claude-code", "--lever", "pack"], none.env);
    assert.equal(res.code, 1);
    assert.match(res.err, /--via claude-code compares models/);
    res = await cli(["ab", "--compare", "claude-opus-5-5"], none.env);
    assert.equal(res.code, 1);
    assert.match(res.err, /--compare is for --via claude-code/);
    res = await cli(["ab", "--via", "cloud"], none.env);
    assert.equal(res.code, 1);
    assert.match(res.err, /Unknown --via "cloud"/);
    res = await cli(["ab", "--via", "claude-code", "--model", "sonnet"], none.env);
    assert.equal(res.code, 1);
    assert.match(res.err, /No price is known for sonnet itself/);
    assert.deepEqual(logged(none), []);
});
test("a full run: each task in its own temp copy, the hidden check deciding, Claude Code's own cost and tokens, kept for fix", { skip: windows }, async () => {
    const r = rig({ fail: { "claude-sonnet-5-5": ["slugify"] }, costs: { "claude-sonnet-5-5": 0.05, "claude-opus-5-5": 0.11 }, denials: true });
    const out = join(r.home, "ab.json");
    const res = await cli(["ab", "--via", "claude-code", "--yes", "--tasks", "range-inclusive,slugify,ini-parser", "--out", out], r.env);
    assert.equal(res.code, 0, res.err);
    const result = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(result.models, ["claude-sonnet-5-5", "claude-opus-5-5"]);
    assert.equal(result.runs.length, 6);
    for (const run of result.runs) {
        assert.equal(run.stop, "end_turn");
        assert.equal(run.pass, !(run.model === "claude-sonnet-5-5" && run.task === "slugify"), `${run.task} ${run.model}`);
        assert.equal(run.turns, 6);
        assert.equal(run.inputTokens + run.cacheReadTokens + run.cacheWriteTokens + run.outputTokens, 2900);
        assert.equal(run.denied, 1);
    }
    const [s, o] = result.summary;
    assert.deepEqual([s.model, s.passed, s.completed, o.model, o.passed, o.completed], ["claude-sonnet-5-5", 2, 3, "claude-opus-5-5", 3, 3]);
    assert.ok(Math.abs(s.costUsd - 0.15) < 1e-9 && Math.abs(o.costUsd - 0.33) < 1e-9 && Math.abs(result.costUsd - 0.48) < 1e-9);
    assert.equal(result.claudeCode.authMethod, "claude.ai");
    assert.match(res.out, /Sonnet 5\.5 passed 2\/3, Opus 5\.5 3\/3\./);
    assert.match(res.out, /On your plan: \$0\.480 at list prices, drawn from your usage limits, not billed\./);
    assert.match(res.out, /refused calls +6/);
    // What each claude -p was given.
    const runs = logged(r);
    assert.equal(runs.length, 6);
    assert.equal(new Set(runs.map((x) => x.cwd)).size, 6, "a fresh folder per run");
    for (const x of runs) {
        assert.ok(x.cwd.startsWith(realpathSync(r.tmp)) && x.cwd.endsWith("/repo"), x.cwd);
        assert.deepEqual(x.argv, claudeArgs(x.argv[x.argv.indexOf("--model") + 1], 30));
        assert.match(x.prompt, /^Repository files:[\s\S]*Task: [\s\S]*node test\.mjs/, "the prompt came on stdin");
        assert.ok(!x.argv.some((a) => a.includes("Task:")), "and not as an argument");
        assert.equal(x.claudecode, null, "no enclosing session's marker");
    }
    assert.deepEqual(leftovers(r.tmp), [], "every run folder removed");
    // Kept for fix, in the throwaway home's state folder; fix quotes it.
    const kept = latestModelComparison("claude-sonnet-5-5", storePath(r.home));
    assert.ok(kept, "stored");
    assert.equal(comparisonLine(kept), `on your plan: Sonnet 5.5 passed 2/3, Opus 5.5 3/3, ${result.at.slice(0, 10)}`);
    assert.match(res.out, /Kept for context-doctor fix/);
});
test("a run past --timeout is killed with what it started, its folder removed, and left out of the pass counts", { skip: windows }, async () => {
    const r = rig({ hang: "claude-opus-5-5" });
    const out = join(r.home, "ab.json");
    const started = Date.now();
    const res = await cli(["ab", "--via", "claude-code", "--yes", "--tasks", "range-inclusive", "--timeout", "2", "--out", out], r.env);
    assert.ok(Date.now() - started < 30_000);
    assert.equal(res.code, 0, res.err);
    const result = JSON.parse(readFileSync(out, "utf8"));
    const opus = result.runs.find((x) => x.model === "claude-opus-5-5");
    assert.equal(opus.stop, "timeout");
    assert.match(opus.error, /killed after 2 s/);
    assert.equal(result.runs.find((x) => x.model === "claude-sonnet-5-5").pass, true);
    assert.match(res.out, /TIMEOUT/);
    assert.match(res.out, /0\/0 completed/);
    for (const x of logged(r))
        assert.equal(alive(x.pid), false, "the hung claude is gone");
    assert.deepEqual(leftovers(r.tmp), []);
    assert.equal(existsSync(storePath(r.home)), false, "one model completed nothing: not kept");
});
test("the plan's limit reached mid-run stops the suite: no further run starts, exit 1, nothing kept", { skip: windows }, async () => {
    const r = rig({ limitAt: 2 });
    const out = join(r.home, "ab.json");
    const res = await cli(["ab", "--via", "claude-code", "--yes", "--tasks", "range-inclusive,slugify", "--concurrency", "1", "--out", out], r.env);
    assert.equal(res.code, 1);
    const result = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(result.runs.length, 2, "two of four runs: the second hit the limit");
    assert.equal(result.runs[0].pass, true);
    assert.equal(result.runs[1].stop, "limit");
    assert.match(result.aborted, /usage limit was reached \(You've hit your 5-hour limit/);
    assert.match(res.err, /Stopped: your plan's usage limit was reached/);
    assert.equal(logged(r).length, 2);
    assert.deepEqual(leftovers(r.tmp), []);
    assert.equal(existsSync(storePath(r.home)), false);
});
test("Ctrl-C kills every claude it started and leaves no folder behind", { skip: windows }, async () => {
    const r = rig({ hang: true });
    const child = spawn(process.execPath, [cliPath, "ab", "--via", "claude-code", "--yes", "--tasks", "range-inclusive"], { env: r.env, stdio: "ignore" });
    const deadline = Date.now() + 20_000;
    while (logged(r).length < 2 && Date.now() < deadline)
        await new Promise((res) => setTimeout(res, 100));
    assert.equal(logged(r).length, 2, "both runs started");
    child.kill("SIGINT");
    const code = await new Promise((res) => child.on("close", (c) => res(c)));
    assert.equal(code, 130);
    for (const x of logged(r))
        assert.equal(alive(x.pid), false);
    assert.deepEqual(leftovers(r.tmp), []);
});
/** A replay whose figures the plan tests choose (as in fix-subagentmodel.test.ts). */
function replay(savedUsd, billedUsd = 1000) {
    return {
        candidate: "claude-sonnet-5-5", agents: 200, requests: 9000, billedUsd, atCandidateUsd: billedUsd - savedUsd, savedUsd, unpriced: 0, movedFrom: { "claude-opus-5-5": 900 }, before: { "claude-opus-5-5": 450 },
        byType: [{ type: "general-purpose", agents: 180, requests: 8000, billedUsd: 900, atCandidateUsd: 900 - savedUsd, atHaikuUsd: 30, over100k: 10, moves: true, readOnly: false }],
    };
}
test("fix's subagent-model line quotes the newest kept comparison, else says it is not measured", () => {
    const without = planFixes({ days: 30, billedUsd: 2000, subagentModel: replay(600) })[0];
    assert.match(without.quality, /the quality cost is not measured here: context-doctor ab can measure it/);
    const stored = { at: "2026-11-14T10:00:00.000Z", via: "claude-code", authMethod: "claude.ai", subscriptionType: "max", repeat: 3, tasks: 8, models: [{ model: "claude-opus-5-5", passed: 24, completed: 24, runs: 24, costUsd: 9 }, { model: "claude-sonnet-5-5", passed: 22, completed: 24, runs: 24, costUsd: 4 }] };
    const withIt = planFixes({ days: 30, billedUsd: 2000, subagentModel: replay(600), abComparison: stored })[0];
    assert.equal(withIt.quality, "this changes the model your subagents run on (general-purpose); measured by context-doctor ab on your plan: Sonnet 5.5 passed 22/24, Opus 5.5 24/24, 2026-11-14 (8 small coding tasks, 3 runs each; your subagents' own work may differ)");
    assert.doesNotMatch(withIt.quality, /not measured/);
    assert.match(comparisonLine({ ...stored, authMethod: "api_key" }), /^through your Claude Code: /);
});
