/**
 * Findings of the end-to-end QA pass on 0.39.0, each pinned:
 * a stale skill under a ✓ in `doctor`; `fix` calling an empty history
 * "nothing left to fix"; a raw "~4050912 tokens" in profile findings; a
 * negative context window in the status line; the Action pin in the docs
 * lagging the release; `install --help` without Antigravity; the proxy
 * banner without GOOGLE_GEMINI_BASE_URL.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "./sandbox.js";
import { freePort } from "./freeport.js";
import { renderStatusLine } from "../statusline.js";
import { profileConversation } from "../profile.js";
import { parseConversation } from "../parse.js";
import { renderFixPlan, renderFixShare } from "../fix.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const root = join(dirname(cliPath), "..");

function run(home: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, ...args], { env: { ...sandboxEnv(home), CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS: "9.9.9" }, timeout: 60_000 }, (error, stdout, stderr) =>
      resolve({ code: error ? (error as { code?: number }).code ?? 1 : 0, out: stdout, err: stderr })
    );
  });
}

test("doctor says an installed skill differs from the shipped one, for Claude Code, Codex and Antigravity", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxdoc-qa-skill-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  assert.equal((await run(home, ["install"])).code, 0);
  const fresh = await run(home, ["doctor"]);
  assert.match(fresh.out, /✓ Agent Skill/);
  assert.match(fresh.out, /✓ Codex skill/);
  assert.match(fresh.out, /✓ Antigravity skill/);
  // An older version's copy: install never refreshes it on its own.
  for (const f of [join(home, ".claude", "skills", "context-doctor", "SKILL.md"), join(home, ".codex", "skills", "context-doctor", "SKILL.md"), join(home, ".gemini", "config", "skills", "context-doctor", "SKILL.md")]) {
    writeFileSync(f, readFileSync(f, "utf8").replace(/\n[^\n]*\n$/, "\nan old rule\n"));
  }
  const stale = await run(home, ["doctor"]);
  for (const label of ["Agent Skill", "Codex skill", "Antigravity skill"]) {
    assert.match(stale.out, new RegExp(`! ${label}\\s+.*differs from the skill this version ships.*re-run \`context-doctor install\``), stale.out);
  }
  // Install brings them back in line.
  assert.equal((await run(home, ["install"])).code, 0);
  assert.match((await run(home, ["doctor"])).out, /✓ Agent Skill/);
});

test("fix with no Claude Code history says so, instead of 'nothing left to fix'", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxdoc-qa-fix-"));
  const r = await run(home, ["fix"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /No Claude Code sessions in the last 30 days to measure yet/);
  assert.match(r.out, /Use Claude Code for a while, then run this again: .*fix/);
  assert.ok(!/Nothing left to fix|every lever that pays/.test(r.out), r.out);
  const share = await run(home, ["fix", "--share"]);
  assert.match(share.out, /- no Claude Code sessions to measure yet/);
  assert.ok(!/nothing left to fix/.test(share.out), share.out);
  // With a history and nothing available, the old wording is still right.
  assert.match(renderFixPlan(30, 12, [], []), /Nothing left to fix here/);
  assert.match(renderFixShare(30, 12, []), /- nothing left to fix/);
});

test("profile findings give token counts as 4.1M, not a raw ~4050912", () => {
  const big = "lorem ipsum dolor sit amet ".repeat(20_000);
  const messages = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: i < 30 ? big : "ok" }));
  const p = profileConversation(parseConversation(JSON.stringify(messages)));
  const long = p.findings.find((f) => f.id === "long_history");
  assert.ok(long, JSON.stringify(p.findings.map((f) => f.id)));
  assert.match(long!.message, /older half holds ~[\d.]+[kM] tokens/);
  for (const f of p.findings) assert.ok(!/~\d{5,} tokens/.test(f.message), f.message);
});

test("statusline treats a context window that is not a positive number as unknown", () => {
  for (const size of [-5, 0, Number.NaN]) {
    const line = renderStatusLine({ model: { id: "claude-sonnet-5" }, context_window: { context_window_size: size, current_usage: { input_tokens: 279_000 } } });
    assert.ok(line && !/-\d|NaN|Infinity/.test(line), `${size}: ${line}`);
    assert.match(line ?? "", /^ctx 279k/);
  }
  // An unknown model with no usable size: just the tokens.
  assert.match(renderStatusLine({ model: { id: "mystery-model" }, context_window: { context_window_size: -5, current_usage: { input_tokens: 1000 } } }) ?? "", /^ctx 1\.0k(?!\/)/);
});

test("the docs pin the GitHub Action at this version", () => {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const f of ["README.md", join("docs", "ci.md")]) {
    const pins = [...readFileSync(join(root, f), "utf8").matchAll(/KushalP1\/context-doctor@v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    assert.ok(pins.length > 0, `${f} pins the Action`);
    for (const p of pins) assert.equal(p, version, `${f} pins v${p}; scripts/sync-versions.mjs sets it on npm version`);
  }
  assert.match(readFileSync(join(root, "scripts", "sync-versions.mjs"), "utf8"), /docs\/ci\.md/);
});

test("install --help names Antigravity", async () => {
  const r = await run(mkdtempSync(join(tmpdir(), "ctxdoc-qa-help-")), ["install", "--help"]);
  assert.match(r.out.replace(/\s+/g, " "), /MCP server \(Claude Desktop, Claude Code, Cursor, Codex, Gemini CLI, GitHub Copilot, Antigravity\), the skill \(Claude Code, Codex, Antigravity\)/);
});

test("the proxy banner gives the Gemini base URL beside Anthropic's and OpenAI's", async () => {
  const port = await freePort();
  const home = mkdtempSync(join(tmpdir(), "ctxdoc-qa-proxy-"));
  const child = spawn(process.execPath, [cliPath, "proxy", "--port", String(port)], { env: sandboxEnv(home) });
  let err = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no banner: ${err}`)), 20_000);
      child.stderr.on("data", (d) => {
        err += d;
        if (err.includes("Cumulative savings")) { clearTimeout(timer); resolve(); }
      });
    });
  } finally {
    child.kill();
  }
  assert.match(err, new RegExp(`export GOOGLE_GEMINI_BASE_URL=http://127\\.0\\.0\\.1:${port}\\n`));
  assert.match(err, /export ANTHROPIC_BASE_URL=/);
  assert.match(err, /export OPENAI_BASE_URL=.*\/v1/);
});
