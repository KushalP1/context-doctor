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
  // The plugin carries the skill too; install skips it while the plugin is on, so "run install" led nowhere.
  assert.match(r.out, /✓ Agent Skill\s+provided by the context-doctor plugin/);
  assert.doesNotMatch(r.out, /Agent Skill\s+not installed/);

  // Disabled is not enabled. (~/.claude.json with Claude Code's own state:
  // without one, Claude Code reads as not installed and so does the hook.)
  const off = claudeHome({ enabledPlugins: { "context-doctor@context-doctor": false } });
  writeFileSync(join(off, ".claude.json"), JSON.stringify({ numStartups: 4 }));
  const r2 = await doctor(off);
  assert.match(r2.out, /✗ Every-prompt hook\s+not registered/);
});

test("settings that hold null, or a list where one belongs, are ignored as Claude Code ignores them: no crash, no \"unreadable\"", async () => {
  // Claude Code's settings: null (doctor stopped with a TypeError before printing a line); a project's too.
  const nul = claudeHome();
  writeFileSync(join(nul, ".claude", "settings.json"), "null");
  writeFileSync(join(nul, ".claude.json"), JSON.stringify({ numStartups: 4 }));
  const project = mkdtempSync(join(tmpdir(), "ctxdoc-nullproj-"));
  mkdirSync(join(project, ".claude"));
  writeFileSync(join(project, ".claude", "settings.json"), "null");
  const r = await doctor(nul, project);
  assert.doesNotMatch(r.err, /TypeError/, r.err);
  assert.match(r.out, /✗ Every-prompt hook\s+not registered/, r.out);

  // An object, a string or nulls where a list of hook entries belongs, beside our real entry.
  const odd = claudeHome({ enabledPlugins: [1], hooks: { UserPromptSubmit: [null, { hooks: null }, { hooks: [null] }, ourHook], PreCompact: "x", PreToolUse: { a: 1 }, PreModelSwitch: 5 } });
  writeFileSync(join(odd, ".claude.json"), JSON.stringify({ numStartups: 4 }));
  const r2 = await doctor(odd);
  assert.doesNotMatch(r2.out, /unreadable|is not a function|Cannot read/, r2.out);
  assert.match(r2.out, /✓ Every-prompt hook\s+registered/, r2.out);

  // Gemini CLI's and Cursor's hook lists the same way.
  const apps = mkdtempSync(join(tmpdir(), "ctxdoc-oddapps-"));
  mkdirSync(join(apps, ".gemini"));
  writeFileSync(join(apps, ".gemini", "settings.json"), JSON.stringify({ theme: "x", hooks: { BeforeAgent: "x" } }));
  mkdirSync(join(apps, ".cursor"));
  writeFileSync(join(apps, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { postToolUse: "x", sessionStart: [null] } }));
  const r3 = await doctor(apps);
  assert.doesNotMatch(r3.out, /unreadable|is not a function|Cannot read/, r3.out);
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

test("the MCP handshake: a crashed server fails at once, a hung one at the timeout, a slow start within it", async () => {
  const { checkMcpHandshake, handshakeTimeoutMs } = await import("../doctor.js");
  assert.equal(handshakeTimeoutMs({}), 15_000, "5 s failed on a loaded machine");
  assert.equal(handshakeTimeoutMs({ CONTEXT_DOCTOR_MCP_HANDSHAKE_MS: "800" }), 800);
  assert.equal(handshakeTimeoutMs({ CONTEXT_DOCTOR_MCP_HANDSHAKE_MS: "soon" }), 15_000);
  const dir = mkdtempSync(join(tmpdir(), "ctxdoc-hs-"));
  const server = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, body); return p; };
  let t = Date.now();
  const crashed = await checkMcpHandshake(server("crash.mjs", "process.exit(3);\n"), 20_000);
  assert.equal(crashed.status, "fail");
  assert.match(crashed.detail, /exited \(code 3\) before answering/);
  assert.ok(Date.now() - t < 10_000, "not the 20 s timeout");
  t = Date.now();
  const hung = await checkMcpHandshake(server("hang.mjs", "setInterval(() => {}, 1000);\n"), 300);
  assert.match(hung.detail, /no initialize response within 0\.3s/);
  // Slow to start (as Node is on a loaded machine), then a good reply.
  const reply = { jsonrpc: "2.0", id: 1, result: { serverInfo: { version: "9.9.9" }, instructions: "rules" } };
  const slow = await checkMcpHandshake(server("slow.mjs", `setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify(reply) + "\n")}), 1500); setInterval(() => {}, 1000);\n`), 15_000);
  assert.equal(slow.status, "ok", slow.detail);
  // Answers, then exits at once: the reply counts.
  const quick = await checkMcpHandshake(server("quick.mjs", `process.stdout.write(${JSON.stringify(JSON.stringify(reply) + "\n")}, () => process.exit(0));\n`), 15_000);
  assert.equal(quick.status, "ok", quick.detail);
});

