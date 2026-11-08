/**
 * `spend`: one bill across Claude Code, Codex, Gemini CLI and Cursor, on
 * synthetic histories in a throwaway home. Claude Code's figures must equal
 * the reports that price the same requests (`limits`' usage, `savings`'
 * input bill); each other tool is priced by hand; Cursor's replies are kept
 * per chat until the chat changes. And the CLI's output on a fixture with
 * every tool, against src/test/golden/spend.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { claudeSpend, codexSpend, cursorSpend, geminiSpend, projectFromDir, projectName, renderSpend, renderSpendShare, spendReport, summarizeSpend } from "../spend.js";
import { claudeUsage, codexLimitData } from "../limits.js";
import { estimateSavings } from "../savings.js";
import { clearScanMemo } from "../scan.js";
import { buildHistory, FIXTURE_NOW } from "./history-fixture.js";
import { writeModifierSession } from "./modifier-fixture.js";
import { runReport } from "./golden-run.js";
import { withSandboxHome } from "./sandbox.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "cli.js");
const DAY = 86_400_000;
const close = (a: number, b: number, msg: string) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

/** Run `fn` with the clock at `now`, a throwaway cache and an empty run memo. */
async function at<T>(now: number, cache: string, fn: () => T | Promise<T>): Promise<T> {
  const real = Date.now;
  const saved = process.env.CONTEXT_DOCTOR_CACHE_DIR;
  Date.now = () => now;
  process.env.CONTEXT_DOCTOR_CACHE_DIR = cache;
  clearScanMemo();
  try {
    return await fn();
  } finally {
    Date.now = real;
    if (saved === undefined) delete process.env.CONTEXT_DOCTOR_CACHE_DIR;
    else process.env.CONTEXT_DOCTOR_CACHE_DIR = saved;
    clearScanMemo();
  }
}

const iso = (t: number) => new Date(t).toISOString();

/** A Codex rollout: two requests, one limits-only refresh between them, in /Users/me/tech/app. */
function writeCodex(home: string, now: number): string {
  const dir = join(home, ".codex", "sessions", "2026", "09", "28");
  mkdirSync(dir, { recursive: true });
  const t = now - 3 * DAY;
  const tc = (dt: number, total: number, last: Record<string, number>) => ({ timestamp: iso(t + dt), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: total }, last_token_usage: last }, rate_limits: null } });
  const rows = [
    { timestamp: iso(t), type: "session_meta", payload: { id: "x", cwd: "/Users/me/tech/app", base_instructions: { text: "You are Codex." } } },
    { timestamp: iso(t + 10), type: "turn_context", payload: { cwd: "/Users/me/tech/app", model: "gpt-5.5" } },
    tc(1_000, 1_100, { input_tokens: 1_000, cached_input_tokens: 600, output_tokens: 100, total_tokens: 1_100 }),
    tc(1_500, 1_100, { input_tokens: 1_000, cached_input_tokens: 600, output_tokens: 100, total_tokens: 1_100 }),
    tc(9_000, 2_300, { input_tokens: 1_100, cached_input_tokens: 900, output_tokens: 100, total_tokens: 1_200 }),
  ];
  const path = join(dir, "rollout-2026-09-28T10-00-00-abc.jsonl");
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  utimesSync(path, (t + 9_000) / 1000, (t + 9_000) / 1000);
  return path;
}
/** By hand, at gpt-5.5's $5 / $0.50 / $30: 400 uncached + 600 read + 100 out, then 200 + 900 + 100. */
const CODEX_USD = (400 * 5 + 600 * 0.5 + 100 * 30 + 200 * 5 + 900 * 0.5 + 100 * 30) / 1e6;

