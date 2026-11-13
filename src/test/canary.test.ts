/**
 * scripts/canary.mjs (ROADMAP E2), without Claude Code: the guard that keeps
 * it off the real API, the mock Messages API, the scripted replies, the
 * checks on a run, and the command line driving a stand-in `claude` that does
 * nothing the plugin needs (so the canary must go red). The live run on a
 * real Claude Code is in verify-local and the weekly canary workflow.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { request } from "node:http";

/** The checkout: the suite runs from a folder of its own (scripts/test.mjs), so nothing is relative to the working folder. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts", "canary.mjs");
// The script is plain JavaScript run by node: loaded as untyped.
const load = async (): Promise<any> => import(pathToFileURL(SCRIPT).href);

test("checkEnv: Claude Code starts only on the local mock, the dummy token, and folders inside the throwaway root", async () => {
  const c = await load();
  const root = mkdtempSync(join(tmpdir(), "cd-canary-env-"));
  try {
    const mockUrl = "http://127.0.0.1:43123";
    const env = c.claudeEnv({ root, mockUrl, token: c.dummyToken() });
    assert.deepEqual(c.checkEnv(env, { mockUrl, root }), []);
    // Only PATH comes from the caller: nothing of a real sign-in.
    assert.deepEqual(Object.keys(env).filter((k) => /KEY|OAUTH|BEDROCK|VERTEX/.test(k)), []);
    const bad = (patch: Record<string, string | undefined>, why: RegExp) => {
      const problems: string[] = c.checkEnv({ ...env, ...patch }, { mockUrl, root });
      assert.ok(problems.some((p) => why.test(p)), `${JSON.stringify(patch)} → ${problems.join("; ")}`);
    };
    bad({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, /ANTHROPIC_BASE_URL .* not the local mock/);
    bad({ ANTHROPIC_BASE_URL: "http://127.0.0.1:1" }, /not the local mock/);
    bad({ ANTHROPIC_BASE_URL: undefined }, /ANTHROPIC_BASE_URL is unset/);
    bad({ ANTHROPIC_API_KEY: "sk-ant-api03-real-looking" }, /ANTHROPIC_API_KEY is set/);
    bad({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" }, /CLAUDE_CODE_OAUTH_TOKEN is set/);
    bad({ CLAUDE_CODE_USE_BEDROCK: "1" }, /CLAUDE_CODE_USE_BEDROCK is set/);
    bad({ ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-x" }, /not the canary's dummy token/);
    bad({ HTTPS_PROXY: undefined }, /HTTPS_PROXY is not the mock/);
    bad({ HOME: homedir() }, /HOME .* not inside the throwaway folder/);
    bad({ USERPROFILE: homedir() }, /USERPROFILE .* not inside the throwaway folder/);
    bad({ CLAUDE_CONFIG_DIR: join(homedir(), ".claude") }, /CLAUDE_CONFIG_DIR .* not inside/);
    // A throwaway root inside the real home is refused too: its folders would be the real home's.
    const fakeRoot = join(homedir(), "cd-canary-never-made");
    const inHome: Record<string, string> = { ...env };
    for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "TMPDIR"]) inHome[k] = join(fakeRoot, relative(root, env[k]));
    const problems: string[] = c.checkEnv(inHome, { mockUrl, root: fakeRoot });
    assert.equal(problems.filter((p) => /overlaps the real home/.test(p)).length, 7, problems.join("; "));
    assert.ok(!existsSync(fakeRoot));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the dummy token is no key: unsigned, aud claude-gateway (so Claude Code reads the rate-limit headers)", async () => {
  const c = await load();
  const [head, body, sig] = c.dummyToken(1_800_000_000).split(".");
  assert.equal(JSON.parse(Buffer.from(head, "base64url").toString()).alg, "none");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString());
  assert.equal(claims.aud, "claude-gateway");
  assert.equal(claims.exp, 1_800_000_000 + 86400);
  assert.equal(sig, "canary-not-a-key");
});

test("scriptedReply: a subagent for the canary's prompt, its answer, the result after it; a compaction never gets a tool call", async () => {
  const c = await load();
  const tools = [{ name: "Bash" }, { name: "Agent" }];
  const main = { tools, messages: [{ role: "user", content: [{ type: "text", text: "<system-reminder>x</system-reminder>" }, { type: "text", text: `${c.MAIN}: run one subagent.` }] }, { role: "user", content: [{ type: "text", text: "# Environment" }] }] };
  const call = c.scriptedReply(main);
  assert.equal(call[0].type, "tool_use");
  assert.equal(call[0].name, "Agent");
  assert.match(call[0].input.prompt, new RegExp(c.SUB));
  assert.equal(c.scriptedReply({ tools: [{ name: "Task" }], messages: main.messages })[0].name, "Task", "an older Claude Code's subagent tool");
  assert.equal(c.scriptedReply({ tools, messages: [{ role: "user", content: call[0].input.prompt }] })[0].text, "CANARY-SUB-OK");
  const answered = { tools, messages: [...main.messages, { role: "assistant", content: call }, { role: "user", content: [{ type: "tool_result", tool_use_id: call[0].id, content: "ok" }] }] };
  assert.equal(c.scriptedReply(answered)[0].text, "CANARY-DONE");
  const compaction = { tools, messages: [{ role: "user", content: `${c.MAIN} … write an <analysis> block followed by a <summary> block` }] };
  assert.equal(c.scriptedReply(compaction)[0].type, "text");
  assert.equal(c.scriptedReply({ tools: [], messages: main.messages })[0].type, "text", "no subagent tool: text");
});

function http(url: string, init: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((ok, fail) => {
    const req = request(url + init.path, { method: init.method ?? "GET", headers: init.headers }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", fail);
    req.end(init.body);
  });
}

test("the mock: streamed and plain replies with the rate-limit headers, count_tokens, the credential it got, and every other request refused and named", async () => {
  const c = await load();
  const mock = await c.startMock();
  try {
    const auth = { authorization: `Bearer ${c.dummyToken()}`, "content-type": "application/json" };
    const body = JSON.stringify({ model: "claude-opus-5-5", stream: true, messages: [{ role: "user", content: "hi" }] });
    const s = await http(mock.url, { method: "POST", path: "/v1/messages?beta=true", headers: auth, body });
    assert.equal(s.status, 200);
    assert.match(String(s.headers["content-type"]), /text\/event-stream/);
    assert.equal(s.headers["anthropic-ratelimit-unified-5h-utilization"], String(c.WINDOWS["5h"].utilization));
    assert.equal(s.headers["anthropic-ratelimit-unified-7d-utilization"], String(c.WINDOWS["7d"].utilization));
    const reset = Number(s.headers["anthropic-ratelimit-unified-5h-reset"]);
    assert.ok(Math.abs(reset - (Date.now() / 1000 + c.WINDOWS["5h"].resetIn)) < 60);
    const types = s.text.split("\n").filter((l) => l.startsWith("event: ")).map((l) => l.slice(7));
    assert.deepEqual(types, ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    const plain = await http(mock.url, { method: "POST", path: "/v1/messages", headers: auth, body: JSON.stringify({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "Hi" }] }) });
    const msg = JSON.parse(plain.text);
    assert.equal(msg.model, "claude-haiku-4-5");
    assert.ok(msg.usage.cache_creation_input_tokens > 0);
    assert.equal(JSON.parse((await http(mock.url, { method: "POST", path: "/v1/messages/count_tokens", headers: auth, body: "{}" })).text).input_tokens, 1000);
    // A real-looking key is recorded as such: the run's check turns red on it.
    await http(mock.url, { method: "POST", path: "/v1/messages", headers: { "x-api-key": "sk-ant-api03-real-looking" }, body: "{}" });
    assert.deepEqual(mock.requests.map((r: { auth: string; apiKey: string }) => `${r.auth}/${r.apiKey}`), ["dummy/none", "dummy/none", "dummy/none", "none/OTHER"]);
    assert.equal((await http(mock.url, { path: "/api/oauth/profile" })).status, 404);
    assert.equal(JSON.parse((await http(mock.url, { path: "/__canary" })).text).nonce, mock.nonce);
    assert.deepEqual(mock.refused, ["GET /api/oauth/profile"]);
  } finally {
    await mock.close();
  }
});

/** A green run as Claude Code 2.1.323 gave it, cut to what evaluate reads. */
function greenRun(c: any, pluginDir: string) {
  const sid = "sess-1";
  const now = Math.floor(Date.now() / 1000);
  const hook = (event: string, stdout = "") => ({ type: "system", subtype: "hook_response", hook_event: event, hook_name: event, exit_code: 0, outcome: "success", stdout });
  const events = [
    hook("SessionStart"),
    hook("UserPromptSubmit"),
    { type: "system", subtype: "init", session_id: sid, plugins: [{ name: "context-doctor", path: pluginDir, source: "context-doctor@inline" }], mcp_servers: [{ name: "plugin:context-doctor:context-doctor", status: "connected" }] },
    hook("PreToolUse"),
    { type: "result", is_error: false, result: "CANARY-DONE", total_cost_usd: 0.48252 },
    hook("UserPromptSubmit", JSON.stringify({ systemMessage: "context-doctor: this session has cost $0.48 so far" })),
    { type: "result", is_error: false, total_cost_usd: 0.64336 },
    hook("PreModelSwitch", JSON.stringify({ systemMessage: "context-doctor: switching to claude-haiku-4-5 re-writes this session's ~20k-token context" })),
    { type: "result", is_error: false, total_cost_usd: 0.72378 },
  ];
  return {
    run: { code: 0, events, stderr: "" },
    mock: { requests: [{ auth: "dummy", apiKey: "none", text: `${c.SUB}: reply` }, { auth: "dummy", apiKey: "none", text: `${c.PRECOMPACT_HEAD}: the summary must carry` }], refused: [] as string[] },
    ledgers: {
      limits: [{ app: "claude", w: "five_hour", pct: 42, reset: now + c.WINDOWS["5h"].resetIn }, { app: "claude", w: "seven_day", pct: 17, reset: now + c.WINDOWS["7d"].resetIn }],
      cost: [{ sid, cc: 0.4825, cd: 0.4825, model: "claude-opus-5-5" }],
      main: [{ ev: "precompact" }],
    },
    validate: { code: 0, out: "" },
    pluginDir,
  };
}

