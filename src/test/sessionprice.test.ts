/**
 * The session price: the every-prompt hook says once per session when its
 * cost passes $25, $100 and $500, on synthetic transcripts in a throwaway
 * home with the clock frozen. Silent below the first, once per threshold
 * (several hooks at once too), subagents counted, a damaged ledger read
 * again, Codex's and Gemini CLI's inputs, the off switch, and the warm
 * per-prompt cost on a long transcript.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSessionPrice, sessionPriceDue, sessionPriceThresholds, SESSION_PRICE_THRESHOLDS } from "../sessionprice.js";
import { claudeSpend } from "../spend.js";
import { clearScanMemo } from "../scan.js";
import { frozenClock } from "./history-fixture.js";
import { cleanEnv } from "./golden-run.js";
import { withSandboxHome } from "./sandbox.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const MIN = 60_000, HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);

let n = 0;
/**
 * One reply on claude-sonnet-5 ($2 in, $10 out, $0.20 cached per 1M): a
 * 300k-token context read from the cache ($0.06) and `usd` more of output.
 */
function reply(ts: number, usd: number, opts: { sidechain?: boolean; tokens?: number } = {}): string {
  const id = `msg_${n++}`;
  return JSON.stringify({
    type: "assistant", uuid: `u-${id}`, timestamp: new Date(ts).toISOString(), ...(opts.sidechain ? { isSidechain: true } : {}),
    message: { id, model: "claude-sonnet-5", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 0, cache_read_input_tokens: opts.tokens ?? 300_000, output_tokens: Math.round(usd * 100_000) } },
  }) + "\n";
}
/** A user turn of `kb` kilobytes: bulk, no cost. */
const pad = (kb: number) => JSON.stringify({ type: "user", uuid: `p-${n++}`, timestamp: new Date(NOW - HOUR).toISOString(), message: { role: "user", content: "x".repeat(kb * 1024) } }) + "\n";

function setup(): { home: string; transcript: string; env: NodeJS.ProcessEnv; dir: string } {
  const home = mkdtempSync(join(tmpdir(), "cd-price-"));
  const cache = mkdtempSync(join(tmpdir(), "cd-price-cache-"));
  const transcript = join(home, ".claude", "projects", "-work-app", "s1.jsonl");
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, "");
  return { home, transcript, env: cleanEnv(home, { CONTEXT_DOCTOR_CACHE_DIR: cache }), dir: join(home, ".claude", ".context-doctor-hook-state.d") };
}

const prompt = (transcript: string, extra: Record<string, unknown> = {}) => JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1", transcript_path: transcript, cwd: "/work/app", prompt: "go on", ...extra });