/** A Gemini CLI chat (a message written twice, one later rewound: still billed) and an older whole-document chat. */
function writeGemini(home: string, now: number): void {
  const dir = join(home, ".gemini", "tmp", "site", "chats");
  mkdirSync(dir, { recursive: true });
  const t = now - 2 * DAY;
  const rows = [
    { sessionId: "g", projectHash: "p", startTime: iso(t), kind: "main" },
    { id: "u1", timestamp: iso(t + 1_000), type: "user", content: "hi" },
    { id: "g1", timestamp: iso(t + 5_000), type: "gemini", content: "", model: "gemini-3-pro" },
    { id: "g1", timestamp: iso(t + 5_000), type: "gemini", content: "done", model: "gemini-3-pro", tokens: { input: 31_000, output: 40, cached: 20_000, thoughts: 10 } },
    { id: "g2", timestamp: iso(t + 9_000), type: "gemini", content: "more", model: "gemini-3-pro", tokens: { input: 40_000, output: 50, cached: 30_000 } },
    { $rewindTo: "g2" },
  ];
  const path = join(dir, "session-2026-09-29T10-00-g.jsonl");
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  utimesSync(path, (t + 9_000) / 1000, (t + 9_000) / 1000);
  const legacy = join(dir, "session-2026-09-29T09-00-old.json");
  writeFileSync(legacy, JSON.stringify({ sessionId: "o", projectHash: "p", messages: [{ id: "1", type: "user", content: "x", timestamp: iso(t - 1_000) }, { id: "2", type: "gemini", model: "gemini-3-pro", content: "y", timestamp: iso(t - 500), tokens: { input: 1_000, output: 10 } }] }, null, 2));
  utimesSync(legacy, t / 1000, t / 1000);
}
/** gemini-3-pro, $2 / $0.20 / $12: thoughts bill as output; the legacy chat's 1,000 uncached and 10 out. */
const GEMINI_USD = (11_000 * 2 + 20_000 * 0.2 + 50 * 12 + 10_000 * 2 + 30_000 * 0.2 + 50 * 12 + 1_000 * 2 + 10 * 12) / 1e6;

