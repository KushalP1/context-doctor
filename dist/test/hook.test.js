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
