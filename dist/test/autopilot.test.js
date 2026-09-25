/**
 * Autopilot must never cost more than it saves and never break a request.
 * These pin: eligibility (only re-runnable tools, last 3 kept), batching,
 * cold-only default, stickiness (byte-identical prefix between batches),
 * persistence across restarts, the proxy path, the pause switch, and the
 * service definitions for all three platforms.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoClearer, requestTtlMs } from "../autoclear.js";
import { startProxy } from "../proxy.js";
import { launchdPlist, serviceCommand, systemdUnit, windowsTaskCommand, autopilotPaths } from "../autopilot.js";
const big = (n) => "const value = compute(input, options); // step\n".repeat(n); // ~48 chars/line, code
function conversation(results, opts = {}) {
    const messages = [{ role: "user", content: "fix the build" }];
    for (let i = 0; i < results; i++) {
        messages.push({ role: "assistant", content: [{ type: "tool_use", id: `toolu_${i}`, name: opts.tool ?? "Read", input: { file_path: `/src/f${i}.ts` } }] });
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: big(opts.lines ?? 400) }] });
    }
    return { model: "claude-opus-5", system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h" } }], messages };
}
const HOUR = 3_600_000;
test("TTL comes from the request's own cache_control", () => {
    assert.equal(requestTtlMs(conversation(1)), HOUR);
    assert.equal(requestTtlMs({ messages: [] }), 300_000);
});
test("cold cache: old re-runnable results are cleared in one batch, the last 3 stay", () => {
    const c = new AutoClearer();
    const body = conversation(12);
    const r = c.apply(body, 0);
    assert.equal(r.cold, true);
    assert.equal(r.newlyCleared, 9);
    const contents = body.messages.filter((m) => m.role === "user" && Array.isArray(m.content)).map((m) => m.content[0].content);
    assert.ok(contents.slice(0, 9).every((x) => x.startsWith("[context-doctor: old tool output cleared")));
    assert.ok(contents.slice(9).every((x) => x.startsWith("const value")), "last 3 untouched");
    assert.ok(r.tokensRemoved > 20_000);
    assert.equal(r.firstChanged, 2);
});
test("warm cache: nothing new is cleared by default (never pay a rewrite)", () => {
    const c = new AutoClearer();
    c.apply(conversation(2), 0); // first request, small: nothing eligible
    const r = c.apply(conversation(12), 60_000); // a minute later: warm
    assert.equal(r.cold, false);
    assert.equal(r.newlyCleared, 0);
    assert.equal(r.changed, false);
    assert.match(r.reason, /warm/);
});
test("once cleared, a result stays cleared, so the prefix is byte-identical next time", () => {
    const c = new AutoClearer();
    const first = conversation(12);
    c.apply(first, 0);
    const next = conversation(14); // two more results appended, arrives warm
    const r = c.apply(next, 60_000);
    assert.equal(r.newlyCleared, 0);
    assert.equal(JSON.stringify(next.messages.slice(0, first.messages.length)), JSON.stringify(first.messages), "same bytes as last time");
});
test("small batches wait; answers, subagent reports and MCP output are never touched", () => {
    const c = new AutoClearer();
    const small = conversation(6, { lines: 40 }); // ~3 x 600 tokens eligible: under the 20k batch
    assert.equal(c.apply(small, 0).newlyCleared, 0);
    for (const tool of ["AskUserQuestion", "Task", "mcp__github__get_file"]) {
        const body = conversation(12, { tool });
        const r = new AutoClearer().apply(body, 0);
        assert.equal(r.newlyCleared, 0, `${tool} must not be cleared`);
    }
});
test("cleared ids persist across restarts, so a restart does not un-clear (and re-bill) them", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-ap-"));
    const statePath = join(dir, "cleared.json");
    new AutoClearer({ statePath }).apply(conversation(12), 0);
    const body = conversation(12);
    const r = new AutoClearer({ statePath }).apply(body, 60_000); // new process, warm cache
    assert.equal(r.newlyCleared, 0);
    assert.equal(r.changed, true, "old clearing re-applied");
    assert.ok(String(body.messages[2].content[0].content).startsWith("[context-doctor: old tool output cleared"));
});
test("a malformed request is forwarded unchanged, never an error", () => {
    const r = new AutoClearer().apply({ messages: "nope" }, 0);
    assert.equal(r.changed, false);
});
function openaiChat(results) {
    const messages = [{ role: "system", content: "You are a coding agent." }, { role: "user", content: "fix the build" }];
    for (let i = 0; i < results; i++) {
        messages.push({ role: "assistant", content: null, tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "read_file", arguments: `{"path":"/src/f${i}.ts"}` } }] });
        messages.push({ role: "tool", tool_call_id: `call_${i}`, content: big(400) });
    }
    return { model: "gpt-5", messages };
}
function openaiResponses(results, extra = {}) {
    const input = [{ role: "user", content: "fix the build" }];
    for (let i = 0; i < results; i++) {
        input.push({ type: "function_call", call_id: `call_${i}`, name: "shell", arguments: `{"command":["cat","f${i}.ts"]}` });
        input.push({ type: "function_call_output", call_id: `call_${i}`, output: big(400) });
    }
    return { model: "gpt-5-codex", input, ...extra };
}
test("GPT: OpenAI Chat Completions tool messages are cleared the same way", () => {
    const body = openaiChat(12);
    const r = new AutoClearer().apply(body, 0);
    assert.equal(r.newlyCleared, 9);
    const tools = body.messages.filter((m) => m.role === "tool");
    assert.ok(tools.slice(0, 9).every((m) => m.content.startsWith("[context-doctor")));
    assert.ok(tools.slice(9).every((m) => m.content.startsWith("const value")));
    assert.equal(body.messages[2].tool_calls[0].function.name, "read_file", "the call itself stays, so it can be re-run");
});
test("GPT: OpenAI Responses function_call_output items (Codex with an API key) are cleared", () => {
    const body = openaiResponses(12);
    const r = new AutoClearer().apply(body, 0);
    assert.equal(r.newlyCleared, 9);
    assert.ok(body.input.filter((x) => x.type === "function_call_output").slice(0, 9).every((x) => x.output.startsWith("[context-doctor")));
});
test("GPT: cache lifetime is taken as the longest OpenAI may keep it (1h, or 24h when asked)", () => {
    assert.equal(requestTtlMs(openaiChat(1)), 3_600_000);
    assert.equal(requestTtlMs(openaiResponses(1)), 3_600_000);
    assert.equal(requestTtlMs(openaiResponses(1, { prompt_cache_retention: "24h" })), 24 * 3_600_000);
    const c = new AutoClearer();
    c.apply(openaiChat(2), 0);
    assert.equal(c.apply(openaiChat(12), 30 * 60_000).newlyCleared, 0, "30 minutes later an OpenAI cache may still be warm: wait");
});
// Proxy in autopilot mode against a fake upstream that records what it received.
let received = [];
const upstream = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
        received.push(JSON.parse(b));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 1 } }));
    });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const dir = mkdtempSync(join(tmpdir(), "cd-apx-"));
const pauseFile = join(dir, "paused");
const proxy = startProxy({ port: 0, anthropicUpstream: `http://127.0.0.1:${upstream.address().port}`, autopilot: true, autopilotPauseFile: pauseFile });
await new Promise((r) => proxy.once("listening", r));
const base = `http://127.0.0.1:${proxy.address().port}`;
after(() => { proxy.close(); upstream.close(); });
const send = (body) => fetch(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "k" }, body: JSON.stringify(body) }).then((r) => r.json());
test("proxy autopilot: first (cold) request goes out lighter; stats and /health say so", async () => {
    received = [];
    await send(conversation(12));
    assert.ok(received[0].messages[2].content[0].content.startsWith("[context-doctor"));
    const stats = await fetch(`${base}/stats`).then((r) => r.json());
    assert.equal(stats.autopilot.batches, 1);
    assert.equal(stats.autopilot.coldBatches, 1);
    assert.ok(stats.autopilot.tokensRemoved > 20_000);
    assert.equal(stats.upstreamCacheReadTokens, 1000);
    const h = await fetch(`${base}/health`).then((r) => r.json());
    assert.equal(h.autopilot, true);
});
test("proxy autopilot: OpenAI Chat Completions requests are lightened too", async () => {
    received = [];
    const openaiUp = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { received.push(JSON.parse(b)); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 1 } })); }); });
    await new Promise((r) => openaiUp.listen(0, "127.0.0.1", r));
    const p2 = startProxy({ port: 0, openaiUpstream: `http://127.0.0.1:${openaiUp.address().port}`, autopilot: true });
    await new Promise((r) => p2.once("listening", r));
    try {
        await fetch(`http://127.0.0.1:${p2.address().port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer k" }, body: JSON.stringify(openaiChat(12)) });
        assert.ok(received[0].messages.find((m) => m.role === "tool").content.startsWith("[context-doctor"));
    }
    finally {
        p2.close();
        openaiUp.close();
    }
});
test("proxy autopilot: the pause file makes it a pure passthrough, instantly", async () => {
    received = [];
    writeFileSync(pauseFile, "x");
    const body = conversation(12);
    body.messages[0].content = "a different conversation";
    await send(body);
    assert.deepEqual(received[0], body);
});
test("service definitions for macOS, Linux and Windows run the autopilot proxy with absolute paths", () => {
    const paths = autopilotPaths("/home/u");
    const args = serviceCommand("/usr/bin/node", "/opt/cd/dist/cli.js", 8787, paths);
    assert.deepEqual(args.slice(0, 6), ["/usr/bin/node", "/opt/cd/dist/cli.js", "proxy", "--autopilot", "--port", "8787"]);
    const plist = launchdPlist(args, paths.log);
    assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
    assert.match(plist, /<string>--autopilot<\/string>/);
    const unit = systemdUnit(["/usr/bin/node", "/path with space/cli.js", "proxy"], "/tmp/l.log");
    assert.match(unit, /ExecStart=\/usr\/bin\/node "\/path with space\/cli.js" proxy/);
    assert.match(unit, /Restart=always/);
    assert.equal(windowsTaskCommand(["C:\\node.exe", "C:\\cd\\cli.js", "proxy"]), '"C:\\node.exe" "C:\\cd\\cli.js" "proxy"');
});
