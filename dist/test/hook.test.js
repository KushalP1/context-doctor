/**
 * Hook tests: the every-prompt Claude Code hook must stay silent on lean
 * sessions, fire with guidance on heavy ones, and rate-limit re-fires.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const dir = mkdtempSync(join(tmpdir(), "ctxdoc-hook-"));
const statePath = join(dir, "state.json");
function transcriptLine(role, content) {
    return JSON.stringify({ type: role, message: { role, content } });
}
function runHook(transcriptPath, sessionId) {
    return new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [cliPath, "hook"], { env: { ...process.env, CONTEXT_DOCTOR_HOOK_STATE: statePath } }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
        child.stdin.end(JSON.stringify({ session_id: sessionId, transcript_path: transcriptPath }));
    });
}
// Lean session: a couple of small turns.
const leanPath = join(dir, "lean.jsonl");
writeFileSync(leanPath, [transcriptLine("user", "hi"), transcriptLine("assistant", "hello!")].join("\n"));
// Heavy session: ~100k tokens of transcript.
const heavyPath = join(dir, "heavy.jsonl");
const bigTurn = "We discussed the deployment pipeline and database migrations at length. ".repeat(80);
writeFileSync(heavyPath, Array.from({ length: 300 }, (_, i) => transcriptLine(i % 2 ? "assistant" : "user", bigTurn)).join("\n"));
test("hook stays silent on a lean session", async () => {
    const out = await runHook(leanPath, "lean-session");
    assert.equal(out.trim(), "");
});
test("hook fires with hygiene guidance on a heavy session", async () => {
    const out = await runHook(heavyPath, "heavy-session");
    const parsed = JSON.parse(out);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.ok(ctx.includes("<context-doctor>"));
    assert.ok(/context is at ~\d/.test(ctx), "reports the measured size");
    assert.ok(ctx.includes("context hygiene"));
});
test("hook rate-limits: second prompt in the same heavy session is silent", async () => {
    const out = await runHook(heavyPath, "heavy-session");
    assert.equal(out.trim(), "");
});
test("hook never errors on malformed input", async () => {
    const out = await new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [cliPath, "hook"], (err, stdout) => err ? reject(err) : resolve(stdout));
        child.stdin.end("this is not json");
    });
    assert.equal(out.trim(), "");
});
test("concurrent sessions do not erase each other's state", async () => {
    const { mkdtempSync, writeFileSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, dirname } = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
    const dir = mkdtempSync(join(tmpdir(), "ctxdoc-cc-"));
    const transcript = join(dir, "t.jsonl");
    writeFileSync(transcript, [
        JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(400_000) } }),
        JSON.stringify({
            type: "assistant",
            message: { role: "assistant", content: "ok", model: "claude-sonnet-5", usage: { input_tokens: 300_000 } },
        }),
    ].join("\n") + "\n");
    const statePath = join(dir, "state.json");
    const runHook = (sessionId) => new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [cli, "hook"], { env: { ...process.env, CONTEXT_DOCTOR_HOOK_STATE: statePath } }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
        child.stdin?.end(JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: dir }));
    });
    // The hook runs once per prompt in every open window, and people keep several.
    const sessions = Array.from({ length: 12 }, (_, i) => `s${i}`);
    const outputs = await Promise.all(sessions.map(runHook));
    assert.equal(outputs.filter((o) => o.includes("additionalContext")).length, 12, "every session gets its warning");
    // A shared map left 4 of 12 entries; per-session files must keep all of them.
    assert.equal(readdirSync(join(dir, "state.d")).length, 12, "no session's state may be clobbered");
    // And the state must do its job: a second run over an unchanged transcript
    // is gated out, which is what the lost entries used to cost.
    assert.equal(await runHook("s0"), "", "an unchanged session re-warns nobody");
});
test("state written by the older shared-map format is still honoured", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, dirname } = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
    const dir = mkdtempSync(join(tmpdir(), "ctxdoc-mig-"));
    const transcript = join(dir, "t.jsonl");
    writeFileSync(transcript, [
        JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(400_000) } }),
        JSON.stringify({
            type: "assistant",
            message: { role: "assistant", content: "ok", model: "claude-sonnet-5", usage: { input_tokens: 300_000 } },
        }),
    ].join("\n") + "\n");
    const statePath = join(dir, "state.json");
    // The shape previous versions wrote: one map keyed by session id.
    const { statSync } = await import("node:fs");
    writeFileSync(statePath, JSON.stringify({ old: { t: 300_000, b: statSync(transcript).size } }));
    const out = await new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [cli, "hook"], { env: { ...process.env, CONTEXT_DOCTOR_HOOK_STATE: statePath } }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
        child.stdin?.end(JSON.stringify({ session_id: "old", transcript_path: transcript, cwd: dir }));
    });
    assert.equal(out, "", "an upgrade must not restart the nagging it had already suppressed");
});
test("Cursor's agent transcripts parse, and the hook answers Cursor's own payload", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, dirname } = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const { parseSessionFile } = await import("../session.js");
    // Cursor writes {role, message:{content}} per line — no type, no usage —
    // to ~/.cursor/projects/<ws>/agent-transcripts/<id>/<id>.jsonl, and hands
    // that path to hooks it loads from ~/.claude/settings.json. Until this shape
    // parsed, the hook fired on every Cursor prompt and returned nothing.
    const dir = mkdtempSync(join(tmpdir(), "ctxdoc-cursor-hook-"));
    const transcript = join(dir, "conv.jsonl");
    const big = "a large tool result that sits in context forever ".repeat(2500);
    const lines = [
        { role: "user", message: { content: [{ type: "text", text: "<user_query>read the repo</user_query>" }] } },
        { role: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } }] } },
        { role: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: big }] } },
        { role: "assistant", message: { content: [{ type: "text", text: "Here is what I found." }] } },
        ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", message: { content: [{ type: "text", text: `turn ${i}` }] } })),
    ];
    writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const parsed = parseSessionFile(transcript);
    assert.equal(parsed.messageCount, lines.length, "every Cursor line is a message");
    assert.equal(parsed.reportedInputTokens, undefined, "Cursor records no usage; the heuristic stands in");
    const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
    const out = await new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [cli, "hook"], { env: { ...process.env, CONTEXT_DOCTOR_HOOK_STATE: join(dir, "state.json"), CONTEXT_DOCTOR_WARN_TOKENS: "5000" } }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
        // The payload shape Cursor builds: hook_event_name, session_id, transcript_path, workspace_roots, prompt.
        child.stdin?.end(JSON.stringify({ hook_event_name: "beforeSubmitPrompt", session_id: "conv-1", transcript_path: transcript, workspace_roots: [dir], prompt: "next", cursor_version: "2.4" }));
    });
    const result = JSON.parse(out);
    // Claude's nested shape: Cursor's compat layer unwraps hookSpecificOutput and reads additionalContext.
    assert.equal(result.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(result.hookSpecificOutput.additionalContext, /context is at ~\d+k tokens/);
    assert.match(result.hookSpecificOutput.additionalContext, /Tool result at message #2/, "the oversized result is named");
    assert.ok(result.hookSpecificOutput.additionalContext.length < 10_000, "under Cursor's additional_context cap");
});