test("Claude Code's spend equals limits' usage, and its main conversation's input equals savings' bill", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-spend-claude-"));
  const cache = mkdtempSync(join(tmpdir(), "cd-spend-cache-"));
  try {
    buildHistory(home);
    await withSandboxHome(home, () => at(FIXTURE_NOW, cache, () => {
      const since = FIXTURE_NOW - 30 * DAY;
      const items = claudeSpend(since, FIXTURE_NOW);
      assert.ok(items.length > 200, `${items.length} requests`);
      const total = items.reduce((n, i) => n + i.usd, 0);
      close(total, claudeUsage(since, FIXTURE_NOW).reduce((n, p) => n + p.usd, 0), "every request, subagents included: limits' usage");
      assert.ok(items.some((i) => i.subagent) && items.some((i) => !i.subagent), "both the main threads and the subagents");
      // The fork's copy of s1 is counted once.
      const keys = items.filter((i) => i.key).map((i) => i.key);
      assert.equal(new Set(keys).size, keys.length, "no reply twice");
      // savings: the main conversation's input (output not), in sessions with 10+ requests.
      const s = estimateSavings(30, {}, undefined, undefined, false);
      const kept = new Set(s.sessions.map((x) => x.path.replace(/^.*[\\/]/, "").replace(/\.jsonl$/, "")));
      const input = items.filter((i) => !i.subagent && !i.workflow && kept.has(i.session)).reduce((n, i) => n + i.inputUsd + i.writeUsd + i.readUsd, 0);
      assert.ok(s.billedUsd > 0);
      close(input, s.billedUsd, "savings' input bill");
      // The parts add up to the whole.
      const r = summarizeSpend(items, 30, since, FIXTURE_NOW);
      close(r.parts.inputUsd + r.parts.writeUsd + r.parts.readUsd + r.parts.outputUsd, r.usd, "the parts");
      close(r.daily.reduce((n, d) => n + d.usd, 0), r.usd, "the days");
      close(r.projects.reduce((n, p) => n + p.usd, 0), r.usd, "the projects");
      assert.equal(r.daily.length, 31, "every day of the window, the empty ones too");
    }));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

test("Codex: a request each time the running total moves, priced as limits prices it, in its folder's project", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-spend-codex-"));
  const cache = mkdtempSync(join(tmpdir(), "cd-spend-cache-"));
  try {
    writeCodex(home, FIXTURE_NOW);
    await at(FIXTURE_NOW, cache, () => {
      const since = FIXTURE_NOW - 30 * DAY;
      const items = codexSpend(since, FIXTURE_NOW, home);
      assert.equal(items.length, 2, "the limits-only refresh is not a request");
      close(items.reduce((n, i) => n + i.usd, 0), CODEX_USD, "priced by hand");
      close(items.reduce((n, i) => n + i.usd, 0), codexLimitData(since, join(home, ".codex", "sessions")).usage.reduce((n, p) => n + p.usd, 0), "limits' Codex usage");
      assert.deepEqual([...new Set(items.map((i) => [i.project, i.model].join(" ")))], ["tech-app gpt-5.5"]);
      // Archived rollouts were billed too.
      mkdirSync(join(home, ".codex", "archived_sessions"), { recursive: true });
      const src = readFileSync(join(home, ".codex", "sessions", "2026", "09", "28", "rollout-2026-09-28T10-00-00-abc.jsonl"), "utf8");
      // Another session's (its running totals its own: a byte-for-byte copy would be the same requests, counted once).
      writeFileSync(join(home, ".codex", "archived_sessions", "rollout-2026-09-27T10-00-00-def.jsonl"), src.replace(/"total_token_usage":\{"total_tokens":(\d+)\}/g, (_m, n) => `"total_token_usage":{"total_tokens":${Number(n) + 5}}`));
      assert.equal(codexSpend(since, FIXTURE_NOW, home).length, 4);
      assert.equal(codexSpend(FIXTURE_NOW - DAY, FIXTURE_NOW, home).filter((i) => i.ts < FIXTURE_NOW - DAY).length, 0, "the window holds");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

test("Gemini CLI: each message once, its last copy; a rewound one still billed; thoughts as output; the older format too", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-spend-gemini-"));
  const cache = mkdtempSync(join(tmpdir(), "cd-spend-cache-"));
  try {
    writeGemini(home, FIXTURE_NOW);
    await at(FIXTURE_NOW, cache, () => {
      const items = geminiSpend(FIXTURE_NOW - 30 * DAY, FIXTURE_NOW, home);
      assert.equal(items.length, 3);
      close(items.reduce((n, i) => n + i.usd, 0), GEMINI_USD, "priced by hand");
      assert.ok(items.every((i) => i.project === "site" && i.model === "gemini-3-pro"));
      // Warm: the same from the cache.
      clearScanMemo();
      close(geminiSpend(FIXTURE_NOW - 30 * DAY, FIXTURE_NOW, home).reduce((n, i) => n + i.usd, 0), GEMINI_USD, "warm");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

const require = createRequire(import.meta.url);
let DatabaseSync: (new (p: string, o?: unknown) => any) | undefined;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = undefined;
}

/** Cursor's per-user folder under `home`, as cursor.ts finds it on this platform. */
function cursorUser(home: string): string {
  return process.platform === "darwin" ? join(home, "Library", "Application Support", "Cursor", "User")
    : process.platform === "win32" ? join(home, "AppData", "Roaming", "Cursor", "User")
      : join(home, ".config", "Cursor", "User");
}

test("Cursor: each reply's tokenCount, an estimate at the chat's model, Auto counted but not priced, kept per chat until it changes", { skip: DatabaseSync ? false : "no node:sqlite on this runtime" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-spend-cursor-"));
  const cache = mkdtempSync(join(tmpdir(), "cd-spend-cache-"));
  try {
    const user = cursorUser(home);
    mkdirSync(join(user, "globalStorage"), { recursive: true });
    const dbPath = join(user, "globalStorage", "state.vscdb");
    const db = new DatabaseSync!(dbPath);
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    const put = (k: string, v: unknown) => db.prepare("INSERT OR REPLACE INTO cursorDiskKV VALUES (?, ?)").run(k, typeof v === "string" ? v : JSON.stringify(v));
    const t = FIXTURE_NOW - 5 * DAY;
    put("composerData:c1", { composerId: "c1", lastUpdatedAt: t + 60_000, createdAt: t, modelConfig: { modelName: "claude-4.5-sonnet" } });
    put("bubbleId:c1:b1", { type: 2, tokenCount: { inputTokens: 10_000, outputTokens: 500 }, createdAt: iso(t + 1_000) });
    put("bubbleId:c1:b2", { type: 1, text: "a question", tokenCount: { inputTokens: 0, outputTokens: 0 } });
    put("bubbleId:c1:b3", { type: 2, tokenCount: { inputTokens: 2_000, outputTokens: 100 }, timingInfo: { clientStartTime: t + 2_000 } });
    put("composerData:c2", { composerId: "c2", lastUpdatedAt: t, modelConfig: { modelName: "default" } });
    put("bubbleId:c2:b1", { type: 2, tokenCount: { inputTokens: 50_000, outputTokens: 1_000 } });
    put("composerData:c3", { composerId: "c3", lastUpdatedAt: FIXTURE_NOW - 90 * DAY, modelConfig: { modelName: "gpt-5" } });
    put("bubbleId:c3:b1", { type: 2, tokenCount: { inputTokens: 9_000, outputTokens: 9 } });
    put("composerData:bad", "not json");
    db.close();
    mkdirSync(join(user, "workspaceStorage", "ws1"), { recursive: true });
    writeFileSync(join(user, "workspaceStorage", "ws1", "workspace.json"), JSON.stringify({ folder: "file:///Users/me/tech/site" }));
    const ws = new DatabaseSync!(join(user, "workspaceStorage", "ws1", "state.vscdb"));
    ws.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    ws.prepare("INSERT INTO ItemTable VALUES (?, ?)").run("composer.composerData", JSON.stringify({ allComposers: [{ composerId: "c1" }] }));
    ws.close();

    await withSandboxHome(home, () => at(FIXTURE_NOW, cache, () => {
      const since = FIXTURE_NOW - 30 * DAY;
      const items = cursorSpend(since, FIXTURE_NOW);
      assert.equal(items.length, 3, "c3 is older than the window; b2 has no tokens");
      // claude-4.5-sonnet at $3 / $15, every input token uncached.
      const c1 = items.filter((i) => i.session === "c1");
      close(c1.reduce((n, i) => n + i.usd, 0), (12_000 * 3 + 600 * 15) / 1e6, "c1 priced at its model");
      assert.ok(c1.every((i) => i.project === "tech-site"), "its workspace folder");
      const auto = items.find((i) => i.session === "c2")!;
      assert.equal(auto.priced, false, "Auto has no list price");
      assert.equal(auto.ts, t, "a reply without a time takes its chat's");
      const r = summarizeSpend(items, 30, since, FIXTURE_NOW);
      assert.equal(r.tools[0].estimate, true);
      assert.equal(r.tools[0].unpriced, 1);
      const text = renderSpend(r);
      assert.match(text, /estimate, no cache split/);
      assert.match(text, /on Auto, which Cursor bills from your plan/);

      // Kept: a reply removed while the chat's lastUpdatedAt stands is still there (nothing re-read)...
      const db2 = new DatabaseSync!(dbPath);
      db2.prepare("DELETE FROM cursorDiskKV WHERE key = 'bubbleId:c1:b3'").run();
      db2.close();
      assert.equal(cursorSpend(since, FIXTURE_NOW).length, 3, "from the kept record");
      // ...and a chat that changed is read again.
      const db3 = new DatabaseSync!(dbPath);
      db3.prepare("UPDATE cursorDiskKV SET value = ? WHERE key = 'composerData:c1'").run(JSON.stringify({ composerId: "c1", lastUpdatedAt: t + 120_000, modelConfig: { modelName: "claude-4.5-sonnet" } }));
      db3.close();
      assert.equal(cursorSpend(since, FIXTURE_NOW).length, 2, "re-read after the chat changed");
    }));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

test("Codex: a forked rollout's copy of its parent's requests counts once, in spend, limits and the budget", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-spend-codexfork-"));
  const cache = mkdtempSync(join(tmpdir(), "cd-spend-cache-"));
  try {
    const dir = join(home, ".codex", "sessions", "2026", "09", "28");
    mkdirSync(dir, { recursive: true });
    const t = FIXTURE_NOW - 3 * DAY;
    // Two requests in the parent; the fork (a subagent's, as Codex Desktop writes it) starts with a copy of
    // both, stamped at the fork's own time, then makes one request of its own, its running total carried on.
    const tc = (at: number, total: Record<string, number>, last: Record<string, number>) => ({ timestamp: iso(at), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last }, rate_limits: { primary: { used_percent: 10, window_minutes: 300 } } } });
    const r1 = tc(t + 1_000, { input_tokens: 1_000, output_tokens: 100, total_tokens: 1_100 }, { input_tokens: 1_000, output_tokens: 100, total_tokens: 1_100 });
    const r2 = tc(t + 9_000, { input_tokens: 2_100, output_tokens: 200, total_tokens: 2_300 }, { input_tokens: 1_100, output_tokens: 100, total_tokens: 1_200 });
    const meta = (id: string, at: number, extra = {}) => ({ timestamp: iso(at), type: "session_meta", payload: { id, cwd: "/Users/me/tech/app", ...extra } });
    const ctx = (at: number) => ({ timestamp: iso(at), type: "turn_context", payload: { cwd: "/Users/me/tech/app", model: "gpt-5.5" } });
    const write = (name: string, rows: unknown[]) => writeFileSync(join(dir, name), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    write("rollout-2026-09-28T10-00-00-parent.jsonl", [meta("parent", t), ctx(t + 10), r1, r2]);
    const f = t + 60_000;
    const restamp = (r: { timestamp: string }) => ({ ...r, timestamp: iso(f + 2) });
    write("rollout-2026-09-28T10-01-00-fork.jsonl", [
      meta("fork", f, { forked_from_id: "parent" }), meta("parent", f + 1), restamp(ctx(t + 10)), restamp(r1), restamp(r2),
      ctx(f + 5_000), tc(f + 20_000, { input_tokens: 3_100, output_tokens: 300, total_tokens: 3_500 }, { input_tokens: 1_000, output_tokens: 100, total_tokens: 1_100 }),
    ]);
    await withSandboxHome(home, () => at(FIXTURE_NOW, cache, () => {
      const since = FIXTURE_NOW - 30 * DAY;
      const items = codexSpend(since, FIXTURE_NOW, home);
      assert.equal(items.length, 3, "two of the parent's, one of the fork's: the copies not again");
      assert.deepEqual(items.map((i) => i.ts), [t + 1_000, t + 9_000, f + 20_000], "at the parent's own times");
      // Three distinct requests of 1,000 + 1,100 + 1,000 uncached in, 100 out each, at gpt-5.5's $5 / $30.
      close(items.reduce((n, i) => n + i.usd, 0), (3_100 * 5 + 300 * 30) / 1e6, "priced once");
      const lim = codexLimitData(since, join(home, ".codex", "sessions"));
      assert.equal(lim.usage.length, 3, "limits' usage fit counts them once too");
      assert.ok(!lim.readings.some((r) => r.ts === f + 2), "the copies' stale limit readings are not readings at the fork's time");
    }));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

test("a model with no list price: counted, its tokens shown, 'not priced' rather than a $0.00 that looks free, and --share says it is left out", () => {
  const base = { project: "app", session: "s", read: 0, write: 0, output: 0, inputUsd: 0, writeUsd: 0, readUsd: 0, outputUsd: 0 };
  const items = [
    { ...base, tool: "claude" as const, ts: FIXTURE_NOW - DAY, model: "claude-sonnet-5", input: 100_000, usd: 0.2, inputUsd: 0.2, priced: true },
    { ...base, tool: "codex" as const, ts: FIXTURE_NOW - DAY, model: "gpt-7", input: 80_000, usd: 0, priced: false },
  ];
  const r = summarizeSpend(items, 30, FIXTURE_NOW - 30 * DAY, FIXTURE_NOW);
  const text = renderSpend(r);
  assert.match(text, /^Codex +\$0\.00  1 requests +1 not priced$/m);
  assert.match(text, /^  gpt-7 +\$0\.00 +0%  not priced, 1 request$/m);
  assert.match(text, /1 Codex requests \(80k tokens\) not priced:\n  no list price for gpt-7\./);
  assert.match(renderSpendShare(r), /\nNot in it: 1 request \(80k tokens\) on models with no list price\.\n/);
});

test("Cursor's names for Claude are priced as the Claude version they stand for, not its family", { skip: DatabaseSync ? false : "no node:sqlite on this runtime" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-spend-cursor-names-"));
  const cache = mkdtempSync(join(tmpdir(), "cd-spend-cache-"));
  try {
    const user = cursorUser(home);
    mkdirSync(join(user, "globalStorage"), { recursive: true });
    const db = new DatabaseSync!(join(user, "globalStorage", "state.vscdb"));
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    const put = (k: string, v: unknown) => db.prepare("INSERT OR REPLACE INTO cursorDiskKV VALUES (?, ?)").run(k, JSON.stringify(v));
    const t = FIXTURE_NOW - DAY;
    // Opus 4.1 is $15 / $75; the Opus family row, $5 / $25.
    put("composerData:c1", { composerId: "c1", lastUpdatedAt: t, modelConfig: { modelName: "claude-4.1-opus-high-thinking" } });
    put("bubbleId:c1:b1", { type: 2, tokenCount: { inputTokens: 1_000_000, outputTokens: 0 }, createdAt: iso(t) });
    // An id Cursor would invent for a model the table has no row for: the family's price, said to be an estimate.
    put("composerData:c2", { composerId: "c2", lastUpdatedAt: t, modelConfig: { modelName: "claude-9-opus" } });
    put("bubbleId:c2:b1", { type: 2, tokenCount: { inputTokens: 1_000_000, outputTokens: 0 }, createdAt: iso(t) });
    db.close();
    await withSandboxHome(home, () => at(FIXTURE_NOW, cache, () => {
      const items = cursorSpend(FIXTURE_NOW - 30 * DAY, FIXTURE_NOW);
      const c1 = items.find((i) => i.session === "c1")!, c2 = items.find((i) => i.session === "c2")!;
      assert.equal(c1.model, "claude-4.1-opus-high-thinking", "shown as Cursor names it");
      close(c1.usd, 15, "Opus 4.1's own price");
      assert.equal(c1.estimated, undefined);
      close(c2.usd, 5, "the Opus family's price");
      assert.equal(c2.estimated, true);
    }));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

test("a model priced only by its family is an estimate, said so; a <synthetic> reply is no request at all", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-spend-family-"));
  const cache = mkdtempSync(join(tmpdir(), "cd-spend-family-cache-"));
  try {
    const t = FIXTURE_NOW - DAY;
    const row = (id: string, model: string, input: number) => JSON.stringify({ type: "assistant", uuid: `u-${id}`, timestamp: iso(t), message: { id, model, role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: input, output_tokens: 0 } } });
    const file = join(home, ".claude", "projects", "-work-app", "s1.jsonl");
    mkdirSync(dirname(file), { recursive: true });
    // Opus 5.5 by name ($4 in); "claude-opus-9" known only as Opus ($5 in, the family row); an interruption Claude Code wrote itself.
    writeFileSync(file, [row("a", "claude-opus-5-5", 1_000_000), row("b", "claude-opus-9", 1_000_000), row("c", "<synthetic>", 1_000_000)].join("\n") + "\n");
    await withSandboxHome(home, () => at(FIXTURE_NOW, cache, () => {
      const items = claudeSpend(t - DAY, Infinity, [file]);
      assert.deepEqual(items.map((i) => [i.model, i.usd, i.estimated ?? false]), [["claude-opus-5-5", 4, false], ["claude-opus-9", 5, true]], "<synthetic> is not a request, priced or not");
      const r = summarizeSpend(items, 30, FIXTURE_NOW - 30 * DAY, FIXTURE_NOW);
      assert.deepEqual(r.tools[0].estimated, { requests: 1, usd: 5, models: ["claude-opus-9"] });
      assert.equal(r.tools[0].unpriced, 0);
      const text = renderSpend(r);
      assert.match(text, /^  claude-opus-9 +\$5\.00 +56%  estimate: its family's price$/m);
      assert.match(text, /\n1 Claude Code request \(\$5\.00\) priced as its model's family, an estimate:\n  no list price of its own for claude-opus-9\.\n/);
      assert.doesNotMatch(text, /synthetic|not priced/);
      assert.match(renderSpendShare(r), /\nOf it, \$5\.00 is on models priced as their family, an estimate\.\n/);
      // limits' usage fit leaves it out too.
      assert.equal(claudeUsage(t - DAY, Infinity, [file]).length, 2);
    }));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

test("project names less the home folder on macOS, Linux and Windows", () => {
  assert.equal(projectFromDir("-Users-kp-tech-app"), "tech-app");
  assert.equal(projectFromDir("-home-kp-tech-app"), "tech-app");
  assert.equal(projectFromDir("-root-app"), "app");
  assert.equal(projectFromDir("C--Users-kp-tech-app"), "tech-app");
  assert.equal(projectFromDir("-srv-app"), "srv-app");
  assert.equal(projectName("/home/kp/tech/app"), "tech-app");
  assert.equal(projectName("C:\\Users\\kp\\tech\\app"), "tech-app");
});

test("nothing on disk: no tools, a plain sentence, and --share says so", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-spend-empty-"));
  const cache = mkdtempSync(join(tmpdir(), "cd-spend-cache-"));
  try {
    await withSandboxHome(home, () => at(FIXTURE_NOW, cache, () => {
      const r = spendReport(30, { home });
      assert.equal(r.tools.length, 0);
      assert.match(renderSpend(r), /^No usage in the last 30 days/);
      assert.match(renderSpendShare(r), /no AI coding usage/);
      // A window past any history is ten years: every empty day of 1e7 took 51 s, 1e9 fell off the calendar.
      for (const days of [1e7, 1e9]) {
        const big = spendReport(days, { home });
        assert.equal(big.days, 3650);
        assert.ok(big.daily.length >= 3650 && big.daily.length <= 3652, `${big.daily.length} days`);
      }
    }));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

/** The CLI on a fixture with Claude Code (a session with every billing modifier too), Codex and Gemini CLI: text, JSON and --share, byte for byte. */
const GOLDEN = [["spend"], ["spend", "--json"], ["spend", "--share"]];

test("spend on every tool: the CLI's output, cold and warm, against src/test/golden/spend", () => {
  const home = mkdtempSync(join(tmpdir(), "cd-spend-golden-"));
  const cache = mkdtempSync(join(tmpdir(), "cd-spend-golden-cache-"));
  const dir = join(here, "..", "..", "src", "test", "golden", "spend");
  try {
    buildHistory(home);
    writeCodex(home, FIXTURE_NOW);
    writeGemini(home, FIXTURE_NOW);
    // Fast mode, US-only, a 150k Haiku 5.5 prompt and web searches: what spend says the modifiers added.
    writeModifierSession(home, FIXTURE_NOW - DAY);
    for (const pass of ["cold", "warm"]) {
      for (const args of GOLDEN) {
        const out = runReport(cli, home, args, { CONTEXT_DOCTOR_CACHE_DIR: cache });
        const file = join(dir, `${args.map((a) => a.replace(/^-+/, "")).join("_")}.txt`);
        // To regenerate after a change meant to move a figure: CONTEXT_DOCTOR_UPDATE_GOLDEN=1 npm test.
        if (process.env.CONTEXT_DOCTOR_UPDATE_GOLDEN === "1" && pass === "cold") { mkdirSync(dir, { recursive: true }); writeFileSync(file, out); }
        assert.ok(existsSync(file), `golden ${file}`);
        assert.equal(out, readFileSync(file, "utf8"), `${pass}: context-doctor ${args.join(" ")}`);
      }
    }
    const json = JSON.parse(readFileSync(join(dir, "spend_json.txt"), "utf8").replace(/\n\[exit \d+\]\n$/, ""));
    assert.deepEqual(json.tools.map((t: { tool: string }) => t.tool).sort(), ["claude", "codex", "gemini"]);
    const share = readFileSync(join(dir, "spend_share.txt"), "utf8");
    assert.ok(!/work-app|tech-app|site|[\\/]/.test(share.replace("npx context-doctor spend", "")), "--share names no project or path");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

test("spend's flags: an unknown one is refused with a suggestion; --share and --json do not mix", () => {
  const home = mkdtempSync(join(tmpdir(), "cd-spend-args-"));
  mkdirSync(join(home, "work", "app"), { recursive: true });
  try {
    const bad = runReport(cli, home, ["spend", "--dayz", "3"]);
    assert.match(bad, /\[exit 1\]/);
    assert.match(runReport(cli, home, ["spend", "--share", "--json"]), /\[exit 1\]/);
    assert.match(runReport(cli, home, ["spend", "extra"]), /\[exit 1\]/);
    // Each option on a line of its own (D1 once joined -q to the --days entry).
    const help = runReport(cli, home, ["--help"]);
    for (const opt of ["--days <n>", "-q, --query <text>", "--block", "--limit <n>"]) assert.match(help, new RegExp(`^ {2}${opt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `, "m"), opt);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
