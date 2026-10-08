/**
 * Gemini CLI support: chat recordings parse (rewrites by id, rewinds, legacy
 * JSON) with the API's own token counts; the hook answers BeforeAgent; install
 * wires ~/.gemini/settings.json and uninstall removes only ours.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { parseSessionFile } from "../session.js";
import { isGeminiChat, listGeminiChats } from "../gemini.js";
import { sandboxEnv } from "./sandbox.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const big = "line of build output\n".repeat(2000);
function chat(dir) {
    const path = join(dir, "session-2026-10-08T10-00-abc.jsonl");
    const meta = { sessionId: "abc", projectHash: "p1", startTime: "2026-10-08T10:00:00Z", lastUpdated: "2026-10-08T10:00:00Z", kind: "main" };
    const call = { id: "c1", name: "run_shell_command", args: { command: "npm run build" } };
    writeFileSync(path, [
        meta,
        { id: "u1", timestamp: "2026-10-08T10:00:01Z", type: "user", content: [{ text: "build it" }] },
        { id: "g1", timestamp: "2026-10-08T10:00:02Z", type: "gemini", content: "", toolCalls: [call], model: "gemini-3-pro" },
        // Same id written again once the tool finished and usage arrived: it replaces the first copy.
        { id: "g1", timestamp: "2026-10-08T10:00:09Z", type: "gemini", content: "", model: "gemini-3-pro", toolCalls: [{ ...call, result: [{ functionResponse: { id: "c1", name: "run_shell_command", response: { output: big } } }] }], tokens: { input: 31_000, output: 40, cached: 20_000 } },
        { $set: { lastUpdated: "2026-10-08T10:00:09Z" } },
        { id: "u2", type: "user", content: "oops, ignore that" },
        { id: "g2", type: "gemini", content: "Ignoring.", tokens: { input: 99_000, output: 5 } },
        { $rewindTo: "u2" },
        { id: "u3", type: "user", content: "now run the tests" },
        { id: "g3", type: "gemini", content: "Done.", model: "gemini-3-pro", tokens: { input: 52_000, output: 12, cached: 30_000 } },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    return path;
}
test("a Gemini CLI chat parses: rewrites replace by id, a rewind drops what came after, usage is the API's", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxdoc-gemini-"));
    const path = chat(dir);
    assert.ok(isGeminiChat(path));
    const s = parseSessionFile(path);
    assert.equal(s.model, "gemini-3-pro");
    assert.equal(s.reportedInputTokens, 52_000, "the last reply's promptTokenCount, not the rewound 99k");
    const msgs = JSON.parse(s.conversationJson).messages;
    assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "user", "user", "assistant"]);
    assert.ok(!JSON.stringify(msgs).includes("oops"), "the rewound turn is gone");
    assert.equal(msgs[1].content[0].type, "tool_use");
    assert.equal(msgs[2].content[0].type, "tool_result");
    assert.ok(msgs[2].content[0].content.includes("line of build output"));
});
test("a legacy single-document Gemini chat parses too", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxdoc-gemini-"));
    const path = join(dir, "session-old.json");
    writeFileSync(path, JSON.stringify({ sessionId: "x", projectHash: "p", messages: [{ id: "1", type: "user", content: "hi" }, { id: "2", type: "gemini", content: "hello", tokens: { input: 1200 } }] }, null, 2));
    const s = parseSessionFile(path);
    assert.equal(s.messageCount, 2);
    assert.equal(s.reportedInputTokens, 1200);
});
test("chats are listed from ~/.gemini/tmp/<project>/chats", () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-geminihome-"));
    mkdirSync(join(home, ".gemini", "tmp", "p1", "chats"), { recursive: true });
    chat(join(home, ".gemini", "tmp", "p1", "chats"));
    assert.equal(listGeminiChats(home).length, 1);
});
test("the hook answers Gemini CLI's BeforeAgent with its own event name and the measured size", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxdoc-gemini-"));
    const transcript = chat(dir);
    const out = await new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [cliPath, "hook"], { env: { ...process.env, CONTEXT_DOCTOR_HOOK_STATE: join(dir, "state.json"), CONTEXT_DOCTOR_WARN_TOKENS: "5000" } }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
        child.stdin?.end(JSON.stringify({ session_id: "abc", transcript_path: transcript, cwd: dir, hook_event_name: "BeforeAgent", timestamp: "2026-10-08T10:01:00Z", prompt: "go" }));
    });
    const r = JSON.parse(out);
    assert.equal(r.hookSpecificOutput.hookEventName, "BeforeAgent");
    assert.match(r.hookSpecificOutput.additionalContext, /~52k tokens/);
});
test("install wires Gemini CLI's settings.json (MCP + BeforeAgent hook); uninstall removes only ours", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-geminihome-"));
    mkdirSync(join(home, ".gemini"), { recursive: true });
    const settingsPath = join(home, ".gemini", "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ theme: "dark", mcpServers: { github: { command: "x" } }, hooks: { BeforeAgent: [{ hooks: [{ type: "command", command: "their-hook" }] }] } }));
    const run = (cmd) => new Promise((resolve, reject) => {
        execFile(process.execPath, [cliPath, cmd], { env: sandboxEnv(home) }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
    });
    const out = await run("install");
    assert.match(out, /Gemini CLI: MCP server added/);
    assert.match(out, /Gemini CLI every-prompt hook installed/);
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(s.theme, "dark");
    assert.ok(s.mcpServers.github && s.mcpServers["context-doctor"]);
    assert.equal(s.hooks.BeforeAgent.length, 2);
    await run("uninstall");
    const after = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.ok(!after.mcpServers["context-doctor"] && after.mcpServers.github);
    assert.deepEqual(after.hooks.BeforeAgent.map((h) => h.hooks[0].command), ["their-hook"]);
});