function hook(env: NodeJS.ProcessEnv, input: string, now = NOW): string | undefined {
  const r = spawnSync(process.execPath, [...frozenClock(now), cli, "hook"], { env, input, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim();
  return out ? JSON.parse(out).systemMessage : undefined;
}

/** The session's price files beside the hook's state. */
const priceFiles = (dir: string) => { try { return readdirSync(dir).filter((f) => f.includes(".price")); } catch { return []; } };
const ledgerOf = (dir: string, sid: string) => join(dir, createHash("sha1").update(sid).digest("hex").slice(0, 16) + ".price.json");

test("thresholds: $25, $100, $500 by default; CONTEXT_DOCTOR_SESSION_PRICE sets them; CONTEXT_DOCTOR_NO_SESSION_PRICE=1 turns it off", () => {
  assert.deepEqual(sessionPriceThresholds({}), [25, 100, 500]);
  assert.deepEqual(SESSION_PRICE_THRESHOLDS, [25, 100, 500]);
  assert.deepEqual(sessionPriceThresholds({ CONTEXT_DOCTOR_SESSION_PRICE: "$200, 50 50" }), [50, 200]);
  assert.deepEqual(sessionPriceThresholds({ CONTEXT_DOCTOR_SESSION_PRICE: "lots" }), [25, 100, 500], "not dollars: the defaults");
  assert.deepEqual(sessionPriceThresholds({ CONTEXT_DOCTOR_NO_SESSION_PRICE: "1", CONTEXT_DOCTOR_SESSION_PRICE: "10" }), []);
});

test("the line: cost so far, subagents' part, the next message's price, cold or warm, and the host's own command", () => {
  const base = { app: "claude" as const, threshold: 100, usd: 112.4, subagentUsd: 30, tokens: 470_000, readUsd: 0.47 };
  assert.equal(renderSessionPrice(base), "context-doctor: this session has cost $112 so far ($30.00 of it subagents); each message now re-reads ~470k tokens (~$0.470). /compact, or a handoff to a new session, cuts that.");
  assert.match(renderSessionPrice({ ...base, coldUsd: 4.7 }), /the cache expired while it was idle, so this message re-writes its ~470k tokens \(~\$4\.70\), and each one after re-reads them \(~\$0\.470\)\./);
  assert.match(renderSessionPrice({ ...base, app: "gemini", subagentUsd: 0 }), /^context-doctor: this session has cost \$112 so far; .*\/compress, or a handoff/);
  // Just compacted (the new size unknown): the cost alone.
  assert.equal(renderSessionPrice({ ...base, usd: 25.5, subagentUsd: 0, tokens: undefined, readUsd: undefined }), "context-doctor: this session has cost $25.50 so far.");
});

test("the hook: silent and writing nothing below $25, each threshold once, a jump said once for the higher", () => {
  const { transcript, env, dir } = setup();
  writeFileSync(transcript, reply(NOW - 3 * MIN, 10) + reply(NOW - 2 * MIN, 10));
  assert.equal(hook(env, prompt(transcript)), undefined, "$20.12: below the first threshold");
  assert.deepEqual(priceFiles(dir), [], "nothing written for a small session below it");

  appendFileSync(transcript, reply(NOW - MIN, 5));
  const at25 = hook(env, prompt(transcript));
  assert.equal(at25, "context-doctor: this session has cost $25.18 so far; each message now re-reads ~300k tokens (~$0.060). /compact, or a handoff to a new session, cuts that.");
  assert.equal(hook(env, prompt(transcript)), undefined, "once");
  appendFileSync(transcript, reply(NOW - MIN, 10));
  assert.equal(hook(env, prompt(transcript)), undefined, "$35: no new threshold");

  // $35 to $450: past $100 (said), not $500.
  appendFileSync(transcript, reply(NOW - MIN, 415));
  assert.match(hook(env, prompt(transcript)) ?? "", /cost \$450 so far/);
  appendFileSync(transcript, reply(NOW - MIN, 100));
  assert.match(hook(env, prompt(transcript)) ?? "", /cost \$550 so far/);
  assert.equal(hook(env, prompt(transcript)), undefined, "all said");

  // Another session starts afresh.
  const other = join(dirname(transcript), "s2.jsonl");
  writeFileSync(other, reply(NOW - MIN, 30));
  assert.match(hook(env, prompt(other, { session_id: "s2" })) ?? "", /cost \$30\.06 so far/);
});

test("a first look at a session already past $100 says $100 once, not $25 as well", () => {
  const { transcript, env } = setup();
  writeFileSync(transcript, reply(NOW - 2 * MIN, 60) + reply(NOW - MIN, 60));
  assert.match(hook(env, prompt(transcript)) ?? "", /cost \$120 so far/);
  appendFileSync(transcript, reply(NOW - MIN, 1));
  assert.equal(hook(env, prompt(transcript)), undefined, "$25 is not said after $100");
});

test("subagents bill to the session: counted in its cost and named, while the per-message price is the main conversation's", () => {
  const { transcript, env } = setup();
  writeFileSync(transcript, reply(NOW - 2 * MIN, 10));
  const subs = join(transcript.replace(/\.jsonl$/, ""), "subagents");
  mkdirSync(subs, { recursive: true });
  writeFileSync(join(subs, "agent-a.jsonl"), reply(NOW - MIN, 20, { sidechain: true, tokens: 50_000 }));
  assert.equal(hook(env, prompt(transcript)), "context-doctor: this session has cost $30.07 so far ($20.01 of it subagents); each message now re-reads ~300k tokens (~$0.060). /compact, or a handoff to a new session, cuts that.");
});

test("its figure is spend's for the same session, subagents included", async () => {
  const { home, transcript } = setup();
  const subs = join(transcript.replace(/\.jsonl$/, ""), "subagents");
  mkdirSync(subs, { recursive: true });
  writeFileSync(transcript, reply(NOW - 3 * MIN, 12) + reply(NOW - 2 * MIN, 9.5));
  writeFileSync(join(subs, "agent-a.jsonl"), reply(NOW - MIN, 7.25, { sidechain: true }));
  await withSandboxHome(home, () => {
    clearScanMemo();
    const p = sessionPriceDue({ sessionId: "consistency", transcript }, NOW, {});
    const spent = claudeSpend(0, Infinity, [transcript]).reduce((a, it) => a + it.usd, 0);
    assert.ok(p && Math.abs(p.usd - spent) < 1e-9, `${p?.usd} vs ${spent}`);
  });
});

test("after an idle that expired the cache: this message's re-write, and the cold-resume line is not said twice", () => {
  const { transcript, env } = setup();
  // Large enough for the hook's own cold-resume check (past its size gate and 150k tokens).
  writeFileSync(transcript, pad(200) + reply(NOW - 3 * HOUR, 20) + reply(NOW - 2 * HOUR, 10));
  const said = hook(env, prompt(transcript)) ?? "";
  assert.match(said, /^context-doctor: this session has cost \$30\.12 so far; the cache expired while it was idle, so this message re-writes its ~300k tokens \(~\$0\.750\), and each one after re-reads them \(~\$0\.060\)\. \/compact, or a handoff/);
  assert.doesNotMatch(said, /idle \d+ (minutes|hours), so this message re-sent/, "one line about the re-write, not two");
});

test("when the price line has told the user to /compact, the model is not asked to offer it too", () => {
  const { transcript, env } = setup();
  writeFileSync(transcript, pad(200) + reply(NOW - 3 * HOUR, 20) + reply(NOW - 2 * HOUR, 10));
  const r = spawnSync(process.execPath, [...frozenClock(NOW), cli, "hook"], { env: { ...env, CONTEXT_DOCTOR_WARN_TOKENS: "100000" }, input: prompt(transcript), encoding: "utf8", timeout: 60_000 });
  const out = JSON.parse(r.stdout.trim());
  assert.match(out.systemMessage, /this session has cost \$30\.12 so far; the cache expired/);
  const model = String(out.hookSpecificOutput?.additionalContext ?? "");
  assert.doesNotMatch(model, /Begin your reply with one short sentence offering/, "the cold-resume offer");
  assert.doesNotMatch(model, /offer the user a compaction/, "the heavy-context offer");
  assert.match(model, /This session's context is at ~300k tokens/, "the model still gets the facts");
  // A later idle, with no price line due, gets the model's offer as before.
  appendFileSync(transcript, reply(NOW - 90 * MIN, 1));
  const later = spawnSync(process.execPath, [...frozenClock(NOW + 3 * HOUR), cli, "hook"], { env, input: prompt(transcript), encoding: "utf8", timeout: 60_000 });
  assert.match(JSON.parse(later.stdout.trim()).hookSpecificOutput.additionalContext, /Begin your reply with one short sentence offering/);
});

/** A row as Claude Code writes it, with the session it belongs to and its model. */
function ownRow(ts: number, usd: number, sessionId: string, model = "claude-sonnet-5", opts: { id?: string; output?: number; sidechain?: boolean } = {}): string {
  const id = opts.id ?? `msg_${n++}`;
  return JSON.stringify({ type: "assistant", uuid: `u-${id}-${n++}`, sessionId, timestamp: new Date(ts).toISOString(), ...(opts.sidechain ? { isSidechain: true } : {}), message: { id, model, role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 0, cache_read_input_tokens: 300_000, output_tokens: opts.output ?? Math.round(usd * 100_000) } } }) + "\n";
}

test("workflow agents bill to the session; a resumed session's copy of the old one is not its cost; family prices and unpriced models are named", () => {
  const { transcript, env } = setup();
  // A session resumed into s1: the old session's rows copied first, keeping its id ($50), then s1's own ($10).
  writeFileSync(transcript, ownRow(NOW - 5 * HOUR, 25, "old") + ownRow(NOW - 4 * HOUR, 25, "old") + ownRow(NOW - 3 * MIN, 10, "s1"));
  // A workflow run's agent ($20), its rows carrying s1's id; one reply on a model known only by its family, one on a model with no price.
  const run = join(transcript.replace(/\.jsonl$/, ""), "subagents", "workflows", "wf_one");
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "agent-w1.jsonl"), ownRow(NOW - 2 * MIN, 20, "s1", "claude-sonnet-5", { sidechain: true }) + ownRow(NOW - 2 * MIN, 0, "s1", "claude-sonnet-9", { sidechain: true, output: 0 }) + ownRow(NOW - 2 * MIN, 0, "s1", "my-local-model", { sidechain: true }));
  const said = hook(env, prompt(transcript)) ?? "";
  // $10.06 + $20.06 + claude-sonnet-9 at the Sonnet family's $0.30 per 1M cached read ($0.09).
  assert.equal(said, "context-doctor: this session has cost $30.21 so far ($20.15 of it workflow agents; ~$0.09 priced as its model's family, an estimate; 1 request with no list price not counted); each message now re-reads ~300k tokens (~$0.060). /compact, or a handoff to a new session, cuts that.");
});