test("doctor writes the spend budget as `budget` does: $12.50 and $1,000, not $12.5 and $1000", async () => {
  const home = claudeHome({ hooks: { UserPromptSubmit: [ourHook] } });
  writeFileSync(join(home, ".claude", ".context-doctor-budget.json"), JSON.stringify({ usd: 12.5, period: "day", block: false, at: Date.now() }));
  assert.match((await doctor(home)).out, /Spend budget\s+\$12\.50 a day, warns at 50\/80\/100%/);
  writeFileSync(join(home, ".claude", ".context-doctor-budget.json"), JSON.stringify({ usd: 1000, period: "week", block: true, at: Date.now() }));
  assert.match((await doctor(home)).out, /Spend budget\s+\$1,000 a week, prompts over it held/);
});

test("models with no list price of their own in the last 30 days are named, <synthetic> is not; none at all, no line", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxdoc-doc-price-"));
  const empty = await doctor(home);
  assert.doesNotMatch(empty.out, /Model prices/, "nothing ran: nothing to say");

  const now = Date.now();
  const iso = (dt: number) => new Date(now - dt).toISOString();
  const project = join(home, ".claude", "projects", "-tmp-app");
  mkdirSync(project, { recursive: true });
  const reply = (n: number, model: string) => JSON.stringify({
    type: "assistant", uuid: `a${n}`, sessionId: "s1", cwd: "/tmp/app", timestamp: iso(3_600_000 - n * 1000),
    message: { id: `m${n}`, type: "message", role: "assistant", model, content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } },
  });
  writeFileSync(join(project, "s1.jsonl"), [
    JSON.stringify({ type: "user", uuid: "u0", sessionId: "s1", cwd: "/tmp/app", timestamp: iso(3_700_000), message: { role: "user", content: "hi" } }),
    reply(1, "claude-sonnet-5"), reply(2, "claude-opus-97"), reply(3, "claude-opus-97"), reply(4, "<synthetic>"),
  ].join("\n") + "\n");
  const known = await doctor(home);
  assert.match(known.out, /Model prices\s+no list price on file for claude-opus-97 \(2 requests\)/, known.out);
  assert.doesNotMatch(known.out, /synthetic|claude-sonnet-5 \(/, known.out);
  assert.match(known.out, /A newer context-doctor may know them/);

  const codex = join(home, ".codex", "sessions", "2026", "11", "01");
  mkdirSync(codex, { recursive: true });
  writeFileSync(join(codex, "rollout-x.jsonl"), [
    { timestamp: iso(7_200_000), type: "session_meta", payload: { id: "x", cwd: "/tmp/app" } },
    { timestamp: iso(7_100_000), type: "turn_context", payload: { cwd: "/tmp/app", model: "gpt-97-max" } },
    { timestamp: iso(7_000_000), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 110 }, last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 110 } }, rate_limits: null } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const both = await doctor(home);
  assert.match(both.out, /claude-opus-97 \(2 requests\), gpt-97-max \(1 request\)/, both.out);
});
