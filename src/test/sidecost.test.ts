/**
 * What Claude Code bills that no row records the usage of, beyond F1's
 * first pass: subagent replies whose rows Claude Code 2.1.284-2.1.299 never
 * settled (their output estimated from their content, and counted), prompt
 * suggestions after a turn (named in the gap, not counted: whether one was
 * sent is in no file), and requests that hung and were sent again (named,
 * counted, not priced). Fixture transcripts; every figure by hand.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestCost } from "../pricing.js";
import { claudeFileUsage } from "../limits.js";
import { claudeSpend, renderSpend, spendReport } from "../spend.js";
import { gapText, stalledRetries, turnEnds, type SessionGap } from "../ccost.js";
import { contentOutputTokens, suggestionUsage, unsettledVersion } from "../sidecost.js";
import { clearScanMemo, rowsOf } from "../scan.js";
import { USAGE_ROWS } from "../limits.js";
import { withSandboxHome } from "./sandbox.js";

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const SID = "f1000000-0000-4000-8000-00000000cc02";
const iso = (t: number) => new Date(t).toISOString();
const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);

async function inHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "cd-sidecost-"));
  const real = Date.now;
  const saved = process.env.CONTEXT_DOCTOR_CACHE_DIR;
  process.env.CONTEXT_DOCTOR_CACHE_DIR = join(home, ".cache-cd");
  Date.now = () => NOW;
  clearScanMemo();
  try {
    return await withSandboxHome(home, () => fn(home));
  } finally {
    Date.now = real;
    if (saved === undefined) delete process.env.CONTEXT_DOCTOR_CACHE_DIR;
    else process.env.CONTEXT_DOCTOR_CACHE_DIR = saved;
    clearScanMemo();
    rmSync(home, { recursive: true, force: true });
  }
}

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

// A subagent reply as 2.1.295 wrote it: a row per content block, each with the usage of the stream's start (9 output tokens), none with a stop_reason.
const SUB_USAGE = { input_tokens: 2, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 3_000, cache_creation: { ephemeral_5m_input_tokens: 3_000, ephemeral_1h_input_tokens: 0 }, output_tokens: 9 };
const BLOCKS = [
  { type: "thinking", thinking: "", signature: "s".repeat(1000) },
  { type: "text", text: "y".repeat(500) },
  { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "z".repeat(98) } },
];
// By hand: 0.40 a character of text and tool input ({"command":"z…"} is 112, "Bash" 4), 0.26 a signature character.
const ESTIMATE = Math.round(0.4 * (500 + 112 + 4) + 0.26 * 1000); // 506

function writeSubagentSession(home: string, version: string, settled = false): { top: string; sub: string } {
  const dir = join(home, ".claude", "projects", "-work-app");
  const top = join(dir, `${SID}.jsonl`);
  const subDir = join(dir, SID, "subagents");
  mkdirSync(subDir, { recursive: true });
  const t0 = NOW - 3_600_000;
  writeFileSync(top, jsonl([
    { type: "user", uuid: "m-0", sessionId: SID, timestamp: iso(t0), version, message: { role: "user", content: "go" } },
    { type: "assistant", uuid: "m-1", sessionId: SID, timestamp: iso(t0 + 1000), version, message: { id: "msg_main", model: "claude-opus-5-5", role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000, output_tokens: 20 } } },
  ]));
  const sub = join(subDir, "agent-a1.jsonl");
  writeFileSync(sub, jsonl(BLOCKS.map((b, i) => ({
    type: "assistant", isSidechain: true, uuid: `s-${i}`, sessionId: SID, timestamp: iso(t0 + 60_000 + i * 1000), version,
    message: { id: "msg_sub", model: "claude-opus-5-5", role: "assistant", ...(settled ? { stop_reason: "tool_use" } : {}), content: [b], usage: SUB_USAGE },
  }))));
  return { top, sub };
}

test("a subagent reply whose rows never settled (2.1.295): its output from its content, in spend; the same rows from 2.1.308, or settled, as recorded", async () => {
  assert.equal(contentOutputTokens(BLOCKS), ESTIMATE);
  assert.ok(unsettledVersion("2.1.284") && unsettledVersion("2.1.295") && unsettledVersion("2.1.299"));
  assert.ok(!unsettledVersion("2.1.283") && !unsettledVersion("2.1.308") && !unsettledVersion(undefined));
  await inHome((home) => {
    const { top, sub } = writeSubagentSession(home, "2.1.295");
    const [r] = claudeFileUsage(sub, 0);
    assert.equal(r.output, ESTIMATE);
    assert.equal(r.unsettled, ESTIMATE - 9);
    near(r.usd, requestCost("claude-opus-5-5", { ...SUB_USAGE, output_tokens: ESTIMATE }, r.ts)!.totalUsd, "priced with the estimated output");
    const items = claudeSpend(0, Infinity, [top]);
    assert.equal(items.find((it) => it.subagent)!.unsettled, ESTIMATE - 9);
    const report = spendReport(30, { claudePaths: [top], progress: false, now: NOW });
    near(report.unsettled!.tokens, ESTIMATE - 9, "spend: the tokens estimated");
    near(report.unsettled!.usd, ((ESTIMATE - 9) * 20) / 1e6, "spend: their dollars, at Opus 5.5's $20 a million");
    assert.match(renderSpend(report), /Of it, \$0\.01 output of 1 subagent reply whose rows Claude Code never settled \(2\.1\.284-2\.1\.299\), an estimate from its content/);
  });
  for (const [version, settled] of [["2.1.308", false], ["2.1.295", true]] as const) {
    await inHome((home) => {
      const { sub } = writeSubagentSession(home, version, settled);
      const [r] = claudeFileUsage(sub, 0);
      assert.equal(r.output, 9, `${version}${settled ? ", settled" : ""}: as recorded`);
      assert.equal(r.unsettled, undefined);
    });
  }
});

test("a prompt suggestion follows a main-thread turn's end: the last prompt read, its reply written; none for a subagent, `claude -p`, a large write", () => {
  const row = (over: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) => ({
    type: "assistant", timestamp: iso(NOW), entrypoint: "claude-desktop",
    message: { id: "m", model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 2, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 900, cache_creation: { ephemeral_1h_input_tokens: 900, ephemeral_5m_input_tokens: 0 }, output_tokens: 145, ...usage } },
    ...over,
  });
  const u = suggestionUsage(row())!;
  assert.deepEqual(
    { input: u.input_tokens, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, w1h: u.cache_creation?.ephemeral_1h_input_tokens, output: u.output_tokens },
    { input: 506, read: 300_902, write: 145, w1h: 145, output: 15 },
  );
  assert.equal(suggestionUsage(row({ isSidechain: true })), undefined, "a subagent's");
  assert.equal(suggestionUsage(row({ entrypoint: "sdk-cli" })), undefined, "claude -p");
  assert.equal(suggestionUsage(row({}, { cache_creation_input_tokens: 9_900 })), undefined, "a reply that wrote over 10k with its input and output");
  assert.equal(suggestionUsage({ ...row(), message: { ...row().message, stop_reason: "tool_use" } }), undefined, "no turn's end");
  // turnEnds: within the window, priced at its model (Opus 5.5: $4 in, $0.20 read, $8 an hour's write, $20 out).
  const ends = turnEnds([row(), { ...row(), timestamp: iso(NOW + 10_000) }], NOW - 1, NOW + 1);
  assert.equal(ends.n, 1);
  near(ends.usd, (506 * 4 + 300_902 * 0.2 + 145 * 8 + 15 * 20) / 1e6, "one suggestion");
});

test("requests that hung and were sent again are counted: not a request re-sent at once, not one that never left the machine", async () => {
  await inHome((home) => {
    const file = join(home, "t.jsonl");
    const t = NOW - 3_600_000;
    const sent = (id: string, at: number, base?: string, tail: string[] = ["h1"]) => ({ type: "api-request", sessionId: SID, id, timestamp: iso(at), version: "2.1.321", querySource: "sdk", ...(base ? { base } : {}), tail });
    const reply = (ref: string, at: number) => ({ type: "assistant", uuid: `r-${ref}`, timestamp: iso(at), requestRef: ref, message: { id: `msg-${ref}`, model: "claude-opus-5-5", stop_reason: "tool_use", content: [], usage: { input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 100, output_tokens: 5 } } });
    writeFileSync(file, jsonl([
      // Hung: no reply, the same request again 16 minutes later.
      sent("a", t), sent("b", t + 16 * 60_000, "a", []), reply("b", t + 16 * 60_000 + 3000),
      // Recorded twice as it was sent: the second within a second, answered.
      sent("c", t + 20 * 60_000, "b"), sent("d", t + 20 * 60_000 + 500, "c", []), reply("d", t + 20 * 60_000 + 3000),
      // Never reached the API: the error says so.
      sent("e", t + 30 * 60_000, "d"), { type: "system", subtype: "api_error", timestamp: iso(t + 30 * 60_000 + 100), error: { message: "Connection error.", connection: { code: "ENOTFOUND" } } },
      sent("f", t + 32 * 60_000, "e", []), reply("f", t + 32 * 60_000 + 3000),
    ]));
    assert.equal(rowsOf<Record<string, any>>(file, USAGE_ROWS).filter((r) => r.type === "api-request").length, 6);
    assert.equal(stalledRetries([file], 0, Infinity), 1);
    assert.equal(stalledRetries([file], t + 60_000, Infinity), 0, "outside the span");
  });
});

test("the gap names the prompt suggestions (as many as Claude Code's extra input has room for) and the requests that hung", () => {
  const g: SessionGap = {
    session: "s", from: 0, to: 1, ccUsd: 1, ourUsd: 0.5, compactionUsd: 0, compactions: 0, stalled: 3, turnEnds: { n: 3, usd: 0.3 },
    models: [{ model: "claude-opus-5-5", ccUsd: 1, cc: { input: 10 + 2 * 506, output: 0, read: 0, write: 0, searches: 0 }, ourUsd: 0.5, ours: { input: 10, output: 0, read: 0, write: 0, requests: 2 }, ccAtOurUsd: 1 }],
  };
  const text = gapText([g]).join("\n");
  assert.match(text, /Claude Code counts \$0\.50 more for requests no transcript records; about 2 of them prompt suggestions \(the next message Claude Code offers after a turn/);
  assert.match(text, /each adds\), about \$0\.20; 3 requests hung and were sent again/);
  // No room in its input: none named.
  assert.doesNotMatch(gapText([{ ...g, models: [{ ...g.models[0], cc: { ...g.models[0].cc, input: 10 } }] }]).join("\n"), /prompt suggestions/);
});
