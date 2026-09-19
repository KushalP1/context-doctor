/**
 * Codex (OpenAI's agent) support: rollout transcripts parse with the API's own
 * usage, the hook answers Codex's payload, and install edits config.toml,
 * hooks.json and the skill dir without touching anything else in them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { parseSessionFile } from "../session.js";
import { upsertCodexMcpTable, removeCodexMcpTable } from "../install.js";
import { sandboxEnv } from "./sandbox.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
/** One Codex rollout line. */
const line = (type, payload, ts = "2026-09-19T10:00:00.000Z") => JSON.stringify({ timestamp: ts, type, payload });
function rollout() {
    const dir = mkdtempSync(join(tmpdir(), "ctxdoc-codex-"));
    const path = join(dir, "rollout-2026-09-19T10-00-00-abc.jsonl");
    const big = "line of output ".repeat(2500); // ~37KB: clears the stat-only fast path (threshold x 4 bytes)
    writeFileSync(path, [
        line("session_meta", { session_id: "abc", cwd: "/w", originator: "Codex Desktop" }),
        line("turn_context", { model: "gpt-5.6-sol" }),
        line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "fix the failing test" }] }),
        line("response_item", { type: "reasoning", id: "rs_1", encrypted_content: "gAAAA..." }),
        line("response_item", { type: "custom_tool_call", call_id: "call_1", name: "exec", input: "npm test" }, "2026-09-19T10:00:05.000Z"),
        line("response_item", { type: "custom_tool_call_output", call_id: "call_1", output: [{ type: "input_text", text: big }] }, "2026-09-19T10:00:35.000Z"),
        line("response_item", { type: "function_call", call_id: "call_2", name: "apply_patch", arguments: "{\"path\":\"a.ts\"}" }),
        line("response_item", { type: "function_call_output", call_id: "call_2", output: [{ type: "input_text", text: "ok" }] }),
        line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] }),
        line("event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 22507, cached_input_tokens: 15744, cache_write_input_tokens: 0, output_tokens: 1646 } } }),
        line("world_state", { anything: true }),
    ].join("\n") + "\n");
    return path;
}
test("a Codex rollout parses into messages, tool calls, model and measured usage", () => {
    const p = parseSessionFile(rollout());
    assert.equal(p.model, "gpt-5.6-sol", "model comes from turn_context");
    assert.equal(p.messageCount, 6, "2 messages + 2 calls + 2 outputs; reasoning and world_state carry no context");
    // Codex's input_tokens already includes the cached share: 22507 total, 15744 cached.
    assert.equal(p.reportedInputTokens, 22507, "the API's own input figure, not an estimate");
    const conv = JSON.parse(p.conversationJson);
    const call = conv.messages[1].content;
    assert.equal(call[0].type, "tool_use");
    assert.equal(call[0].id, "call_1", "custom_tool_call maps to tool_use keyed by call_id");
    const patch = conv.messages[3].content;
    assert.deepEqual(patch[0].input, { path: "a.ts" }, "JSON-string arguments are parsed");
    const exec = p.toolTimings?.find((t) => t.tool === "exec");
    assert.equal(exec?.totalMs, 30_000, "tool wall clock pairs call_id across the two lines");
});
test("the hook answers Codex's payload with Claude-shaped output Codex accepts", async () => {
    const transcript = rollout();
    const out = await new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [cliPath, "hook"], { env: { ...process.env, CONTEXT_DOCTOR_HOOK_STATE: join(dirname(transcript), "state.json"), CONTEXT_DOCTOR_WARN_TOKENS: "5000" } }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
        // Exactly the fields Codex documents for UserPromptSubmit.
        child.stdin?.end(JSON.stringify({ session_id: "abc", transcript_path: transcript, cwd: "/w", hook_event_name: "UserPromptSubmit", turn_id: "t1", prompt: "go", permission_mode: "default", model: "gpt-5.6-sol" }));
    });
    const r = JSON.parse(out);
    assert.equal(r.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(r.hookSpecificOutput.additionalContext, /~23k tokens/, "uses the measured 22,507 figure (formatted), not the ~9k heuristic");
    assert.ok(r.hookSpecificOutput.additionalContext.length < 2_000, "well under Codex's ~2,500-token hook output cap");
});
test("config.toml editing touches only our table", () => {
    const theirs = `model = "gpt-5.6-sol"\n\n[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "x"]\n\n[plugins."browser@openai-bundled"]\nenabled = true\n`;
    const entry = { command: "node", args: ["/p/mcp.js"] };
    const once = upsertCodexMcpTable(theirs, entry);
    assert.ok(once.startsWith(theirs), "everything the user wrote survives byte for byte");
    assert.match(once, /\[mcp_servers\.context-doctor\]\ncommand = "node"\nargs = \["\/p\/mcp\.js"\]/);
    assert.equal(upsertCodexMcpTable(once, entry), once, "idempotent");
    const moved = upsertCodexMcpTable(once, { command: "npx", args: ["-y", "context-doctor-mcp"] });
    assert.equal((moved.match(/mcp_servers\.context-doctor/g) ?? []).length, 1, "re-running replaces, never duplicates");
    assert.match(moved, /command = "npx"/);
    assert.equal(removeCodexMcpTable(moved).trim(), theirs.trim(), "removal restores the user's file");
    assert.equal(removeCodexMcpTable(theirs), theirs, "removing what is not there changes nothing");
    // Our table in the MIDDLE of the file: the following table must survive.
    const middle = `[mcp_servers.context-doctor]\ncommand = "old"\nargs = []\n\n[mcp_servers.github]\ncommand = "npx"\n`;
    const fixed = upsertCodexMcpTable(middle, entry);
    assert.match(fixed, /\[mcp_servers\.github\]\ncommand = "npx"/, "the next table is intact");
    assert.ok(!fixed.includes('"old"'));
});
test("install wires Codex when ~/.codex exists and uninstall removes only ours", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-codexhome-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), `model = "gpt-5.6-sol"\n\n[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "x"]\n`);
    writeFileSync(join(home, ".codex", "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "their-own-hook" }] }] } }));
    const run = (cmd) => new Promise((resolve, reject) => {
        execFile(process.execPath, [cliPath, cmd], { env: sandboxEnv(home) }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
    });
    const out = await run("install");
    assert.match(out, /Codex: MCP server added/);
    assert.match(out, /Codex every-prompt hook installed/);
    assert.match(out, /trust it once: open Codex, type \/hooks/, "the one Codex-specific step is spelled out");
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    assert.match(toml, /\[mcp_servers\.github\]/, "their server survives");
    assert.match(toml, /\[mcp_servers\.context-doctor\]/);
    const hooks = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8")).hooks.UserPromptSubmit;
    assert.equal(hooks.length, 2, "their hook plus ours");
    assert.ok(existsSync(join(home, ".codex", "skills", "context-doctor", "SKILL.md")));
    await run("uninstall");
    assert.ok(!readFileSync(join(home, ".codex", "config.toml"), "utf8").includes("context-doctor"));
    assert.match(readFileSync(join(home, ".codex", "config.toml"), "utf8"), /\[mcp_servers\.github\]/);
    const left = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8")).hooks.UserPromptSubmit;
    assert.deepEqual(left.map((h) => h.hooks[0].command), ["their-own-hook"], "only ours is removed");
    assert.ok(!existsSync(join(home, ".codex", "skills", "context-doctor")));
});
