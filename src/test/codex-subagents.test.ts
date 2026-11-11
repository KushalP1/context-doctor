/**
 * Codex's spawned agents bill to the thread that spawned them. Their
 * rollouts name it in their own (first) session_meta: `parent_thread_id`,
 * and `source.subagent.thread_spawn.parent_thread_id` (Codex Desktop 0.146
 * on the author's machine). A forked one starts with a copy of its parent's
 * history, session_meta rows and token_count events included, counted once
 * (codexEventKey). A thread the user forked names only `forked_from_id`: a
 * session of its own. On a parent, a forked spawned agent, a fresh one and a
 * user fork, the session price equals `spend`'s figure for that session.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { codexSpawnedRollouts, codexSpend, renderSpend, summarizeSpend, type SpawnHeads } from "../spend.js";
import { sessionPriceDue } from "../sessionprice.js";
import { clearScanMemo } from "../scan.js";
import { withSandboxHome } from "./sandbox.js";

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const T = NOW - 2 * 3_600_000;
const DAY = 86_400_000;
const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);

const P = "019fb6b8-cdba-7e03-a8f3-e7c3c8d2406b";
const A = "019fb6c3-755e-7913-9376-ddc6a7f266a6";
const B = "019fb6b8-f929-79f0-868c-32faee7e195a";
const F = "019fb6d0-0000-7000-8000-000000000f0f";

const iso = (t: number) => new Date(t).toISOString();
/** Codex names a rollout by its local start time and thread id. */
function rolloutPath(home: string, at: number, id: string): string {
  const d = new Date(at);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const dir = join(home, ".codex", "sessions", String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
  mkdirSync(dir, { recursive: true });
  return join(dir, `rollout-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}-${id}.jsonl`);
}
/** Its ids first, its instructions after, as Codex writes it (`long`: a first line past what codexSpawnedRollouts reads of it). */
const meta = (at: number, payload: Record<string, unknown>, long = false) => ({ timestamp: iso(at), type: "session_meta", payload: { ...payload, cwd: "/Users/me/tech/app", originator: "Codex Desktop", model_provider: "openai", base_instructions: { text: "You are Codex. ".repeat(long ? 4_000 : 400) } } });
const turn = (at: number) => ({ timestamp: iso(at), type: "turn_context", payload: { cwd: "/Users/me/tech/app", model: "gpt-5.5" } });
/** A token_count event: the running total and the last request (input, cached, output). */
const tc = (at: number, total: [number, number, number], last: [number, number, number]) => ({
  timestamp: iso(at), type: "event_msg",
  payload: { type: "token_count", info: { total_token_usage: { input_tokens: total[0], cached_input_tokens: total[1], output_tokens: total[2], reasoning_output_tokens: 0, total_tokens: total[0] + total[2] }, last_token_usage: { input_tokens: last[0], cached_input_tokens: last[1], output_tokens: last[2], reasoning_output_tokens: 0, total_tokens: last[0] + last[2] } } },
});
function write(path: string, rows: unknown[], at: number): string {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  utimesSync(path, at / 1000, at / 1000);
  return path;
}
/** gpt-5.5 at $5 / $0.50 / $30: uncached input, cached, output. */
const usd = (input: number, cached: number, out: number) => ((input - cached) * 5 + cached * 0.5 + out * 30) / 1e6;

function history(home: string): { parent: string; forked: string; fresh: string; userFork: string } {
  const p1 = tc(T + 1_000, [10_000, 0, 100], [10_000, 0, 100]);
  const p2 = tc(T + 60_000, [30_000, 9_000, 300], [20_000, 9_000, 200]);
  const parent = write(rolloutPath(home, T, P), [meta(T, { id: P, session_id: P, source: "vscode", thread_source: "user" }), turn(T + 10), p1, p2, tc(T + 600_000, [80_000, 40_000, 600], [50_000, 31_000, 300])], T + 600_000);
  // Spawned at T+2m as a fork: its own meta, then a copy of the parent's (meta and events, stamped at the fork), then its own requests.
  const at = T + 120_000;
  const copy = (e: ReturnType<typeof tc>) => ({ ...e, timestamp: iso(at) });
  const forked = write(rolloutPath(home, at, A), [
    meta(at, { id: A, session_id: P, forked_from_id: P, parent_thread_id: P, source: { subagent: { thread_spawn: { parent_thread_id: P, depth: 1, agent_path: "/root/rates", agent_nickname: "Franklin" } } }, thread_source: "subagent" }),
    meta(at, { id: P, session_id: P, source: "vscode", thread_source: "user" }),
    turn(at), copy(p1), copy(p2),
    tc(T + 180_000, [45_000, 20_000, 500], [15_000, 11_000, 200]),
    tc(T + 240_000, [66_000, 38_000, 700], [21_000, 18_000, 200]),
  ], T + 240_000);
  // Spawned at T+2m10s, not a fork: only the source names the parent.
  const fresh = write(rolloutPath(home, T + 130_000, B), [
    meta(T + 130_000, { id: B, session_id: P, source: { subagent: { thread_spawn: { parent_thread_id: P, depth: 1, agent_path: "/root/sources", agent_nickname: "Linnaeus" } } }, thread_source: "subagent" }, true),
    turn(T + 130_010), tc(T + 200_000, [12_000, 0, 100], [12_000, 0, 100]),
  ], T + 200_000);
  // The user forked the thread at T+5m: a session of its own, with a copy of the parent's first request.
  const userFork = write(rolloutPath(home, T + 300_000, F), [
    meta(T + 300_000, { id: F, forked_from_id: P, source: "vscode", thread_source: "user" }),
    turn(T + 300_010), { ...p1, timestamp: iso(T + 300_000) },
    tc(T + 360_000, [19_000, 0, 200], [9_000, 0, 100]),
  ], T + 360_000);
  return { parent, forked, fresh, userFork };
}

const PARENT_USD = usd(10_000, 0, 100) + usd(20_000, 9_000, 200) + usd(50_000, 31_000, 300);
const SPAWNED_USD = usd(15_000, 11_000, 200) + usd(21_000, 18_000, 200) + usd(12_000, 0, 100);

test("Codex: a thread's spawned agents (forked or not) are in its session price, as spend counts that session; a user's fork is not", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-codex-sub-"));
  const savedCache = process.env.CONTEXT_DOCTOR_CACHE_DIR;
  process.env.CONTEXT_DOCTOR_CACHE_DIR = join(home, ".cache-cd");
  clearScanMemo();
  try {
    await withSandboxHome(home, () => {
      const h = history(home);
      assert.deepEqual(codexSpawnedRollouts(h.parent, NOW, home).map((f) => basename(f)), [basename(h.forked), basename(h.fresh)].sort());
      assert.deepEqual(codexSpawnedRollouts(h.forked, NOW, home), [], "a spawned agent spawned nothing");

      // spend: the spawned agents' requests are the parent's session, marked as subagents; the copied history once.
      const items = codexSpend(NOW - DAY, NOW, home);
      assert.equal(items.length, 3 + 3 + 1, "parent 3, spawned 3, the user's fork its own 1 (its copy of the parent's first request once)");
      const r = summarizeSpend(items, 1, NOW - DAY, NOW);
      const session = r.sessions.find((s) => s.session === basename(h.parent, ".jsonl"))!;
      near(session.usd, PARENT_USD + SPAWNED_USD, "spend's session");
      assert.equal(session.requests, 6);
      near(r.tools[0].subagentUsd!, SPAWNED_USD, "Codex's subagents");
      assert.match(renderSpend(r), /^Codex +\$0\.\d\d +7 requests +subagents \$0\.12$/m);
      near(r.sessions.find((s) => s.session === basename(h.userFork, ".jsonl"))!.usd, usd(9_000, 0, 100), "the user's fork");

      // The session price, as the hook figures it for the parent: the same dollars, the spawned agents named.
      const due = sessionPriceDue({ sessionId: P, transcript: h.parent, event: "UserPromptSubmit" }, NOW, { CONTEXT_DOCTOR_SESSION_PRICE: "0.10" })!;
      assert.equal(due.app, "codex");
      near(due.usd, session.usd, "session price = spend");
      near(due.subagentUsd, SPAWNED_USD, "its subagents' part");
    });
  } finally {
    if (savedCache === undefined) delete process.env.CONTEXT_DOCTOR_CACHE_DIR;
    else process.env.CONTEXT_DOCTOR_CACHE_DIR = savedCache;
    clearScanMemo();
    rmSync(home, { recursive: true, force: true });
  }
});

