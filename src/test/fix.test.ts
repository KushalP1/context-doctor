/** fix: one plan from the measurements, applied only with consent, undone exactly, re-measured since. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyFix, compactWindowSavingsSince, fixRecordPath, parseFixIds, planFixes, readFixRecords, renderFixPlan, renderFixShare, savedSince, undoFixes, type FixInputs } from "../fix.js";
import { sandboxEnv } from "./sandbox.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const M = "claude-opus-5-5";
let n = 0;
function reply(atMs: number, read: number, write: number, oneHour: boolean) {
  return JSON.stringify({
    type: "assistant",
    uuid: `fx${n}`,
    timestamp: new Date(atMs).toISOString(),
    message: { id: `msg_fx${n++}`, model: M, content: [{ type: "text", text: "ok" }], usage: { input_tokens: 0, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: oneHour ? 0 : write, ephemeral_1h_input_tokens: oneHour ? write : 0 } } },
  });
}
/** A session that pauses 20 minutes between turns on a 5-minute cache: every turn re-writes 500k. */
function pausingSession(start: number, turns = 12): string[] {
  const rows: string[] = [];
  for (let i = 0; i < turns; i++) rows.push(reply(start + i * 20 * 60_000, 0, 500_000, false));
  return rows;
}
function homeWith(sessions: string[][]): string {
  const home = mkdtempSync(join(tmpdir(), "cd-fix-"));
  const dir = join(home, ".claude", "projects", "-tmp-proj");
  mkdirSync(dir, { recursive: true });
  sessions.forEach((rows, i) => writeFileSync(join(dir, `s${i}.jsonl`), rows.join("\n") + "\n"));
  return home;
}

const base: FixInputs = { days: 30, billedUsd: 1000 };

