/**
 * Thinking blocks vs history edits. On current Claude models a thinking
 * block's signature binds the conversation before it, and accounts created
 * on or after 2026-08-31 get a 400 ("... bound to a different conversation")
 * for a request whose earlier turns were edited; the same body fails again
 * on retry. Older accounts are not enforced. Pinned:
 *  - a refused edit is resent unedited once, and the client gets that
 *    answer (status, headers, stream) as if nothing happened;
 *  - the account is remembered (across restarts under autopilot) and its
 *    conversations are not edited again where a thinking block follows;
 *  - clearings sent before keep being applied, since later thinking is
 *    bound to them; an unenforced account keeps its savings;
 *  - the optimizing proxy does the same, and any other 400 is passed on.
 * The mock upstream enforces like the API: for the "enforced" key it refuses
 * a body whose messages differ from the client's before a thinking block.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoClearer } from "../autoclear.js";
import { startProxy } from "../proxy.js";

const HOUR = 3_600_000;
const big = (i: number) => `file ${i}\n` + "const value = compute(input, options); // step\n".repeat(400);
const REFUSAL = { type: "error", error: { type: "invalid_request_error", message: "messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to \"drop_block\"." } };
const SSE = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';

/** `rounds` Read calls; `thinkingIn` says which assistant turns carry a thinking block. */
function conversation(task: string, rounds: number, thinkingIn: (i: number) => boolean = () => true) {
  const messages: any[] = [{ role: "user", content: task }];
  for (let i = 0; i < rounds; i++) {
    const thinking = thinkingIn(i) ? [{ type: "thinking", thinking: "", signature: `sig-${task}-${i}` }] : [];
    messages.push({ role: "assistant", content: [...thinking, { type: "tool_use", id: `toolu_${task.replace(/\W/g, "")}_${i}`, name: "Read", input: { file_path: `/f${i}` } }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${task.replace(/\W/g, "")}_${i}`, content: big(i) }] });
  }
  return { model: "claude-opus-5-5", max_tokens: 1000, stream: true, messages };
}

// The mock API. `pristine` is what the client sent; the proxy's copy may differ.
let pristine: any[] = [];
const calls: Array<{ key: string; messages: any[] }> = [];
let otherError: string | undefined;
const up = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const body = JSON.parse(b);
    const key = String(req.headers["x-api-key"]);
    calls.push({ key, messages: body.messages });
    if (otherError) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(otherError);
    }
    let first = 0;
    while (first < pristine.length && JSON.stringify(body.messages[first]) === JSON.stringify(pristine[first])) first++;
    const edited = first < pristine.length;
    const thinkingLater = body.messages.slice(first).some((m: any) => Array.isArray(m.content) && m.content.some((x: any) => x.type === "thinking"));
    if (key === "enforced" && edited && thinkingLater) {
      res.writeHead(400, { "content-type": "application/json", "request-id": "req_refused" });
      return res.end(JSON.stringify(REFUSAL));
    }
    res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_ok", "x-mock": "streamed" });
    res.end(SSE);
  });
});
await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
const upstreamUrl = `http://127.0.0.1:${(up.address() as AddressInfo).port}`;
const dir = mkdtempSync(join(tmpdir(), "cd-think-"));
const statePath = join(dir, "state.json");

/** Record these conversations as last sent two hours ago: their next request is cold. */
function idle(...tasks: string[]) {
  const seed = new AutoClearer({ statePath });
  for (const t of tasks) seed.apply(conversation(t, 0), Date.now() - 2 * HOUR);
  seed.flush();
}
idle("task one", "task two", "task three", "task four");
const proxy = startProxy({ port: 0, autopilot: true, autopilotStatePath: statePath, anthropicUpstream: upstreamUrl });
await new Promise<void>((r) => proxy.once("listening", r));
const servers: http.Server[] = [proxy, up];
after(() => { for (const s of servers) s.close(); });

async function send(port: number, key: string, body: any) {
  pristine = body.messages;
  calls.length = 0;
  const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) });
  return { status: r.status, headers: r.headers, text: await r.text() };
}
const port = () => (proxy.address() as AddressInfo).port;
const isEdited = (messages: any[]) => JSON.stringify(messages) !== JSON.stringify(pristine);

test("a refused edit is resent unedited once; the client gets that answer as if nothing happened", async () => {
  const r = await send(port(), "enforced", conversation("task one", 12));
  assert.equal(calls.length, 2);
  assert.ok(isEdited(calls[0].messages), "autopilot cleared stale reads (cold)");
  assert.deepEqual(calls[1].messages, pristine, "the resend is the client's own body");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-mock"), "streamed");
  assert.equal(r.headers.get("request-id"), "req_ok");
  assert.equal(r.text, SSE);
  const stats = (await fetch(`http://127.0.0.1:${port()}/stats`).then((x) => x.json())) as any;
  assert.equal(stats.autopilot.changedRequests, 0, "the refused edit is not counted as a saving");
  assert.equal(stats.tokensSaved, 0);
  assert.ok(JSON.parse(readFileSync(statePath, "utf8")).rejectsEdits.length === 1, "the account is remembered on disk");
});

test("that account's conversations are then sent unedited where a thinking block follows, also after a restart", async () => {
  let r = await send(port(), "enforced", conversation("task one", 13));
  assert.equal(calls.length, 1);
  assert.equal(isEdited(calls[0].messages), false, "the cleared ids of the refused request were forgotten");
  assert.equal(r.status, 200);
  const restarted = startProxy({ port: 0, autopilot: true, autopilotStatePath: statePath, anthropicUpstream: upstreamUrl });
  servers.push(restarted);
  await new Promise<void>((x) => restarted.once("listening", x));
  r = await send((restarted.address() as AddressInfo).port, "enforced", conversation("task two", 12));
  assert.equal(calls.length, 1, "no refused round trip");
  assert.equal(isEdited(calls[0].messages), false);
  assert.equal(r.status, 200);
});

test("the same account still gets clearings no thinking block comes after", async () => {
  await send(port(), "enforced", conversation("task three", 12, (i) => i === 0));
  assert.equal(calls.length, 1);
  assert.ok(isEdited(calls[0].messages), "cleared: the only thinking block precedes every cleared result");
});

test("an account the API does not enforce keeps its savings", async () => {
  const r = await send(port(), "legacy", conversation("task four", 12));
  assert.equal(calls.length, 1);
  assert.ok(isEdited(calls[0].messages));
  assert.equal(r.status, 200);
});

test("a 400 that is not about thinking is passed on as is, once", async () => {
  idle("task five");
  const p = startProxy({ port: 0, autopilot: true, autopilotStatePath: statePath, anthropicUpstream: upstreamUrl });
  servers.push(p);
  await new Promise<void>((x) => p.once("listening", x));
  otherError = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens: too large" } });
  try {
    const r = await send((p.address() as AddressInfo).port, "other", conversation("task five", 12));
    assert.equal(calls.length, 1);
    assert.equal(r.status, 400);
    assert.equal(r.text, otherError);
  } finally {
    otherError = undefined;
  }
});

test("the optimizing proxy resends a refused edit unedited too, then leaves that account's thinking conversations alone", async () => {
  const p = startProxy({ port: 0, anthropicUpstream: upstreamUrl });
  servers.push(p);
  await new Promise<void>((x) => p.once("listening", x));
  const pp = (p.address() as AddressInfo).port;
  let r = await send(pp, "enforced", conversation("task six", 12));
  assert.equal(calls.length, 2);
  assert.ok(isEdited(calls[0].messages), "the optimizer trimmed old tool results");
  assert.deepEqual(calls[1].messages, pristine);
  assert.equal(r.status, 200);
  r = await send(pp, "enforced", conversation("task six", 13));
  assert.equal(calls.length, 1);
  assert.equal(isEdited(calls[0].messages), false);
  r = await send(pp, "legacy", conversation("task seven", 12));
  assert.ok(isEdited(calls[0].messages), "another account keeps its savings");
});

test("clearings sent before are re-applied for a refusing account; new ones a thinking block follows are not", () => {
  const c = new AutoClearer();
  const early = conversation("task eight", 12, () => false); // no thinking yet: cleared when cold
  const first = c.apply(early, 0, undefined, "acct");
  assert.equal(first.newlyCleared, 9);
  c.noteEditsRejected("acct");
  // Ten more rounds, with thinking: the new stale results have thinking after them.
  const later = conversation("task eight", 22, (i) => i >= 12);
  const r = c.apply(later, 2 * HOUR, undefined, "acct");
  assert.equal(r.newlyCleared, 0, r.reason);
  assert.match(r.reason, /thinking/);
  assert.deepEqual(r.appliedIds, first.newIds, "the earlier clearings still go out: later thinking is bound to them");
  c.forget(r.appliedIds);
  const plain = conversation("task eight", 22, (i) => i >= 12);
  assert.equal(c.apply(plain, 2 * HOUR + 1000, undefined, "acct").changed, false, "forgotten clearings are not applied");
});

test("a request that opts into the thinking check is treated as enforced", () => {
  const body: any = conversation("task nine", 12);
  body.thinking = { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } };
  const r = new AutoClearer().apply(body, 0);
  assert.equal(r.changed, false, r.reason);
});
