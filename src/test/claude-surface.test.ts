/**
 * scripts/claude-surface.mjs (ROADMAP E7): what a Claude Code release adds to
 * or removes from its environment variables, settings keys, plugin.json
 * keys, hook events and mod events, against the reviewed list. Driven with a
 * stand-in binary cut to the shapes 2.1.321-2.1.325 hold, no Claude Code needed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "claude-surface.mjs");
const load = async (): Promise<any> => import(pathToFileURL(SCRIPT).href);

/** A stand-in for Claude Code's binary: bytes around the bundled JavaScript, as the real one has. */
function binary(version: string, extra: { setting?: string; env?: string; plugin?: string } = {}): Buffer {
  const js = [
    `function bQ(n={ISSUES_EXPLAINER:"report the issue",PACKAGE_URL:"@anthropic-ai/claude-code",README_URL:"https://code.claude.com/docs/en/overview",VERSION:"${version}",BUILD_TIME:"2026-11-12"})`,
    // settings.json's schema: strings, a template literal and a regular expression holding braces must not end it early.
    `function rd(e){let s=1;return{$schema:()=>o().optional().describe("JSON Schema reference for Claude Code settings"),`,
    `apiKeyHelper:()=>o().optional().describe("Path to a script that outputs } authentication values"),`,
    `hooks:()=>GR(()=>M7()).optional(),"quoted-key":()=>o().optional(),`,
    `promptCacheTtl:()=>B(uAt).optional().catch(void 0).describe(\`TTL: \${s?"}":"{"} "5m" or "1h"\`),`,
    `statusLine:()=>u({type:z("command"),command:o()}).regex(/^[}{]+$/).optional(),`,
    extra.setting ? `${extra.setting}:()=>O().optional(),` : "",
    `env:()=>me(o(),o()).optional()}}`,
    // plugin.json's keys, as lazy reads of the merged schemas' shapes.
    `var Zm={name:()=>Oe().shape.name,displayName:()=>Oe().shape.displayName,hooks:()=>Zi().partial().shape.hooks,${extra.plugin ? `${extra.plugin}:()=>Oe().shape.${extra.plugin},` : ""}skills:()=>ta().partial().shape.skills};`,
    `var fc=["PreToolUse","PostToolUse","UserPromptSubmit","SessionStart","SessionEnd","Stop"],jAa=["clear","resume"];`,
    `var CA=["PreToolUse","UserPromptSubmit","Stop"];`,
    `var lUe=["session.start","session.measure","turn.step","tool.describe",...iBr];`,
    `var qn={"tool.call":(e)=>({deny:e}),"session.measure":void 0,"ui.render":void 0,"ui.scroll":(e)=>({deny:e})};`,
    // Environment variables: read through process.env and an alias, in quoted lists, in prose.
    `let i=process.env;if(i.CLAUDE_CODE_PROMPT_CACHE_TTL!==void 0&&process.env.MAX_THINKING_TOKENS)x=new Set(["ANTHROPIC_BASE_URL","DISABLE_TELEMETRY"]);`,
    `log("set CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES=1 to turn them off");y=env.TSC_WATCHFILE;`,
    extra.env ? `z=i.${extra.env}??"";` : "",
  ].join("\n");
  // The bundled SQLite's compile options sit between NUL bytes: not Claude Code's variables.
  return Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1]), Buffer.from("\u0000ENABLE_FTS5\u0000ENABLE_RTREE\u0000"), Buffer.from(js), Buffer.from([0, 0xff, 0xfe])]);
}

