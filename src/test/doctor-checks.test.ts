/**
 * doctor exists to turn "it doesn't work" into one line. Each case here is a
 * real setup it used to misread: a broken rc file reported as absent, a
 * damaged autopilot file that crashed it before any line was printed, hooks
 * switched off globally, plugin installs reported as missing, and a Claude
 * Code home without settings.json reported as "not detected".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, RC_FILENAME } from "../config.js";
import { sandboxEnv } from "./sandbox.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

function doctor(home: string, cwd?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, "doctor"], { env: sandboxEnv(home), cwd, timeout: 30_000 }, (error, stdout, stderr) =>
      resolve({ code: error ? (error as { code?: number }).code ?? 1 : 0, out: stdout, err: stderr })
    );
  });
}

function claudeHome(settings?: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "ctxdoc-doc-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  if (settings !== undefined) writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(settings));
  return home;
}

const ourHook = { hooks: [{ type: "command", command: "npx -y context-doctor hook" }] };

test("loadConfig names a malformed rc file instead of pretending there is none", () => {
  const root = mkdtempSync(join(tmpdir(), "ctxdoc-badrc-"));
  writeFileSync(join(root, RC_FILENAME), '{ "budget": { "maxTokens": 50000 ');
  const loaded = loadConfig(root);
  assert.equal(loaded.path, join(root, RC_FILENAME), "the file was found; it is just unreadable");
  assert.ok(loaded.error, "and why it cannot be used");
  assert.deepEqual(loaded.config, {}, "its settings are not in effect");
});

test("doctor reports a malformed .contextdoctorrc as a failure, not as absent", async () => {
  const home = claudeHome({ hooks: { UserPromptSubmit: [ourHook] } });
  const project = mkdtempSync(join(tmpdir(), "ctxdoc-badrc-proj-"));
  writeFileSync(join(project, RC_FILENAME), "{ not json");
  const r = await doctor(home, project);
  assert.match(r.out, /✗ Project config\s+.*\.contextdoctorrc.*(ignored|cannot)/);
  assert.ok(!/no \.contextdoctorrc/.test(r.out));
  assert.ok(!/All good/.test(r.out));
});

test("a truncated autopilot config is a failed check, not a crash that hides every other check", async () => {
  const home = claudeHome({ hooks: { UserPromptSubmit: [ourHook] } });
  writeFileSync(join(home, ".claude", ".context-doctor-autopilot.json"), '{"port": 87');
  const r = await doctor(home);
  assert.equal(r.code, 1, "a failed check is exit 1");
  assert.ok(!/at .*doctor\.js/.test(r.err), "no stack trace");
  assert.match(r.out, /CONTEXT DOCTOR — self-check/, "the report is printed");
  assert.match(r.out, /✗ Autopilot\s+.*context-doctor-autopilot\.json/);
  assert.match(r.out, /Every-prompt hook/, "and every other check with it");
});

test("disableAllHooks in Claude Code's settings is reported: the hook is registered but never runs", async () => {
  const home = claudeHome({ disableAllHooks: true, hooks: { UserPromptSubmit: [ourHook], PreCompact: [ourHook] } });
  const r = await doctor(home);
  assert.match(r.out, /✗ Every-prompt hook\s+.*disableAllHooks/);
});

test("an enabled context-doctor plugin counts as the MCP server and the hook", async () => {
  // enabledPlugins maps "<plugin>@<marketplace>" to true/false.
  const home = claudeHome({ enabledPlugins: { "context-doctor@context-doctor": true, "other@somewhere": true } });
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: {} }));
  const r = await doctor(home);
  assert.match(r.out, /✓ Claude Code\s+.*plugin/);
  assert.match(r.out, /✓ Every-prompt hook\s+.*plugin/);
  assert.match(r.out, /✓ Compaction hook\s+.*plugin/);

  // Disabled is not enabled. (~/.claude.json with Claude Code's own state:
  // without one, Claude Code reads as not installed and so does the hook.)
  const off = claudeHome({ enabledPlugins: { "context-doctor@context-doctor": false } });
  writeFileSync(join(off, ".claude.json"), JSON.stringify({ numStartups: 4 }));
  const r2 = await doctor(off);
  assert.match(r2.out, /✗ Every-prompt hook\s+not registered/);
});

test("~/.claude without settings.json means the hook is not registered, not that Claude Code is absent", async () => {
  const home = claudeHome();
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ numStartups: 4 }));
  const r = await doctor(home);
  assert.match(r.out, /✗ Every-prompt hook\s+not registered/);
  assert.ok(!/Claude Code not detected/.test(r.out));
});

test("Devin is reported for what it is: hooks from ~/.claude run in its CLI, with no transcript to measure", async () => {
  const { devinCheck } = await import("../doctor.js");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "cd-devin-"));
  const none = devinCheck(home);
  if (!/not detected/.test(none.detail)) return; // a real Devin on PATH or in /Applications: the sandbox cannot hide it
  assert.equal(none.status, "skip");
  mkdirSync(join(home, ".config", "devin"), { recursive: true });
  writeFileSync(join(home, ".config", "devin", "config.json"), "{}");
  const cli = devinCheck(home);
  assert.equal(cli.status, "skip");
  assert.match(cli.detail, /Devin CLI runs the hooks in ~\/\.claude\/settings\.json .*no transcript path/);
  writeFileSync(join(home, ".config", "devin", "config.json"), JSON.stringify({ read_config_from: { claude: false } }));
  assert.match(devinCheck(home).detail, /read_config_from\.claude off/);
  mkdirSync(join(home, ".devin"));
  assert.match(devinCheck(home).detail, /Devin Desktop found \(~[\\/]\.devin\)/);
});