test("a finished subagent's entry keeps no recent replies: the price file stays small, and a later write is still counted right", async () => {
  const { home, transcript } = setup();
  const subs = join(transcript.replace(/\.jsonl$/, ""), "subagents");
  mkdirSync(subs, { recursive: true });
  writeFileSync(transcript, pad(600) + ownRow(NOW - HOUR, 1, "s1"));
  const agent = join(subs, "agent-a.jsonl");
  writeFileSync(agent, pad(100) + ownRow(NOW - 3 * HOUR, 2, "s1", undefined, { id: "msg_sub", sidechain: true }));
  utimesSync(agent, new Date(NOW - 3 * HOUR), new Date(NOW - 3 * HOUR));
  await withSandboxHome(home, () => {
    clearScanMemo();
    const env = { CONTEXT_DOCTOR_SESSION_PRICE: "4" };
    assert.equal(sessionPriceDue({ sessionId: "s1", transcript }, NOW, env), undefined, "$3.12: below $4");
    const file = JSON.parse(readFileSync(ledgerOf(join(home, ".claude", ".context-doctor-hook-state.d"), "s1"), "utf8"));
    assert.equal(file.v, 2);
    assert.ok(Array.isArray(file.f[transcript].r), "the live main conversation keeps its list");
    assert.equal(file.f[agent].r, undefined, "the finished subagent keeps none");
    // It writes again after all: the same reply's output settles (+$1), and a new reply ($1).
    appendFileSync(agent, ownRow(NOW - MIN, 3, "s1", undefined, { id: "msg_sub", sidechain: true }) + ownRow(NOW - MIN, 1, "s1", undefined, { sidechain: true }));
    const p = sessionPriceDue({ sessionId: "s1", transcript }, NOW, env);
    const spent = claudeSpend(0, Infinity, [transcript]).reduce((a, it) => a + it.usd, 0);
    assert.ok(p && Math.abs(p.usd - spent) < 1e-9 && Math.abs(p.usd - 5.18) < 1e-9, `${p?.usd} vs ${spent}`);
  });
});