test("Codex: each rollout's first line is read once; a later prompt reads only rollouts new since, and forgets those gone", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-codex-heads-"));
  try {
    await withSandboxHome(home, () => {
      const h = history(home);
      const known: SpawnHeads = { heads: {} };
      const both = [basename(h.forked), basename(h.fresh)].sort();
      assert.deepEqual(codexSpawnedRollouts(h.parent, NOW, home, known).map((f) => basename(f)), both);
      assert.equal(known.changed, true);
      assert.deepEqual(known.heads[basename(h.fresh)], [B, P], "kept by file name: its id and its parent");
      assert.deepEqual(known.heads[basename(h.userFork)], [F], "a user's fork is kept too, with no parent");
      // The next prompt: nothing new, so no first line is read. One rewritten in place (a first line never
      // changes; this one would now name no parent) still counts as kept, which shows it was not read again.
      writeFileSync(h.fresh, JSON.stringify(meta(T + 130_000, { id: B, source: "vscode" })) + "\n");
      known.changed = false;
      assert.deepEqual(codexSpawnedRollouts(h.parent, NOW, home, known).map((f) => basename(f)), both);
      assert.equal(known.changed, false, "nothing to save");
      // A new spawned agent is read; a rollout gone is forgotten.
      const late = write(rolloutPath(home, T + 400_000, "019fb6e0-0000-7000-8000-00000000a1a1"), [meta(T + 400_000, { id: "019fb6e0-0000-7000-8000-00000000a1a1", parent_thread_id: P })], T + 400_000);
      rmSync(h.userFork);
      assert.deepEqual(codexSpawnedRollouts(h.parent, NOW, home, known).map((f) => basename(f)), [...both, basename(late)].sort());
      assert.equal(known.changed, true);
      assert.equal(known.heads[basename(h.userFork)], undefined);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
