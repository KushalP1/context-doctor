/** Inputs the profiler used to misread: Gemini contents, OpenAI Responses input, null content, non-strings, BOMs; and optimize counting what OpenAI requests carry. */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConversation } from "../parse.js";
import { profileConversation } from "../profile.js";
import { optimizeConversation } from "../optimize.js";
import { startProxy } from "../proxy.js";
import { renderProfile } from "../report.js";
import { sandboxEnv } from "./sandbox.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const big = "The quarterly report covers revenue, churn and hiring plans in detail. ".repeat(200);
test("Gemini contents are profiled, not called 'not a conversation'", () => {
    const conv = parseConversation(JSON.stringify({
        model: "gemini-3.6-flash",
        systemInstruction: { parts: [{ text: "Be brief." }] },
        contents: [
            { role: "user", parts: [{ text: big }] },
            { role: "model", parts: [{ functionCall: { name: "search", args: { q: "churn" } } }] },
            { role: "user", parts: [{ functionResponse: { name: "search", response: { output: "42 results" } } }] },
            { role: "model", parts: [{ text: "Done." }, { inlineData: { mimeType: "image/png", data: "AAAA" } }] },
        ],
    }));
    assert.equal(conv.parseWarning, undefined);
    assert.equal(conv.sourceFormat, "gemini");
    assert.deepEqual(conv.messages.map((m) => m.kind), ["system", "user", "tool_call", "tool_result", "assistant"]);
    assert.equal(conv.messages[2].toolName, "search");
    assert.equal(conv.messages[4].hasBinary, true);
    const p = profileConversation(conv);
    assert.ok(p.totalTokens > 2000, String(p.totalTokens));
});
test("OpenAI Responses input is profiled, including calls, outputs and shell calls", () => {
    const conv = parseConversation(JSON.stringify({
        model: "gpt-5",
        instructions: "You are a coding agent.",
        input: [
            { role: "developer", content: "Repo rules." },
            { type: "message", role: "user", content: [{ type: "input_text", text: big }] },
            { type: "function_call", name: "shell", arguments: '{"cmd":"ls"}', call_id: "c1" },
            { type: "function_call_output", call_id: "c1", output: "a.ts\nb.ts" },
            { type: "local_shell_call", action: { command: ["cat", "a.ts"] }, call_id: "c2" },
        ],
    }));
    assert.equal(conv.parseWarning, undefined);
    assert.equal(conv.sourceFormat, "responses");
    assert.deepEqual(conv.messages.map((m) => m.kind), ["system", "system", "user", "tool_call", "tool_result", "tool_call"]);
    assert.ok(!conv.messages[2].text.includes("input_text"), "text parts are text, not JSON");
    assert.equal(parseConversation(JSON.stringify({ input: "just a prompt" })).messages[0].text, "just a prompt");
});
test("null OpenAI content is no text, and non-string input never throws", () => {
    const conv = parseConversation(JSON.stringify({ messages: [{ role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }] }] }));
    assert.ok(!conv.messages[0].text.startsWith('""'), conv.messages[0].text);
    assert.doesNotThrow(() => parseConversation(undefined));
    assert.doesNotThrow(() => parseConversation(42));
    const fromObject = parseConversation({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(fromObject.messages[0].text, "hi");
});
test("broken JSON: the CLI does not claim to profile what it refuses; the library report says what it profiled", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-broken-"));
    writeFileSync(join(dir, "broken.json"), '{"messages": [');
    const r = spawnSync(process.execPath, [cliPath, "analyze", join(dir, "broken.json")], { encoding: "utf8", env: sandboxEnv(dir) });
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /Profiling it as raw text/);
    assert.match(r.stderr, /does not parse/);
    const report = renderProfile(profileConversation(parseConversation('{"messages": [')));
    assert.match(report, /Profiled as raw text below/);
});
test("a UTF-8 BOM does not make a conversation file unreadable", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-bom-"));
    writeFileSync(join(dir, "bom.json"), "﻿" + JSON.stringify({ messages: [{ role: "user", content: "hello there" }] }));
    const r = spawnSync(process.execPath, [cliPath, "analyze", join(dir, "bom.json"), "--json"], { encoding: "utf8", env: sandboxEnv(dir) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).messageCount, 1);
});
const openAiWithBigCall = () => ({
    model: "gpt-5",
    messages: [
        { role: "user", content: "write the file" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "a.txt", body: big }) } }] },
        { role: "tool", tool_call_id: "c1", content: "ok" },
        ...Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i}` })),
    ],
});
test("optimize counts OpenAI tool_calls arguments, so trimming them shows as a saving", () => {
    const body = openAiWithBigCall();
    const r = optimizeConversation(JSON.stringify(body), { strategies: ["trim-tool-calls"] });
    assert.ok(r.tokensBefore > 2000, `before counts the arguments (${r.tokensBefore})`);
    assert.ok(r.tokensBefore - r.tokensAfter > 1500, `${r.tokensBefore} -> ${r.tokensAfter}`);
    assert.equal(r.applied[0].strategy, "trim-tool-calls");
    // System prompt and tools count on both sides.
    const withSystem = optimizeConversation(JSON.stringify({ system: "x ".repeat(500), tools: [{ name: "t", description: "d ".repeat(300) }], messages: [{ role: "user", content: "hi" }] }), {});
    assert.ok(withSystem.tokensBefore > 300 && withSystem.tokensBefore === withSystem.tokensAfter);
});
test("prune-history with keep_recent 0 or 1 still prunes, keeping the last exchange", () => {
    const msgs = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `message ${i} ` + "words ".repeat(40) }));
    for (const keepRecent of [0, 1]) {
        const r = optimizeConversation(JSON.stringify({ messages: msgs.map((m) => ({ ...m })) }), { strategies: ["prune-history"], keepRecent });
        const out = r.conversation.messages;
        assert.ok(r.applied.some((a) => a.strategy === "prune-history"), `keepRecent ${keepRecent}`);
        assert.equal(out.length, 3);
        assert.match(out[2].content, /^message 11/);
    }
});
test("the optimizing proxy forwards trimmed OpenAI tool_calls arguments", async () => {
    let received = "";
    const upstream = http.createServer((req, res) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => {
            received = b;
            res.writeHead(200, { "content-type": "application/json" });
            res.end('{"usage":{"prompt_tokens":10,"completion_tokens":1}}');
        });
    });
    await new Promise((r) => upstream.listen(0, r));
    const proxy = startProxy({ port: 0, openaiUpstream: `http://localhost:${upstream.address().port}`, strategies: ["trim-tool-calls"] });
    await new Promise((r) => proxy.once("listening", () => r()));
    try {
        const body = JSON.stringify(openAiWithBigCall());
        const resp = await fetch(`http://localhost:${proxy.address().port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer sk-test-not-real" },
            body,
        });
        await resp.text();
        assert.ok(received.length > 0 && received.length < body.length / 2, `upstream got ${received.length} of ${body.length} chars`);
        const args = JSON.parse(JSON.parse(received).messages[1].tool_calls[0].function.arguments);
        assert.equal(args.path, "a.txt", "arguments stay valid JSON with their keys");
    }
    finally {
        proxy.close();
        upstream.close();
    }
});