test("the plan ranks priced fixes by dollars, lists applied ones apart, and leaves out what does not pay", () => {
  const fixes = planFixes({
    ...base,
    compactWindow: { window: 400_000, savedUsd: 500, savedShare: 0.5, compactionsPerWeek: 9, nowPerWeek: 3 },
    ttl: { days: 30, main: { transcripts: 3, requests: 100, billedUsd: 1000, at5mUsd: 1200, at1hUsd: 900, oneHourShare: 0.7, keptWarmAt1h: 5, wentColdAt5m: 0, unpriced: 0 }, subagents: { transcripts: 1, requests: 10, billedUsd: 100, at5mUsd: 100, at1hUsd: 120, oneHourShare: 0, keptWarmAt1h: 0, wentColdAt5m: 0, unpriced: 0 } },
    currentTtl: { overrides: [] },
    autopilot: { on: false, reachableUsd: 0.5, reachableShare: 0.0005, unreachableSessions: 0, sessions: 3 },
    toolSearchOff: "false",
    mcpServers: 2,
  });
  assert.deepEqual(fixes.map((f) => f.id), ["compact-window", "cache-ttl", "tool-search"]);
  assert.equal(fixes[1].value, "1h");
  assert.equal(fixes[1].savedUsd, 100);
  assert.match(fixes[1].quality, /^none/);
  // Applied settings show as applied, not offered again.
  const applied = planFixes({ ...base, compactWindow: { window: 400_000, savedUsd: 0, savedShare: 0, compactionsPerWeek: 9, nowPerWeek: 9, current: 400_000 }, currentTtl: { main: "1h", overrides: [] }, ttl: { days: 30, main: { transcripts: 1, requests: 1, billedUsd: 10, at5mUsd: 12, at1hUsd: 10, oneHourShare: 1, keptWarmAt1h: 0, wentColdAt5m: 0, unpriced: 0 }, subagents: { transcripts: 0, requests: 0, billedUsd: 0, at5mUsd: 0, at1hUsd: 0, oneHourShare: 0, keptWarmAt1h: 0, wentColdAt5m: 0, unpriced: 0 } } });
  assert.deepEqual(applied.map((f) => [f.id, f.state]), [["compact-window", "applied"], ["cache-ttl", "applied"]]);
  // Autopilot that cannot reach any session is said so, not offered.
  const desk = planFixes({ ...base, autopilot: { on: false, reachableUsd: 0, reachableShare: 0, unreachableSessions: 4, sessions: 4 } });
  assert.equal(desk[0].state, "not-here");
  const text = renderFixPlan(30, 1000, fixes, [], undefined, { netUsd: 640, returns: 198, hooked: false });
  assert.match(text, /1\. Compact earlier/);
  assert.match(text, /--apply compact-window,cache-ttl,tool-search/);
  assert.match(text, /\$640 over 198 returns/);
  assert.match(text, /context-doctor install/);
  const share = renderFixShare(30, 1000, fixes);
  assert.ok(!/\/(Users|home|tmp)\//.test(share), "no paths in the share text");
  assert.deepEqual(parseFixIds("all", fixes).ids, ["compact-window", "cache-ttl", "tool-search"]);
  assert.deepEqual(parseFixIds("cache-ttl,nope", fixes), { ids: ["cache-ttl"], unknown: ["nope"] });
});

test("apply then undo leaves settings.json byte for byte as it was; autopilot goes through its own commands", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-fix-rt-"));
  mkdirSync(join(home, ".claude"));
  const settings = join(home, ".claude", "settings.json");
  const original = '{\n  "model": "opus",\n  "env": {\n    "ENABLE_TOOL_SEARCH": "false"\n  }\n}\n';
  writeFileSync(settings, original);
  const fixes = planFixes({
    ...base,
    compactWindow: { window: 400_000, savedUsd: 500, savedShare: 0.5, compactionsPerWeek: 9, nowPerWeek: 3 },
    ttl: { days: 30, main: { transcripts: 3, requests: 100, billedUsd: 1000, at5mUsd: 1200, at1hUsd: 900, oneHourShare: 0.7, keptWarmAt1h: 5, wentColdAt5m: 0, unpriced: 0 }, subagents: { transcripts: 0, requests: 0, billedUsd: 0, at5mUsd: 0, at1hUsd: 0, oneHourShare: 0, keptWarmAt1h: 0, wentColdAt5m: 0, unpriced: 0 } },
    currentTtl: { overrides: [] },
    autopilot: { on: false, reachableUsd: 50, reachableShare: 0.05, unreachableSessions: 0, sessions: 3 },
    toolSearchOff: "false",
    mcpServers: 1,
  });
  let started = 0, stopped = 0;
  const deps = { home, now: 1_000, autopilotOn: async () => { started++; return { ok: true, lines: ["on"] }; }, autopilotOff: async () => { stopped++; return ["off"]; } };
  for (const f of fixes) assert.equal((await applyFix(f, deps, { oneHourShare: 0.7 })).ok, true, f.id);
  const s = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(s.autoCompactWindow, 400_000);
  assert.equal(s.promptCacheTtl, "1h");
  assert.equal(s.env.ENABLE_TOOL_SEARCH, "auto");
  assert.equal(started, 1);
  const records = readFixRecords(home);
  assert.deepEqual(records.map((r) => r.id).sort(), ["autopilot", "cache-ttl", "compact-window", "tool-search"]);
  assert.equal(records.find((r) => r.id === "cache-ttl")!.oneHourShareBefore, 0.7);
  assert.equal(records.find((r) => r.id === "tool-search")!.previous, "false");

  // Undo one by name, then the rest.
  await undoFixes(["cache-ttl"], deps);
  assert.equal(JSON.parse(readFileSync(settings, "utf8")).promptCacheTtl, undefined);
  assert.equal(readFixRecords(home).length, 3);
  const lines = await undoFixes(undefined, deps);
  assert.ok(lines.length >= 3, lines.join("\n"));
  assert.equal(stopped, 1);
  assert.equal(readFileSync(settings, "utf8"), original);
  assert.deepEqual(readFixRecords(home), []);
  assert.match((await undoFixes(undefined, deps))[0], /Nothing applied/);
  // A fix that is not available writes nothing.
  const r = await applyFix({ ...fixes[0], state: "applied", note: "already" }, deps);
  assert.equal(r.ok, false);
  assert.equal(readFileSync(settings, "utf8"), original);
});

