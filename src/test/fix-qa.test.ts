/**
 * Regression tests from the independent QA pass of B1-B3 (2026-10-28): undo
 * that respects later changes, exact round trips, refusals that change
 * nothing, concurrent runs, where Claude Code reads its settings, and what
 * overrides the value fix writes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyFix, fixRecordPath, planFixes, readFixRecords, renderFixPlan, renderFixShare, undoFixes, type Fix, type FixId } from "../fix.js";
import { claudeDir, claudeJsonPath } from "../claudedir.js";
import { ABSENT, setJsonPath } from "../settingsedit.js";
import { compactWindowOverrides, effectiveCompactWindow, effectiveTtl, managedSettingsPaths, settingsSources, ttlOverrides } from "../effective.js";
import { currentCompactWindow } from "../compactwindow.js";
import { estimateCacheTtl } from "../cachettl.js";
import { sandboxEnv } from "./sandbox.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const fx = (id: FixId, value?: number | string): Fix => ({ id, title: id, basis: "", quality: "", change: id, state: "available", value });

function home(settings?: string): { home: string; file: string } {
  const h = mkdtempSync(join(tmpdir(), "cd-fixqa-"));
  mkdirSync(join(h, ".claude"));
  const file = join(h, ".claude", "settings.json");
  if (settings !== undefined) writeFileSync(file, settings);
  return { home: h, file };
}
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "<absent>");

test("round trips are byte-exact, and apply edits only its key (formatting, CRLF, escapes, 1.0, inline objects)", async () => {
  const samples = [
    '{\n  "permissions": { "allow": ["Bash(ls)", "Read"] },\n  "model": "opus"\n}\n',
    JSON.stringify({ a: 1, env: { X: "1" } }, null, 2),
    JSON.stringify({ a: 1 }, null, "\t") + "\n",
    '{\r\n  "a": 1\r\n}\r\n',
    '{\n  "a": "\\u00e9"\n}',
    '{\n  "x": 1.0\n}',
    '{"a":1}',
    "{}",
    "\uFEFF{\n  \"a\": 1\n}\n",
  ];
  for (const s of samples) {
    for (const [id, v] of [["compact-window", 400000], ["cache-ttl", "1h"], ["tool-search", "auto"]] as const) {
      const { home: h, file } = home(s);
      assert.equal((await applyFix(fx(id, v), { home: h })).ok, true, `${id} on ${JSON.stringify(s)}`);
      const mid = read(file);
      // Only the key changed: the original's other bytes are all still there.
      if (s.includes('"permissions": { "allow"')) assert.ok(mid.includes('"permissions": { "allow": ["Bash(ls)", "Read"] },'), mid);
      if (s.includes("\\u00e9")) assert.ok(mid.includes('"\\u00e9"'), mid);
      if (s.includes("1.0")) assert.ok(mid.includes("1.0"), mid);
      if (s.includes("\r\n")) assert.ok(!/[^\r]\n/.test(mid), JSON.stringify(mid));
      JSON.parse(mid.replace(/^\uFEFF/, ""));
      await undoFixes(undefined, { home: h });
      assert.equal(read(file), s, `${id} round trip of ${JSON.stringify(s)}`);
      assert.ok(!existsSync(fixRecordPath(h)));
    }
  }
  // Key-level edits (the file changed in between) keep formatting too.
  const t = '{\r\n\t"a": [1, 2],\r\n\t"b": "\\u00e9"\r\n}\r\n';
  const set = setJsonPath(t, ["env", "ENABLE_TOOL_SEARCH"], "auto");
  assert.equal(set, '{\r\n\t"a": [1, 2],\r\n\t"b": "\\u00e9",\r\n\t"env": {\r\n\t\t"ENABLE_TOOL_SEARCH": "auto"\r\n\t}\r\n}\r\n');
  assert.equal(setJsonPath(set, ["env"], ABSENT), t);
});

test("undo leaves a value the user changed since; a second apply keeps the first previous value; raw previous values come back", async () => {
  let { home: h, file } = home('{\n  "a": 1\n}');
  await applyFix(fx("cache-ttl", "1h"), { home: h });
  writeFileSync(file, read(file).replace('"1h"', '"5m"'));
  const lines = await undoFixes(undefined, { home: h });
  assert.match(lines.join("\n"), /promptCacheTtl was changed since fix set it \(now "5m"\): left as it is/);
  assert.equal(JSON.parse(read(file)).promptCacheTtl, "5m");

  ({ home: h, file } = home('{\n  "a": 1\n}'));
  await applyFix(fx("compact-window", 400000), { home: h });
  writeFileSync(file, read(file).replace("400000", "600000"));
  await undoFixes(undefined, { home: h });
  assert.equal(JSON.parse(read(file)).autoCompactWindow, 600000);

  // 1h then 5m (a flipped recommendation), then undo: the state before context-doctor.
  ({ home: h, file } = home('{\n  "a": 1\n}'));
  await applyFix(fx("cache-ttl", "1h"), { home: h }, { oneHourShare: 0.7 });
  await applyFix(fx("cache-ttl", "5m"), { home: h }, { oneHourShare: 1 });
  assert.equal(readFixRecords(h)[0].hadPrevious, false);
  assert.equal(readFixRecords(h)[0].oneHourShareBefore, 0.7);
  await undoFixes(undefined, { home: h });
  assert.equal(read(file), '{\n  "a": 1\n}');

  // Values fix would never write ("auto", "30m", null) are put back as they were, also when the file changed in between.
  for (const [key, id, v, raw] of [["autoCompactWindow", "compact-window", 400000, '"auto"'], ["promptCacheTtl", "cache-ttl", "1h", '"30m"'], ["promptCacheTtl", "cache-ttl", "1h", "null"]] as const) {
    ({ home: h, file } = home(`{\n  "${key}": ${raw},\n  "z": 1\n}`));
    await applyFix(fx(id, v), { home: h });
    writeFileSync(file, read(file).replace('"z": 1', '"z": 2'));
    await undoFixes(undefined, { home: h });
    assert.equal(read(file), `{\n  "${key}": ${raw},\n  "z": 2\n}`);
  }
});

test("refusals change nothing: a damaged settings file, a damaged record, a non-object env; the install backup is never touched", async () => {
  for (const bad of ['{ "a": 1, }', '// comment\n{"a":1}', "null", "[]", '"x"']) {
    const { home: h, file } = home(bad);
    const r = await applyFix(fx("cache-ttl", "1h"), { home: h });
    assert.equal(r.ok, false);
    assert.match(r.lines[0], /Nothing was changed/);
    assert.equal(read(file), bad);
    assert.ok(!existsSync(fixRecordPath(h)));
  }
  let { home: h, file } = home('{\n  "env": "oops"\n}');
  assert.equal((await applyFix(fx("tool-search", "auto"), { home: h })).ok, false);
  assert.equal(read(file), '{\n  "env": "oops"\n}');

  ({ home: h, file } = home('{\n  "a": 1\n}'));
  await applyFix(fx("compact-window", 400000), { home: h });
  const rec = fixRecordPath(h);
  const damaged = read(rec).replace(/}\s*$/, "},");
  writeFileSync(rec, damaged);
  const r = await applyFix(fx("cache-ttl", "1h"), { home: h });
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /not valid JSON.*nothing was changed/);
  assert.equal(read(rec), damaged, "the record that lists what undo puts back is never overwritten");
  assert.equal(JSON.parse(read(file)).promptCacheTtl, undefined);
  assert.match((await undoFixes(undefined, { home: h }))[0], /^✗ .*not valid JSON/);
  assert.equal(JSON.parse(read(file)).autoCompactWindow, 400000);

  ({ home: h, file } = home('{\n  "a": 1\n}'));
  writeFileSync(`${file}.context-doctor.backup`, "install's backup");
  await applyFix(fx("cache-ttl", "1h"), { home: h });
  await undoFixes(undefined, { home: h });
  assert.equal(read(`${file}.context-doctor.backup`), "install's backup");
  assert.deepEqual(readdirSync(join(h, ".claude")).sort(), ["settings.json", "settings.json.context-doctor.backup"]);
});

test("a symbolic link stays a link; the write goes to its target", async () => {
  const { home: h, file } = home();
  const target = join(h, "real-settings.json");
  writeFileSync(target, '{\n  "a": 1\n}');
  symlinkSync(target, file);
  await applyFix(fx("cache-ttl", "1h"), { home: h });
  assert.ok(lstatSync(file).isSymbolicLink());
  assert.match(read(target), /promptCacheTtl/);
  await undoFixes(undefined, { home: h });
  assert.ok(lstatSync(file).isSymbolicLink());
  assert.equal(read(target), '{\n  "a": 1\n}');
});

test("concurrent runs: eight processes applying four fixes lose nothing", async () => {
  const { home: h, file } = home('{\n  "a": 1\n}\n');
  const script = join(h, "one.mjs");
  const fixUrl = new URL("../fix.js", import.meta.url).href;
  writeFileSync(script, `const { applyFix } = await import(${JSON.stringify(fixUrl)});\nconst [id, v, go] = process.argv.slice(2);\nwhile (Date.now() < Number(go)) {}\nconst r = await applyFix({ id, title: id, basis: "", quality: "", change: id, state: "available", value: id === "compact-window" ? Number(v) : v }, { home: process.env.HOME });\nif (!r.ok) { console.error(r.lines.join("\\n")); process.exit(1); }\n`);
  const go = Date.now() + 1000;
  const jobs = [["compact-window", "400000"], ["cache-ttl", "1h"], ["cache-ttl-subagents", "5m"], ["tool-search", "auto"]].flatMap((a) => [a, a]);
  const codes = await Promise.all(jobs.map(([id, v]) => new Promise<number>((res) => spawn(process.execPath, [script, id, v, String(go)], { env: sandboxEnv(h), stdio: "ignore" }).on("exit", (c) => res(c ?? 1)))));
  assert.deepEqual(codes, codes.map(() => 0));
  const s = JSON.parse(read(file));
  assert.deepEqual([s.autoCompactWindow, s.promptCacheTtl, s.subagentPromptCacheTtl, s.env?.ENABLE_TOOL_SEARCH], [400000, "1h", "5m", "auto"]);
  assert.deepEqual(readFixRecords(h).map((r) => r.id).sort(), ["cache-ttl", "cache-ttl-subagents", "compact-window", "tool-search"]);
  assert.deepEqual(readdirSync(join(h, ".claude")).sort(), [".context-doctor-fixes.json", "settings.json"], "no lock or temporary file left");
  await undoFixes(undefined, { home: h });
  assert.equal(read(file), '{\n  "a": 1\n}\n');
});

test("CLAUDE_CONFIG_DIR: Claude Code's folder and .claude.json follow it, for the real user only", () => {
  const env = { CLAUDE_CONFIG_DIR: "/tmp/cc-config" };
  assert.equal(claudeDir(undefined, env), resolve("/tmp/cc-config"));
  assert.equal(claudeJsonPath(undefined, env), join(resolve("/tmp/cc-config"), ".claude.json"));
  assert.equal(claudeDir("/elsewhere", env), join("/elsewhere", ".claude"), "an explicit other home is that home's");
  // The CLI end to end: settings go into CLAUDE_CONFIG_DIR, not ~/.claude.
  const { home: h } = home();
  const cfg = join(h, "cfg");
  const r = spawnSync(process.execPath, [cli, "cache-ttl", "1h"], { encoding: "utf8", env: { ...sandboxEnv(h), CLAUDE_CONFIG_DIR: cfg, CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS: "2.1.309" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(read(join(cfg, "settings.json"))).promptCacheTtl, "1h");
  assert.ok(!existsSync(join(h, ".claude", "settings.json")));
});

test("what overrides the value fix writes: project, local and managed settings, per-model windows, environment", () => {
  const { home: h, file } = home('{\n  "autoCompactWindow": 400000,\n  "promptCacheTtl": "1h"\n}');
  const cwd = mkdtempSync(join(tmpdir(), "cd-fixqa-proj-"));
  mkdirSync(join(cwd, ".claude"));
  const managed = join(cwd, "managed.json");
  const env = { CLAUDE_CODE_MANAGED_SETTINGS_PATH: managed } as NodeJS.ProcessEnv;
  let src = settingsSources({ home: h, cwd, env });
  assert.equal(effectiveCompactWindow(src, env).value, 400000);
  assert.equal(effectiveCompactWindow(src, env).fromUser, true);
  assert.deepEqual(compactWindowOverrides(src, env), []);
  assert.equal(currentCompactWindow(h, env, cwd), 400000);

  writeFileSync(join(cwd, ".claude", "settings.local.json"), '{"autoCompactWindow": 600000, "modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 300000}}}');
  writeFileSync(managed, '{"promptCacheTtl": "5m"}');
  src = settingsSources({ home: h, cwd, env });
  assert.equal(effectiveCompactWindow(src, env).value, 600000);
  assert.equal(effectiveCompactWindow(src, env, "claude-opus-5-5").value, 300000);
  assert.equal(currentCompactWindow(h, env, cwd), 600000);
  const cwo = compactWindowOverrides(src, env);
  assert.equal(cwo.length, 2);
  assert.match(cwo.join("\n"), /autoCompactWindow 600000 in .*settings\.local\.json/);
  assert.match(cwo.join("\n"), /per-model autoCompactWindow for claude-opus-5-5/);
  assert.equal(effectiveTtl("main", src, env).value, "5m");
  assert.match(ttlOverrides("main", src, env)[0], /promptCacheTtl "5m" in .*managed\.json/);

  // Environment, from the process or a settings file's env block.
  const env2 = { CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL: "5m", CONTEXT_DOCTOR_NO_MANAGED_SETTINGS: "1" } as NodeJS.ProcessEnv;
  const src2 = settingsSources({ home: h, cwd: h, env: env2 });
  assert.equal(effectiveTtl("main", src2, env2).value, "5m");
  assert.match(ttlOverrides("main", src2, env2)[0], /CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL=5m in the environment/);
  writeFileSync(file, '{\n  "env": {"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "250000"}\n}');
  assert.match(compactWindowOverrides(settingsSources({ home: h, cwd: h, env: env2 }), env2)[0], /CLAUDE_CODE_AUTO_COMPACT_WINDOW=250000 in .*settings\.json env/);
  assert.deepEqual(managedSettingsPaths({ CONTEXT_DOCTOR_NO_MANAGED_SETTINGS: "1" }), []);
});

test("CLI: applying a fix that a project setting overrides says so and exits 1", () => {
  const { home: h, file } = home('{\n  "a": 1\n}');
  const cwd = mkdtempSync(join(tmpdir(), "cd-fixqa-cwd-"));
  mkdirSync(join(cwd, ".claude"));
  writeFileSync(join(cwd, ".claude", "settings.json"), '{"promptCacheTtl": "5m"}');
  const r = spawnSync(process.execPath, [cli, "cache-ttl", "1h"], { encoding: "utf8", cwd, env: { ...sandboxEnv(h), CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS: "2.1.309" } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /⚠ It will not take effect while promptCacheTtl "5m" in .*\.claude[\\/]settings\.json overrides it/);
  assert.equal(JSON.parse(read(file)).promptCacheTtl, "1h");
});

test("CLI: damaged settings give a clean message, not a stack trace; --json --apply applies or fails", () => {
  const now = Date.now();
  const { home: h, file } = home("[]");
  const proj = join(h, ".claude", "projects", "-tmp-p");
  mkdirSync(proj, { recursive: true });
  let n = 0;
  for (const d of [2, 1]) {
    const rows: string[] = [];
    for (let i = 0; i < 12; i++) rows.push(JSON.stringify({ type: "assistant", uuid: `q${n}`, timestamp: new Date(now - d * 864e5 + i * 12e5).toISOString(), message: { id: `mq${n++}`, model: "claude-opus-5-5", content: [], usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 500000, output_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 500000, ephemeral_1h_input_tokens: 0 } } } }));
    writeFileSync(join(proj, `s${d}.jsonl`), rows.join("\n") + "\n");
  }
  const work = mkdtempSync(join(tmpdir(), "cd-fixqa-w-"));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: work, env: { ...sandboxEnv(h), CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS: "2.1.309" }, input: "" });
  let r = run("cache-ttl", "1h");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /holds an array, not a JSON object; fix it first\. Nothing was changed\./);
  assert.ok(!/\n\s+at /.test(r.stderr), r.stderr);
  r = run("fix", "--json", "--apply", "cache-ttl");
  assert.equal(r.status, 1);
  const j = JSON.parse(r.stdout);
  assert.equal(j.applied[0].ok, false);
  assert.match(j.applied[0].lines[0], /Nothing was changed/);
  assert.equal(read(file), "[]");

  writeFileSync(file, '{\n  "a": 1\n}');
  r = run("fix", "--json", "--apply", "all");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).applied.some((a: { id: string; ok: boolean }) => a.id === "cache-ttl" && a.ok));
  assert.equal(JSON.parse(read(file)).promptCacheTtl, "1h");
  r = run("fix", "--json", "--apply", "all"); // nothing left to apply: an error, not a silent no-op
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no fix available to apply/);
});

test("the overlap caveat travels with the plan and the share text; cache-ttl's since is an estimate; subagent replies count once", () => {
  const ttl = { days: 30, main: { transcripts: 3, requests: 100, billedUsd: 1000, at5mUsd: 1200, at1hUsd: 900, oneHourShare: 0.7, keptWarmAt1h: 5, wentColdAt5m: 0, unpriced: 0 }, subagents: { transcripts: 0, requests: 0, billedUsd: 0, at5mUsd: 0, at1hUsd: 0, oneHourShare: 0, keptWarmAt1h: 0, wentColdAt5m: 0, unpriced: 0 } };
  const fixes = planFixes({ days: 30, billedUsd: 1000, compactWindow: { window: 400000, savedUsd: 500, savedShare: 0.5, compactionsPerWeek: 9, nowPerWeek: 3 }, ttl, currentTtl: { overrides: [] }, overrides: { "cache-ttl": ["FORCE_PROMPT_CACHING_5M=1 in the environment"] } });
  const plan = renderFixPlan(30, 1000, fixes, []);
  assert.match(plan, /Do not add them up/);
  assert.match(plan, /⚠ would not take effect: FORCE_PROMPT_CACHING_5M=1/);
  assert.match(renderFixShare(30, 1000, fixes), /do not add them up/);

  // The same subagent reply in two files is billed once.
  const dir = mkdtempSync(join(tmpdir(), "cd-fixqa-sub-"));
  const row = JSON.stringify({ type: "assistant", isSidechain: true, uuid: "x1", timestamp: new Date(Date.now() - 3600e3).toISOString(), message: { id: "msg_same", model: "claude-opus-5-5", content: [], usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 30000, output_tokens: 5 } } });
  writeFileSync(join(dir, "a.jsonl"), row + "\n");
  writeFileSync(join(dir, "b.jsonl"), row.replace('"x1"', '"x2"') + "\n");
  const r = estimateCacheTtl(30, { paths: [], subagentPaths: [join(dir, "a.jsonl"), join(dir, "b.jsonl")] });
  assert.equal(r.subagents.requests, 1);
});
