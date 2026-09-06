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

function transcriptLine(role: string, content: string): string {
  return JSON.stringify({ type: role, message: { role, content } });
}

function runHook(transcriptPath: string, sessionId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [cliPath, "hook"],
      { env: { ...process.env, CONTEXT_DOCTOR_HOOK_STATE: statePath } },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
    child.stdin!.end(JSON.stringify({ session_id: sessionId, transcript_path: transcriptPath }));
  });
}

// Lean session: a couple of small turns.
const leanPath = join(dir, "lean.jsonl");
writeFileSync(leanPath, [transcriptLine("user", "hi"), transcriptLine("assistant", "hello!")].join("\n"));

// Heavy session: ~100k tokens of transcript.
const heavyPath = join(dir, "heavy.jsonl");
const bigTurn = "We discussed the deployment pipeline and database migrations at length. ".repeat(80);
writeFileSync(
  heavyPath,
  Array.from({ length: 300 }, (_, i) => transcriptLine(i % 2 ? "assistant" : "user", bigTurn)).join("\n")
);

test("hook stays silent on a lean session", async () => {
  const out = await runHook(leanPath, "lean-session");
  assert.equal(out.trim(), "");
});

test("hook fires with hygiene guidance on a heavy session", async () => {
  const out = await runHook(heavyPath, "heavy-session");
  const parsed = JSON.parse(out);
  const ctx = parsed.hookSpecificOutput.additionalContext as string;
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
  const out = await new Promise<string>((resolve, reject) => {
    const child = execFile(process.execPath, [cliPath, "hook"], (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    );
    child.stdin!.end("this is not json");
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
  writeFileSync(
    transcript,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(400_000) } }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "ok", model: "claude-sonnet-5", usage: { input_tokens: 300_000 } },
      }),
    ].join("\n") + "\n"
  );

  const statePath = join(dir, "state.json");
  const runHook = (sessionId: string) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [cli, "hook"],
        { env: { ...process.env, CONTEXT_DOCTOR_HOOK_STATE: statePath } },
        (err, stdout) => (err ? reject(err) : resolve(stdout))
      );
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
  writeFileSync(
    transcript,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(400_000) } }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "ok", model: "claude-sonnet-5", usage: { input_tokens: 300_000 } },
      }),
    ].join("\n") + "\n"
  );
  const statePath = join(dir, "state.json");
  // The shape previous versions wrote: one map keyed by session id.
  const { statSync } = await import("node:fs");
  writeFileSync(statePath, JSON.stringify({ old: { t: 300_000, b: statSync(transcript).size } }));

  const out = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [cli, "hook"],
      { env: { ...process.env, CONTEXT_DOCTOR_HOOK_STATE: statePath } },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
    child.stdin?.end(JSON.stringify({ session_id: "old", transcript_path: transcript, cwd: dir }));
  });
  assert.equal(out, "", "an upgrade must not restart the nagging it had already suppressed");
});