test("since: the cache lifetime's saving on the sessions after it was set, and earlier compactions priced", () => {
  const now = Date.now();
  const at = now - 3 * 86_400_000;
  // After the change: the same pauses, now at 1 hour, read instead of re-written.
  const rows: string[] = [reply(at + 60_000, 0, 500_000, true)];
  for (let i = 1; i < 6; i++) rows.push(reply(at + 60_000 + i * 20 * 60_000, 500_000, 1_000, true));
  const dir = mkdtempSync(join(tmpdir(), "cd-fix-since-"));
  const p = join(dir, "s.jsonl");
  writeFileSync(p, rows.join("\n") + "\n");
  const [r] = savedSince([{ id: "cache-ttl", at, value: "1h", oneHourShareBefore: 0 }], { paths: [p], subagentPaths: [] });
  assert.ok(r.savedUsd! > 5, String(r.savedUsd)); // five 500k re-writes avoided, ~$2.4 each, less the dearer first write
  assert.match(r.detail, /6 requests/);
  // Before the change already at 1 hour: nothing saved.
  const [same] = savedSince([{ id: "cache-ttl", at, value: "1h", previous: "1h" }], { paths: [p], subagentPaths: [] });
  assert.ok(Math.abs(same.savedUsd!) < 1e-9);

  // A compaction at 400k on a 1M model: later requests re-read ~330k less until they would have reached ~970k.
  const c = [
    reply(at + 1000, 400_000, 1_000, true),
    JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: new Date(at + 2000).toISOString(), compactMetadata: { trigger: "auto", preTokens: 400_000 } }),
    reply(at + 3000, 0, 70_000, true),
    reply(at + 4000, 70_000, 10_000, true),
    reply(at + 5000, 80_000, 10_000, true),
  ];
  const q = join(dir, "c.jsonl");
  writeFileSync(q, c.join("\n") + "\n");
  const cw = compactWindowSavingsSince(at, undefined, [q]);
  assert.equal(cw.compactions, 1);
  // Two later requests, 330k less each at $0.20/M, less the compaction (400k read + 20k output at $20/M).
  const expected = (2 * 330_000 * 0.2 - 400_000 * 0.2 - 20_000 * 20) / 1e6;
  assert.ok(Math.abs(cw.usd - expected) < 1e-9, `${cw.usd} vs ${expected}`);
  // A manual compaction is the user's, not the window's.
  writeFileSync(q, c.join("\n").replace('"trigger":"auto"', '"trigger":"manual"') + "\n");
  assert.equal(compactWindowSavingsSince(at, undefined, [q]).compactions, 0);
});

test("CLI: a plan from the history; nothing written without --apply; --apply then undo restores; bad ids are errors", () => {
  const now = Date.now();
  const home = homeWith([pausingSession(now - 2 * 86_400_000), pausingSession(now - 86_400_000)]);
  const work = mkdtempSync(join(tmpdir(), "cd-fix-cwd-"));
  const settings = join(home, ".claude", "settings.json");
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, "fix", ...args], { encoding: "utf8", cwd: work, env: { ...sandboxEnv(home), CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS: "2.1.309" }, input: "" });

  let r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Cache lifetime, main conversation: 1 hour/);
  assert.ok(!existsSync(settings), "no prompt and no write when not in a terminal");
  assert.ok(!existsSync(fixRecordPath(home)));

  r = run("--json");
  const j = JSON.parse(r.stdout);
  assert.equal(j.fixes.find((f: any) => f.id === "cache-ttl").value, "1h");

  r = run("--apply", "nope");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown fix nope/);

  r = run("--apply", "cache-ttl");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /✓ ~\/\.claude\/settings\.json: promptCacheTtl = "1h"/);
  assert.equal(JSON.parse(readFileSync(settings, "utf8")).promptCacheTtl, "1h");
  r = run();
  assert.match(r.stdout, /Already applied/);
  assert.ok(!/1\. Cache lifetime, main/.test(r.stdout), r.stdout);

  r = run("undo");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /promptCacheTtl removed/);
  assert.ok(!existsSync(settings), "the settings.json fix created is gone again");
  r = run("bogus");
  assert.notEqual(r.status, 0);
});

test("plugin: /context-doctor:fix applies only named ids, and the manifest's version follows package.json", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const skill = readFileSync(join(root, "plugin", "skills", "fix", "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: fix\n/);
  assert.match(skill, /fix --apply cache-ttl,compact-window/);
  assert.match(skill, /Never pass `--apply all` unless the user asked/);
  const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(plugin.version, pkg.version);
  assert.match(readFileSync(join(root, "scripts", "sync-versions.mjs"), "utf8"), /\.claude-plugin\/plugin\.json/);
});