test("evaluate: green on a full run; each missing piece turns its check red, and only it", async () => {
  const c = await load();
  const dir = mkdtempSync(join(tmpdir(), "cd-canary-eval-"));
  try {
    const failed = (r: any) => c.evaluate(r).checks.filter((x: any) => !x.ok && !x.soft).map((x: any) => x.name);
    assert.deepEqual(failed(greenRun(c, dir)), []);
    const red = (patch: (r: any) => void, ...want: RegExp[]) => {
      const r = greenRun(c, dir);
      patch(r);
      const names = failed(r);
      for (const w of want) assert.ok(names.some((n: string) => w.test(n)), `${w} in ${names.join(" | ")}`);
      return names;
    };
    assert.equal(red((r) => (r.ledgers.limits = []), /five_hour reading/, /seven_day reading/).length, 2);
    red((r) => (r.ledgers.cost = []), /cost of the session/, /own price/);
    red((r) => (r.ledgers.limits[0].pct = 41), /five_hour reading/);
    red((r) => (r.run.events = r.run.events.filter((e: any) => e.hook_event !== "PreModelSwitch")), /PreModelSwitch hook runs/, /prices the re-write/);
    red((r) => (r.run.events.find((e: any) => e.hook_event === "PreToolUse").exit_code = 1), /PreToolUse hook runs/);
    red((r) => (r.run.events.find((e: any) => e.subtype === "init").plugin_errors = [{ plugin: "context-doctor", type: "hook-load-failed", message: "bad" }]), /no plugin_errors/);
    red((r) => (r.run.events.find((e: any) => e.subtype === "init").plugins = []), /the plugin loads/);
    red((r) => (r.mock.requests = r.mock.requests.slice(0, 1)), /PreCompact hook's instructions/);
    red((r) => (r.validate = { code: 1, out: "✘ Found 1 error" }), /plugin validate/);
    red((r) => r.mock.requests.push({ auth: "OTHER", apiKey: "none", text: "" }), /dummy credential/);
    red((r) => r.mock.refused.push("CONNECT api.anthropic.com:443"), /Anthropic's hosts/);
    red((r) => (r.run.code = 1), /exits 0/);
    // A session that stopped at a step (an older Claude Code that never answers set_model) names it.
    assert.deepEqual(red((r) => ((r.run as any).steps = ["the first prompt and its subagent", "the second prompt"]), /runs every step/), ["the session runs every step: a prompt with a subagent, a second prompt, a model switch, /compact"]);
    assert.deepEqual(failed({ ...greenRun(c, dir), run: { ...greenRun(c, dir).run, steps: ["a", "b", "c", "d"] } }), []);
    // Another host is named but not a failure (the mock refused it); a price gap is a warning.
    const r = greenRun(c, dir);
    r.mock.refused.push("CONNECT example.com:443");
    r.ledgers.cost[0].cd = 0.3;
    const out = c.evaluate(r);
    assert.deepEqual(out.checks.filter((x: any) => !x.ok && !x.soft), []);
    assert.deepEqual(out.checks.filter((x: any) => !x.ok).map((x: any) => x.name).sort(), ["context-doctor's price within 2% of Claude Code's", "nothing tried to reach another host (refused by the mock)"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planted faults: each changes the copy, never the repository", async () => {
  const c = await load();
  const files = (d: string) => readFileSync(join(d, "hooks", "hooks.json"), "utf8") + readFileSync(join(d, "dist", "mod", "register.js"), "utf8") + readFileSync(join(d, "dist", "cli.js"), "utf8");
  const before = files(ROOT);
  for (const name of Object.keys(c.FAULTS)) {
    const dir = c.plant(name, ROOT);
    try {
      assert.ok(existsSync(join(dir, ".claude-plugin", "plugin.json")) && existsSync(join(dir, "dist", "mcp.bundle.js")) && existsSync(join(dir, "assets", "icon.png")));
      assert.ok(!existsSync(join(dir, "dist", "test")), "the tests are not part of the plugin");
      const after = files(dir);
      assert.notEqual(after, before, `${name} planted nothing`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  assert.equal(files(ROOT), before);
  assert.throws(() => c.plant("no-such-fault"), /no such fault/);
});

test("the command line: exit 2 without a Claude Code or on a bad argument; red (exit 1) on one that runs nothing of the plugin, which never sees the caller's keys", { skip: process.platform === "win32" && "a stand-in `claude` is a shebang script" }, () => {
  const run = (args: string[], env: NodeJS.ProcessEnv = process.env) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env, timeout: 120_000 });
  assert.equal(run(["--claude", join(tmpdir(), "no-such-claude-binary")]).status, 2);
  assert.equal(run(["--nope"]).status, 2);
  assert.equal(run(["--plant", "nope", "--claude", process.execPath]).status, 2);
  const dir = mkdtempSync(join(tmpdir(), "cd-canary-fake-"));
  try {
    const fake = join(dir, "claude");
    // Answers --version and validate, then, under -p, one request to ANTHROPIC_BASE_URL and an init and result with no plugin.
    writeFileSync(fake, `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "env.jsonl"), JSON.stringify({ a, env: process.env }) + "\\n");
if (a[0] === "--version") { console.log("0.0.0 (fake)"); process.exit(0); }
if (a[0] === "plugin") { console.log("--profile"); process.exit(0); }
process.stdin.resume();
fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST", headers: { authorization: "Bearer " + process.env.ANTHROPIC_AUTH_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }) })
  .then((r) => r.json()).then(() => {
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s", plugins: [] }));
    console.log(JSON.stringify({ type: "result", is_error: false, total_cost_usd: 0 }));
    process.exit(0);
  });
`);
    chmodSync(fake, 0o755);
    const r = run(["--claude", fake], { ...process.env, ANTHROPIC_API_KEY: "sk-ant-api03-from-the-caller", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-from-the-caller", ANTHROPIC_BASE_URL: "https://api.anthropic.com", GITHUB_ACTIONS: "" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /Claude Code 0\.0\.0 \(fake\)/);
    assert.match(r.stdout, /✗ the plugin loads/);
    assert.match(r.stdout, /✗ the mod writes the five_hour reading/);
    assert.match(r.stdout, /✓ every request the mock got carried the dummy credential/);
    assert.match(r.stdout, /^RED: /m);
    const seen = readFileSync(join(dir, "env.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(seen.some((s) => s.a.includes("-p") && s.a.includes("--plugin-dir")), "it ran -p --plugin-dir");
    for (const { env } of seen) {
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      assert.match(env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.match(env.HOME, /cd-canary-/);
      assert.ok(env.CLAUDE_CONFIG_DIR.startsWith(env.HOME));
    }
    // The throwaway folder is gone afterwards.
    assert.ok(!existsSync(seen[0].env.HOME));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