test("several hooks at once for one session: the threshold is said by exactly one", async () => {
  const { transcript, env } = setup();
  writeFileSync(transcript, reply(NOW - 2 * MIN, 20) + reply(NOW - MIN, 10));
  const one = () => new Promise<string>((resolve) => {
    const c = spawn(process.execPath, [...frozenClock(NOW), cli, "hook"], { env });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", () => resolve(out));
    c.stdin.end(prompt(transcript));
  });
  const outs = await Promise.all(Array.from({ length: 8 }, one));
  assert.equal(outs.filter((o) => o.includes("this session has cost")).length, 1, outs.join("|"));
});

test("a damaged ledger is read again, not trusted; a state folder that cannot be written fails quiet", () => {
  const { transcript, env, dir } = setup();
  // Past SAVE_BYTES: the ledger is kept.
  writeFileSync(transcript, pad(600) + reply(NOW - 2 * MIN, 10));
  assert.equal(hook(env, prompt(transcript)), undefined);
  const ledger = ledgerOf(dir, "s1");
  assert.ok(existsSync(ledger), "a long read is kept");
  // Damaged two ways: not JSON, then JSON with an entry that says $1,000.
  writeFileSync(ledger, "{\"f\": {");
  assert.equal(hook(env, prompt(transcript)), undefined);
  writeFileSync(ledger, JSON.stringify({ f: { [transcript]: { t: "claude", s: 1, m: 1, i: 1, k: ["a"], d: [1000, 5], o: 0 } } }));
  assert.equal(hook(env, prompt(transcript)), undefined, "a malformed entry is not $1,000");
  appendFileSync(transcript, reply(NOW - MIN, 20));
  assert.match(hook(env, prompt(transcript)) ?? "", /cost \$30\.12 so far/);

  // The state folder is a file: nothing can be claimed, so nothing is said, and the prompt goes on.
  const b = setup();
  writeFileSync(b.transcript, reply(NOW - MIN, 30));
  writeFileSync(b.dir, "not a folder");
  assert.equal(hook(b.env, prompt(b.transcript)), undefined);
});

