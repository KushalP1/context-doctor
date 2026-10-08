/** withContextDoctor: autopilot inside the app's own SDK client, on a copy of each request. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AutoClearer } from "../autoclear.js";
import { contextDoctorStats, withContextDoctor } from "../wrap.js";

/** An Anthropic Messages conversation with `n` large Read results. */
function conversation(n: number) {
  const messages: any[] = [{ role: "user", content: "Refactor the parser." }];
  for (let i = 0; i < n; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Read", input: { file_path: `/src/f${i}.ts` } }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `export const x${i} = 1;\n`.repeat(2000) }] });
  }
  messages.push({ role: "assistant", content: "Done." }, { role: "user", content: "Now the tests." });
  return { model: "claude-sonnet-5", max_tokens: 1024, messages };
}

function fakeAnthropic() {
  const sent: any[] = [];
  const client = {
    messages: { create(params: any, opts?: any) { sent.push({ params, opts, self: this }); return Promise.resolve({ ok: true }); } },
    models: { list() { return "untouched"; } },
  };
  return { client, sent };
}

test("a conversation this process has never seen is sent as is (it may be warm elsewhere)", async () => {
  const { client, sent } = fakeAnthropic();
  const wrapped = withContextDoctor(client);
  const body = conversation(8);
  await wrapped.messages.create(body, { timeout: 5 });
  assert.equal(sent[0].params, body, "unchanged requests are passed through by reference");
  assert.deepEqual(sent[0].opts, { timeout: 5 }, "request options are forwarded");
  assert.equal(sent[0].self, client.messages, "methods keep their SDK `this`");
  assert.deepEqual(contextDoctorStats(wrapped), { requests: 1, changed: 0, tokensRemoved: 0 });
});

test("a cold return clears stale tool output on a copy; the app's own history is untouched", async () => {
  const { client, sent } = fakeAnthropic();
  const clearer = new AutoClearer({ unseenIsWarm: true });
  const body = conversation(8);
  clearer.apply(structuredClone(body), Date.now() - 2 * 3_600_000); // seen two hours ago: the cache has expired
  const seen: any[] = [];
  const wrapped = withContextDoctor(client, { clearer, onRequest: (i) => seen.push(i) });
  const before = JSON.stringify(body);
  await wrapped.messages.create(body);
  assert.equal(JSON.stringify(body), before, "the caller's object was not mutated");
  assert.notEqual(sent[0].params, body);
  assert.ok(JSON.stringify(sent[0].params).length < before.length / 2);
  assert.equal(seen[0].method, "messages.create");
  assert.equal(seen[0].model, "claude-sonnet-5");
  assert.ok(seen[0].changed && seen[0].cold);
  const s = contextDoctorStats(wrapped)!;
  assert.equal(s.changed, 1);
  assert.ok(s.tokensRemoved > 20_000);
});

test("OpenAI-shaped clients are wrapped too, and other methods pass through", async () => {
  const calls: string[] = [];
  const client = {
    chat: { completions: { create: (p: any) => (calls.push("chat"), p) } },
    responses: { create: (p: any) => (calls.push("responses"), p) },
    models: { list: () => "list" },
  };
  const wrapped = withContextDoctor(client);
  wrapped.chat.completions.create({ model: "gpt-5", messages: [{ role: "user", content: "hi" }] });
  wrapped.responses.create({ model: "gpt-5", input: "hi" });
  assert.equal(wrapped.models.list(), "list");
  assert.deepEqual(calls, ["chat", "responses"]);
  assert.equal(contextDoctorStats(wrapped)!.requests, 2);
});
