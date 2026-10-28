/** cache-ttl: the same requests priced at a 5-minute and a 1-hour prompt cache, and the setting that picks one. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adviseTtl, currentTtl, estimateCacheTtl, renderCacheTtl, setCacheTtl, ttlUnsupported } from "../cachettl.js";
import { sandboxEnv } from "./sandbox.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const M = "claude-opus-5-5"; // $4 input, $0.20 cache read per 1M
const T0 = Date.now() - 2 * 86_400_000;
let n = 0;
function reply(atMs: number, read: number, write: number, oneHour: boolean, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "assistant",
    uuid: `u${n}`,
    timestamp: new Date(atMs).toISOString(),
    message: {
      id: `msg_${n++}`,
      model: M,
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 0, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: oneHour ? 0 : write, ephemeral_1h_input_tokens: oneHour ? write : 0 } },
    },
    ...extra,
  });
}
const min = (m: number) => T0 + m * 60_000;
function file(rows: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cd-ttl-"));
  const p = join(dir, "s.jsonl");
  writeFileSync(p, rows.join("\n") + "\n");
  return p;
}
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test("pauses of 5-60 minutes: a cold 5-minute re-write would have been a read at 1 hour", () => {
  // 100k written, then a 20-minute pause re-writes it all at 5 minutes.
  const p = file([reply(min(0), 0, 1_000_000, false), reply(min(20), 0, 1_000_000, false), reply(min(21), 1_000_000, 10_000, false)]);
  const r = estimateCacheTtl(30, { paths: [p], subagentPaths: [], minRequests: 1 });
  const m = r.main;
  assert.equal(m.requests, 3);
  // As billed: 2.01M written at 1.25x, 1M read.
  close(m.billedUsd, (2_010_000 * 4 * 1.25 + 1_000_000 * 0.2) / 1e6);
  close(m.at5mUsd, m.billedUsd);
  // At 1 hour: the second request reads 1M instead; every write at 2x.
  close(m.at1hUsd, (1_010_000 * 4 * 2 + 2_000_000 * 0.2) / 1e6);
  assert.equal(m.keptWarmAt1h, 1);
  assert.ok(m.at1hUsd < m.billedUsd);
  const a = adviseTtl(m)!;
  assert.equal(a.ttl, "1h");
  close(a.savedUsd, m.billedUsd - m.at1hUsd);
});

test("quick turns: a 1-hour cache only costs more; 5 minutes is advised", () => {
  const rows = [reply(min(0), 0, 500_000, true)];
  for (let i = 1; i <= 10; i++) rows.push(reply(min(i), 500_000 + (i - 1) * 20_000, 20_000, true));
  const r = estimateCacheTtl(30, { paths: [file(rows)], subagentPaths: [], minRequests: 1 });
  close(r.main.at1hUsd, r.main.billedUsd);
  assert.ok(r.main.at5mUsd < r.main.billedUsd);
  assert.equal(adviseTtl(r.main)!.ttl, "5m");
  assert.equal(r.main.wentColdAt5m, 0);
});

test("a 1-hour read after 30 minutes goes cold at 5 minutes; compactions and model switches start over in every arm", () => {
  const p = file([
    reply(min(0), 0, 100_000, true),
    reply(min(30), 100_000, 1_000, true), // warm at 1 h, cold at 5 m
    JSON.stringify({ type: "system", subtype: "compact_boundary" }),
    reply(min(31), 0, 20_000, true), // after a compaction: as billed in every arm (prices aside)
    reply(min(31.5), 0, 21_000, true, { message: undefined }), // no message: ignored
  ]);
  const r = estimateCacheTtl(30, { paths: [p], subagentPaths: [], minRequests: 1 });
  assert.equal(r.main.wentColdAt5m, 1);
  assert.equal(r.main.keptWarmAt1h, 0);
  // At 5 minutes: the 30-minute request writes 101k.
  close(r.main.at5mUsd, ((100_000 + 101_000 + 20_000) * 4 * 1.25) / 1e6);
  close(r.main.at1hUsd, r.main.billedUsd);
});

test("sidechain rows stay out of the main replay; subagent transcripts are replayed apart; small sessions are skipped", () => {
  const main = file([
    reply(min(0), 0, 100_000, true),
    reply(min(1), 0, 100_000, false, { isSidechain: true }),
    reply(min(2), 100_000, 1_000, true),
  ]);
  const sub = file([reply(min(0), 0, 30_000, false, { isSidechain: true }), reply(min(10), 0, 30_000, false, { isSidechain: true })]);
  const r = estimateCacheTtl(30, { paths: [main], subagentPaths: [sub], minRequests: 1 });
  assert.equal(r.main.requests, 2);
  assert.equal(r.subagents.requests, 2);
  assert.equal(r.subagents.transcripts, 1);
  assert.equal(r.subagents.keptWarmAt1h, 1);
  // The default rule (10+ requests) leaves a two-request session out.
  assert.equal(estimateCacheTtl(30, { paths: [main], subagentPaths: [] }).main.transcripts, 0);
});

test("no clear saving: no advice", () => {
  const rows = [reply(min(0), 0, 50_000, true), reply(min(1), 50_000, 100, true)];
  const r = estimateCacheTtl(30, { paths: [file(rows)], subagentPaths: [], minRequests: 1 });
  // 1.25x vs 2x on 50k writes is well over 2%: advice is 5m; a 1-hour arm equal to billed is not advised.
  assert.equal(adviseTtl({ ...r.main, at5mUsd: r.main.billedUsd * 0.99, at1hUsd: r.main.billedUsd }), undefined);
  assert.equal(adviseTtl({ ...r.main, billedUsd: 0 }), undefined);
});

test("setCacheTtl round trip leaves settings.json as it was; currentTtl reads overrides", () => {
  const home = mkdtempSync(join(tmpdir(), "cd-ttl-home-"));
  mkdirSync(join(home, ".claude"));
  const settings = join(home, ".claude", "settings.json");
  const original = '{\n\t"model": "opus",\n\t"env": {\n\t\t"FORCE_PROMPT_CACHING_5M": "1"\n\t}\n}\n';
  writeFileSync(settings, original);
  let r = setCacheTtl("main", "1h", home);
  assert.ok(r.changed && !r.created && r.backup);
  assert.equal(r.previous, undefined);
  assert.equal(JSON.parse(readFileSync(settings, "utf8")).promptCacheTtl, "1h");
  const cur = currentTtl(home, {});
  assert.equal(cur.main, "1h");
  assert.deepEqual(cur.overrides, ["FORCE_PROMPT_CACHING_5M=1 (settings env)"]);
  assert.equal(setCacheTtl("main", "1h", home).changed, false);
  r = setCacheTtl("subagents", "5m", home);
  assert.equal(JSON.parse(readFileSync(settings, "utf8")).subagentPromptCacheTtl, "5m");
  setCacheTtl("subagents", undefined, home);
  setCacheTtl("main", undefined, home);
  assert.equal(readFileSync(settings, "utf8"), original);
  assert.equal(setCacheTtl("main", undefined, home).changed, false);
});

test("older Claude Code is named, not blocked", () => {
  const old = ttlUnsupported([{ path: "/x/claude", version: "2.1.62", source: "cli" }, { path: "/y", version: "2.1.309", source: "desktop app" }]);
  assert.deepEqual(old.map((i) => i.version), ["2.1.62"]);
  const r = estimateCacheTtl(30, { paths: [], subagentPaths: [] });
  const text = renderCacheTtl(r, { overrides: [] }, [{ path: "/x/claude", version: "2.1.62", source: "cli" }]);
  assert.match(text, /2\.1\.62 .*predates the setting/);
  assert.match(text, /No change pays/);
});

test("CLI: cache-ttl 1h / off writes and removes only promptCacheTtl, in a throwaway HOME", () => {
  const home = mkdtempSync(join(tmpdir(), "cd-ttl-cli-"));
  const settings = join(home, ".claude", "settings.json");
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, "cache-ttl", ...args], { encoding: "utf8", env: { ...sandboxEnv(home), CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS: "2.1.309" } });
  let r = run("off");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /was not set/);
  assert.ok(!existsSync(settings));
  r = run("1h");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /promptCacheTtl = "1h" .*\(a new file\)/);
  assert.ok(!/predates/.test(r.stdout));
  r = run("5m", "--subagents");
  assert.match(r.stdout, /subagentPromptCacheTtl = "5m"/);
  assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { promptCacheTtl: "1h", subagentPromptCacheTtl: "5m" });
  r = run("status", "--json");
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.current.main, "1h");
  assert.equal(j.main.requests, 0);
  r = run("2h");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage: context-doctor cache-ttl/);
});

test("doctor: silent without a lifetime set; names the value, an override and an old Claude Code", async () => {
  const { cacheTtlCheck } = await import("../doctor.js");
  const home = mkdtempSync(join(tmpdir(), "cd-ttl-doc-"));
  mkdirSync(join(home, ".claude"));
  const settings = join(home, ".claude", "settings.json");
  const saved = process.env.CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS;
  process.env.CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS = "2.1.309";
  try {
    assert.equal(cacheTtlCheck(home, {}), undefined);
    writeFileSync(settings, JSON.stringify({ promptCacheTtl: "1h" }));
    assert.equal(cacheTtlCheck(home, {})!.status, "ok");
    assert.equal(cacheTtlCheck(home, { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" })!.status, "warn");
    process.env.CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS = "2.1.62";
    assert.match(cacheTtlCheck(home, {})!.detail, /predates the setting/);
  } finally {
    if (saved === undefined) delete process.env.CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS;
    else process.env.CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS = saved;
  }
});