test("the hook's pruning keeps a live session's markers: a threshold is not said again weeks on", () => {
  const { home, transcript, env, dir } = setup();
  writeFileSync(transcript, reply(NOW - 3 * MIN, 30));
  assert.match(hook(env, prompt(transcript)) ?? "", /cost \$30\.06 so far/);
  // Said three days ago; the session goes on.
  for (const f of priceFiles(dir)) utimesSync(join(dir, f), new Date(NOW - 3 * 24 * HOUR), new Date(NOW - 3 * 24 * HOUR));
  appendFileSync(transcript, reply(NOW - 2 * MIN, 1));
  assert.equal(hook(env, prompt(transcript)), undefined);
  // Meanwhile 210 files of other sessions, newer than the marker, and one more session's state is written: the folder is pruned.
  for (let i = 0; i < 70; i++) {
    for (const ext of [".json", ".price.json", ".spawns.jsonl"]) {
      writeFileSync(join(dir, `other${String(i).padStart(10, "0")}${ext}`), "{}");
      utimesSync(join(dir, `other${String(i).padStart(10, "0")}${ext}`), new Date(NOW - 24 * HOUR), new Date(NOW - 24 * HOUR));
    }
  }
  const s2 = join(home, ".claude", "projects", "-work-app", "s2.jsonl");
  writeFileSync(s2, pad(200) + reply(NOW - MIN, 0.01, { tokens: 10_000 }));
  hook(env, prompt(s2, { session_id: "s2" }));
  assert.ok(readdirSync(dir).length <= 200, `${readdirSync(dir).length} files`);
  assert.ok(priceFiles(dir).some((f) => f.endsWith(".price-25")), "the live session's marker is kept");
  assert.ok(!readdirSync(dir).some((f) => f.startsWith("other0000000000")), "the least recent sessions go, each whole");
  assert.ok(readdirSync(dir).every((f) => !f.startsWith("other") || [".json", ".price.json", ".spawns.jsonl"].every((ext) => existsSync(join(dir, f.split(".")[0] + ext)))), "no session is left in part");
  appendFileSync(transcript, reply(NOW - MIN, 1));
  assert.equal(hook(env, prompt(transcript)), undefined, "$25 was said already");
});

