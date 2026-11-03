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
import { claudeSpend, codexSpend, cursorSpend, geminiSpend, renderSpend, renderSpendShare, spendReport, summarizeSpend } from "../spend.js";
import { claudeUsage, codexLimitData } from "../limits.js";
import { estimateSavings } from "../savings.js";
import { clearScanMemo } from "../scan.js";
import { buildHistory, FIXTURE_NOW } from "./history-fixture.js";
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
/** By hand, at gpt-5's $1.25 / $0.125 / $10: 400 uncached + 600 read + 100 out, then 200 + 900 + 100. */
const CODEX_USD = (400 * 1.25 + 600 * 0.125 + 100 * 10 + 200 * 1.25 + 900 * 0.125 + 100 * 10) / 1e6;

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
      const input = items.filter((i) => !i.subagent && kept.has(i.session)).reduce((n, i) => n + i.inputUsd + i.writeUsd + i.readUsd, 0);
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
      writeFileSync(join(home, ".codex", "archived_sessions", "rollout-2026-09-27T10-00-00-def.jsonl"), src);
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

/** The CLI on a fixture with Claude Code, Codex and Gemini CLI: text, JSON and --share, byte for byte. */
const GOLDEN = [["spend"], ["spend", "--json"], ["spend", "--share"]];

test("spend on every tool: the CLI's output, cold and warm, against src/test/golden/spend", () => {
  const home = mkdtempSync(join(tmpdir(), "cd-spend-golden-"));
  const cache = mkdtempSync(join(tmpdir(), "cd-spend-golden-cache-"));
  const dir = join(here, "..", "..", "src", "test", "golden", "spend");
  try {
    buildHistory(home);
    writeCodex(home, FIXTURE_NOW);
    writeGemini(home, FIXTURE_NOW);
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