test("the surface of a binary: version, environment variables, settings, plugin.json keys, hook and mod events", async () => {
  const { surfaceOf } = await load();
  const s = surfaceOf(binary("2.1.321").toString("latin1"));
  assert.equal(s.version, "2.1.321");
  assert.deepEqual(s.settings, ["$schema", "apiKeyHelper", "env", "hooks", "promptCacheTtl", "quoted-key", "statusLine"]);
  assert.deepEqual(s.plugin, ["displayName", "hooks", "name", "skills"]);
  // The longest list naming PreToolUse, SessionStart and UserPromptSubmit; CA (no SessionStart) adds nothing.
  assert.deepEqual(s.hooks, ["PostToolUse", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
  assert.deepEqual(s.mods, ["session.measure", "session.start", "tool.call", "tool.describe", "turn.step", "ui.render", "ui.scroll"]);
  assert.deepEqual(s.env, ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES", "CLAUDE_CODE_PROMPT_CACHE_TTL", "DISABLE_TELEMETRY", "MAX_THINKING_TOKENS"]);
});

test("the diff: new and removed names per kind; the CHANGELOG's Added/Removed entries since the reviewed version, marked new or already there", async () => {
  const { surfaceOf, diffSurfaces, changelogMentions, formatReport } = await load();
  const before = surfaceOf(binary("2.1.321").toString("latin1"));
  const after = surfaceOf(binary("2.1.323", { setting: "precomputeArmTokens", env: "CLAUDE_CODE_RESUME_HINT_COMMAND", plugin: "engines" }).toString("latin1"));
  const diff = diffSurfaces(before, after);
  assert.deepEqual(diff.settings, { added: ["precomputeArmTokens"], removed: [] });
  assert.deepEqual(diff.plugin, { added: ["engines"], removed: [] });
  assert.deepEqual(diff.env, { added: ["CLAUDE_CODE_RESUME_HINT_COMMAND"], removed: [] });
  assert.deepEqual(diffSurfaces(after, before).plugin, { added: [], removed: ["engines"] });
  const changelog = [
    "# Changelog", "",
    "## 2.1.324", "", "- Added `CLAUDE_CODE_NEXT` (not in this binary: not listed)", "",
    "## 2.1.323", "",
    "- Added `engines[\"claude-code\"]` to `plugin.json`: plugins outside their stated Claude Code version range are not loaded",
    "- Added `CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES` (available since 2.1.318): set it to `1` to turn off subagent progress summaries",
    "- Fixed Bash deny rules missing commands run through `env` (a fix, not news about `env`)",
    "- Remote Control: Removed the `statusLine` thing",
    "",
    "## 2.1.321", "", "- Added `apiKeyHelper` (before the reviewed version: not listed)",
  ].join("\n");
  const mentions = changelogMentions(changelog, "2.1.321", "2.1.323", after);
  assert.deepEqual(mentions.map((m: any) => [m.version, m.kind, m.name]), [
    ["2.1.323", "plugin", "engines"],
    ["2.1.323", "env", "CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES"],
    ["2.1.323", "settings", "statusLine"],
  ]);
  const text = formatReport({ reviewed: before, now: after, diff, mentions }, false);
  assert.match(text, /^== Claude Code's surface: 2\.1\.323 against the reviewed 2\.1\.321$/m);
  assert.match(text, /^settings\.json keys: 1 new, 0 removed \(8\)\n {4}\+ precomputeArmTokens$/m);
  assert.match(text, /^hook events: no change \(6\)$/m);
  assert.match(text, /2\.1\.323 CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES \(environment variables, already in the reviewed binary\): Added/);
  assert.match(text, /2\.1\.323 engines \(plugin\.json keys, new in this binary\)/);
  const md = formatReport({ reviewed: before, now: after, diff, mentions }, true);
  assert.match(md, /^### Claude Code's surface/m);
  assert.match(md, /^ {2}- new: `engines`$/m);
  assert.match(formatReport({ reviewed: before, now: before, diff: diffSurfaces(before, before), mentions: [] }, false), /Nothing new to review\./);
});

test("the command: --write makes the reviewed list; a newer binary reports, exit 0, also to a job summary; an unreadable binary or one with no surfaces is exit 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-surface-"));
  try {
    const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    const old = join(dir, "claude-2.1.321");
    const fresh = join(dir, "claude-2.1.323");
    const reviewed = join(dir, "reviewed.json");
    const summary = join(dir, "summary.md");
    const log = join(dir, "CHANGELOG.md");
    writeFileSync(old, binary("2.1.321"));
    writeFileSync(fresh, binary("2.1.323", { plugin: "engines" }));
    writeFileSync(log, "## 2.1.323\n\n- Added `engines` to plugin.json\n");
    const w = run("--claude", old, "--reviewed", reviewed, "--write");
    assert.equal(w.status, 0, w.stdout + w.stderr);
    assert.equal(JSON.parse(readFileSync(reviewed, "utf8")).version, "2.1.321");
    const r = run("--claude", fresh, "--reviewed", reviewed, "--changelog", log, "--summary", summary);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /plugin\.json keys: 1 new, 0 removed \(5\)\n {4}\+ engines/);
    assert.match(r.stdout, /2\.1\.323 engines \(plugin\.json keys, new in this binary\)/);
    assert.match(readFileSync(summary, "utf8"), /new: `engines`/);
    const j = run("--claude", fresh, "--reviewed", reviewed, "--json");
    assert.deepEqual(JSON.parse(j.stdout).diff.plugin, { added: ["engines"], removed: [] });
    // A CHANGELOG that cannot be read: the binary's diff alone, with a warning.
    const noLog = run("--claude", fresh, "--reviewed", reviewed, "--changelog", "http://127.0.0.1:1/CHANGELOG.md");
    assert.equal(noLog.status, 0);
    assert.match(noLog.stdout, /^::warning title=claude-surface::/m);
    // A binary whose shapes the extractors no longer find: exit 2, naming what is missing, not "everything removed".
    const odd = join(dir, "odd");
    writeFileSync(odd, "PACKAGE_URL:\"@anthropic-ai/claude-code\",VERSION:\"9.9.9\" CLAUDE_CODE_X ");
    const e = run("--claude", odd, "--reviewed", reviewed);
    assert.equal(e.status, 2);
    assert.match(e.stderr, /found no settings\.json keys, plugin\.json keys, hook events, mod events in it/);
    assert.equal(run("--claude", join(dir, "missing"), "--reviewed", reviewed).status, 2);
    assert.equal(run("--claude", fresh, "--reviewed", join(dir, "none.json")).status, 2);
    assert.equal(run("--nope").status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("docs/hosts-reviewed.json: a version and every list, sorted, none empty", () => {
  const r = JSON.parse(readFileSync(join(ROOT, "docs", "hosts-reviewed.json"), "utf8"));
  assert.match(r.version, /^\d+\.\d+\.\d+$/);
  for (const k of ["env", "settings", "plugin", "hooks", "mods"]) {
    assert.ok(r[k].length > 0, k);
    assert.deepEqual(r[k], [...r[k]].sort(), `${k} sorted`);
  }
  assert.ok(r.hooks.includes("PreModelSwitch") && r.mods.includes("session.measure") && r.settings.includes("promptCacheTtl") && r.plugin.includes("engines"));
});