test("Codex: a rollout's cost, its last request at the cached rate, and /compact", () => {
  const { home, env } = setup();
  const path = join(home, ".codex", "sessions", "2026", "10", "14", "rollout-2026-10-14T10-00-00-abc.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  const line = (type: string, payload: unknown) => JSON.stringify({ timestamp: new Date(NOW - MIN).toISOString(), type, payload });
  // gpt-5: $1.25 in, $10 out, $0.125 cached per 1M; each request ~$10.04.
  const rows = [line("session_meta", { id: "abc", cwd: "/w" }), line("turn_context", { model: "gpt-5" })];
  for (let i = 1; i <= 3; i++) rows.push(line("event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: i * 200_000, output_tokens: i * 1_000_000, total_tokens: i * 1_200_000 }, last_token_usage: { input_tokens: 200_000, cached_input_tokens: 190_000, output_tokens: 1_000_000 } } }));
  writeFileSync(path, rows.join("\n") + "\n");
  const said = hook(env, JSON.stringify({ session_id: "abc", transcript_path: path, cwd: "/w", hook_event_name: "UserPromptSubmit", turn_id: "t1", prompt: "go", model: "gpt-5" }));
  assert.equal(said, "context-doctor: this session has cost $30.11 so far; each message now re-reads ~200k tokens (~$0.025). /compact, or a handoff to a new session, cuts that.");
});

test("Gemini CLI: BeforeAgent gets the line, with /compress", () => {
  const { home, env } = setup();
  const path = join(home, ".gemini", "tmp", "p1", "chats", "session-2026-10-14T10-00-abc.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  const at = new Date(NOW - MIN).toISOString();
  // gemini-3-pro: $2 in, $12 out, $0.20 cached per 1M; each message ~$12.06.
  const rows: unknown[] = [{ sessionId: "abc", projectHash: "p1", startTime: at, lastUpdated: at, kind: "main" }];
  for (let i = 1; i <= 3; i++) rows.push({ id: `g${i}`, timestamp: at, type: "gemini", content: "ok", model: "gemini-3-pro", tokens: { input: 200_000, cached: 190_000, output: 1_000_000 } });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const said = hook(env, JSON.stringify({ session_id: "abc", transcript_path: path, cwd: "/w", hook_event_name: "BeforeAgent", timestamp: at, prompt: "go" }));
  // gemini-3-pro has no row of its own (the Gemini 3 Pro family's price): said to be an estimate.
  assert.match(said ?? "", /^context-doctor: this session has cost \$36\.\d\d so far \(~\$36\.\d\d priced as its model's family, an estimate\); each message now re-reads ~200k tokens \(~\$0\.040\)\. \/compress, or a handoff to a new session, cuts that\.$/);
});

test("CONTEXT_DOCTOR_NO_SESSION_PRICE=1: silent, nothing written; other events never say it", () => {
  const { transcript, env, dir } = setup();
  writeFileSync(transcript, pad(600) + reply(NOW - MIN, 600));
  assert.equal(hook({ ...env, CONTEXT_DOCTOR_NO_SESSION_PRICE: "1" }, prompt(transcript)), undefined);
  assert.deepEqual(priceFiles(dir), []);
  // A session start, a compaction or a tool call is not a prompt.
  for (const ev of ["SessionStart", "PreCompact", "PreToolUse"]) assert.equal(hook(env, prompt(transcript, { hook_event_name: ev })), undefined, ev);
  assert.deepEqual(priceFiles(dir), []);
  assert.match(hook(env, prompt(transcript)) ?? "", /cost \$600 so far/);
  // doctor says it is off.
  const doc = spawnSync(process.execPath, [cli, "doctor"], { env: { ...env, CONTEXT_DOCTOR_NO_SESSION_PRICE: "1" }, encoding: "utf8", timeout: 60_000 });
  assert.match(doc.stdout, /Session price\s+off \(CONTEXT_DOCTOR_NO_SESSION_PRICE=1\)/);
});

test("warm, a prompt on a long session reads only what was appended", async () => {
  const { home, transcript } = setup();
  // ~12 MB: 3,000 replies between bulky turns, $3.60 so far.
  const chunks: string[] = [];
  for (let i = 0; i < 3_000; i++) chunks.push(pad(4), reply(NOW - HOUR + i, 0.001, { tokens: 1_000 }));
  writeFileSync(transcript, chunks.join(""));
  await withSandboxHome(home, () => {
    const env = {};
    let t = performance.now();
    assert.equal(sessionPriceDue({ sessionId: "long", transcript }, NOW, env), undefined);
    const first = performance.now() - t;
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      appendFileSync(transcript, pad(8) + reply(NOW - MIN + i, 0.001, { tokens: 1_000 }));
      t = performance.now();
      assert.equal(sessionPriceDue({ sessionId: "long", transcript }, NOW, env), undefined);
      times.push(performance.now() - t);
    }
    const warm = times.sort((a, b) => a - b)[2];
    // The first look reads 12 MB; each later one, a turn. Generous for a slow CI machine.
    assert.ok(warm < 25, `warm ${warm.toFixed(1)} ms (first ${first.toFixed(1)} ms)`);
    assert.ok(warm < first / 3, `warm ${warm.toFixed(1)} ms vs first ${first.toFixed(1)} ms`);
  });
});
