/**
 * Autopilot clears only output the model has already read, and only when the
 * cache is really cold. Pinned here, each from a case that went wrong:
 *  - request 2 of a session is the same conversation as request 1 (the key
 *    held the first tool id, and Claude Code moves cache_control off the
 *    first message), so eight seconds later it was called cold;
 *  - results that arrive with the request (six parallel reads) are never
 *    eligible, cold or not;
 *  - a Gemini result without an id cleared in one run is not cleared in the
 *    next run of the same prompt (its derived id collided), above all not the
 *    newest result;
 *  - after a restart a conversation sent ten seconds ago is still warm (its
 *    last request time is persisted), and one with no record is warm too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoClearer } from "../autoclear.js";
import { startProxy } from "../proxy.js";

const big = (tag: string, lines = 400) => `${tag}\n` + "const value = compute(input, options); // step\n".repeat(lines); // 400 lines: ~6k tokens
const CLEARED = /^\[context-doctor: old tool output cleared/;
const HOUR = 3_600_000;
const sys = [{ type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } }];

/** Claude Code's shape: cache_control rides on the last message's last block. */
function claudeCode(rounds: string[][], lines = 400) {
  const messages: any[] = [{ role: "user", content: [{ type: "text", text: "read the six files" }] }];
  for (const ids of rounds) {
    messages.push({ role: "assistant", content: ids.map((id) => ({ type: "tool_use", id, name: "Read", input: { file_path: `/${id}` } })) });
    messages.push({ role: "user", content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: big(id, lines) })) });
  }
  const last = messages.at(-1).content.at(-1);
  last.cache_control = { type: "ephemeral" };
  return { model: "claude-opus-5-5", system: sys, metadata: { user_id: "user_x_session_1" }, messages };
}
const resultsOf = (body: any) => body.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.type === "tool_result");

test("request 2 (the first tool round) is the same conversation as request 1: warm 8 s later, nothing cleared", () => {
  const c = new AutoClearer();
  c.apply(claudeCode([]), 0);
  const body = claudeCode([["a", "b", "c", "d", "e", "f"]], 1200); // a..c alone would make a 20k batch
  const r = c.apply(body, 8_000);
  assert.equal(r.cold, false, "seen 8 s ago: warm");
  assert.equal(r.changed, false);
  assert.ok(resultsOf(body).every((b: any) => !CLEARED.test(String(b.content))));
});

test("results that arrive with the request are never eligible, even on a cold cache", () => {
  const body = claudeCode([["r0"], ["r1"], ["r2"], ["r3"], ["a", "b", "c", "d", "e", "f"]]);
  const r = new AutoClearer().apply(body, 0); // never seen, default model: cold
  assert.equal(r.cold, true);
  const results = resultsOf(body);
  assert.deepEqual(results.filter((b: any) => CLEARED.test(String(b.content))).map((b: any) => b.tool_use_id), ["r0", "r1", "r2", "r3"]);
  assert.ok(results.slice(4).every((b: any) => b.content.startsWith(b.tool_use_id)), "the six new reads reach the model");
});

function gemini(outputs: string[]) {
  const contents: any[] = [{ role: "user", parts: [{ text: "fix the build" }] }];
  outputs.forEach((o, i) => {
    contents.push({ role: "model", parts: [{ functionCall: { name: "read_file", args: { path: `f${i}` } } }] });
    contents.push({ role: "user", parts: [{ functionResponse: { name: "read_file", response: { output: o } } }] });
  });
  return { contents };
}
const responses = (b: any) => b.contents.flatMap((c: any) => c.parts).filter((p: any) => p.functionResponse);

test("Gemini without ids: a second run of the same prompt keeps its own results, the newest above all", () => {
  const c = new AutoClearer();
  const run1 = gemini(Array.from({ length: 8 }, (_, i) => big(`run1 ${i}`)));
  assert.ok(c.apply(run1, 0, "gemini-3-pro").newlyCleared > 0);
  const run2 = gemini(Array.from({ length: 4 }, (_, i) => big(`run2 ${i}`)));
  const r = c.apply(run2, 1_000, "gemini-3-pro"); // warm: nothing new may be cleared
  assert.equal(r.changed, false, r.reason);
  assert.ok(responses(run2).every((p: any) => !JSON.stringify(p.functionResponse.response).includes("context-doctor")));
});

test("after a restart a conversation sent 10 s ago is warm; one idle 2 h is cold; one never recorded is warm", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-convs-"));
  const statePath = join(dir, "state.json");
  const now = Date.now();
  const before = new AutoClearer({ statePath, unseenIsWarm: true });
  before.apply(claudeCode([]), now - 10_000);
  const idle = claudeCode([]);
  idle.metadata.user_id = "user_x_session_2";
  before.apply(idle, now - 2 * HOUR);
  before.flush();
  assert.ok(Array.isArray(JSON.parse(readFileSync(statePath, "utf8")).convs));

  const rounds = Array.from({ length: 8 }, (_, i) => [`t${i}`]);
  const after = new AutoClearer({ statePath, unseenIsWarm: true });
  const warm = after.apply(claudeCode(rounds), now);
  assert.equal(warm.cold, false, "sent 10 s before the restart: still warm");
  assert.equal(warm.changed, false);
  const cold = claudeCode(rounds);
  cold.metadata.user_id = "user_x_session_2";
  assert.equal(after.apply(cold, now).newlyCleared, 5, "idle 2 h: cold, the stale reads go (all but the last 3)");
  const unknown = claudeCode(rounds);
  unknown.metadata.user_id = "user_x_session_3";
  assert.equal(after.apply(unknown, now).cold, false, "no record: warm");
});

test("the proxy treats a conversation it has no record of as warm, and a recorded idle one as cold", async () => {
  const received: any[] = [];
  const up = http.createServer((q, s) => { let b = ""; q.on("data", (c) => (b += c)); q.on("end", () => { received.push(JSON.parse(b)); s.setHeader("content-type", "application/json"); s.end("{}"); }); });
  await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
  const statePath = join(mkdtempSync(join(tmpdir(), "cd-convs-px-")), "state.json");
  const seed = new AutoClearer({ statePath });
  const idle = claudeCode([]);
  idle.metadata.user_id = "user_x_idle";
  seed.apply(idle, Date.now() - 2 * HOUR);
  seed.flush();
  const px = startProxy({ port: 0, autopilot: true, autopilotStatePath: statePath, anthropicUpstream: `http://127.0.0.1:${(up.address() as AddressInfo).port}` });
  await new Promise<void>((r) => px.once("listening", r));
  const send = (body: unknown) => fetch(`http://127.0.0.1:${(px.address() as AddressInfo).port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "k" }, body: JSON.stringify(body) }).then((r) => r.text());
  try {
    const rounds = Array.from({ length: 8 }, (_, i) => [`p${i}`]);
    const unseen = claudeCode(rounds);
    unseen.metadata.user_id = "user_x_new";
    await send(unseen);
    assert.ok(resultsOf(received[0]).every((b: any) => !CLEARED.test(String(b.content))), "no record: warm, sent as is");
    const recorded = claudeCode(rounds);
    recorded.metadata.user_id = "user_x_idle";
    await send(recorded);
    assert.ok(CLEARED.test(String(resultsOf(received[1])[0].content)), "recorded 2 h ago: cold, cleared");
  } finally {
    px.close();
    up.close();
  }
});
