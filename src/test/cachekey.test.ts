/**
 * prompt_cache_key per conversation (OpenAI, models before GPT-5.6).
 * Pinned: which models get one, stability across a conversation's turns,
 * the app's own key and server-side conversations untouched, and the proxy
 * adding it toward api.openai.com only (another upstream may reject it).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { usesPromptCacheKey, withPromptCacheKey } from "../cachekey.js";
import { startProxy } from "../proxy.js";

test("models that route by the key: GPT before 5.6, the o-series, codex-mini", () => {
  for (const m of ["gpt-5.5", "gpt-5.5-pro", "gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o-mini", "o3", "o4-mini", "codex-mini-latest", "openai/gpt-5.4"]) assert.equal(usesPromptCacheKey(m), true, m);
  for (const m of ["gpt-5.6-sol", "gpt-5.6", "gpt-6.1-sol", "claude-opus-5-5", "llama-3", undefined]) assert.equal(usesPromptCacheKey(m), false, String(m));
});

test("one key per conversation: the same on every turn, another for another opening, none where it does not belong", () => {
  const turn1 = { model: "gpt-5.5", messages: [{ role: "system", content: "S" }, { role: "user", content: "fix the bug" }] };
  const turn2 = { ...turn1, messages: [...turn1.messages, { role: "assistant", content: "done" }, { role: "user", content: "and the test" }] };
  const k1 = withPromptCacheKey(JSON.stringify(turn1))!.key;
  assert.match(k1, /^cd-[0-9a-f]{32}$/);
  assert.equal(withPromptCacheKey(JSON.stringify(turn2))!.key, k1);
  assert.notEqual(withPromptCacheKey(JSON.stringify({ ...turn1, messages: [{ role: "system", content: "other" }, turn1.messages[1]] }))!.key, k1, "other instructions, other key");
  assert.equal(JSON.parse(withPromptCacheKey(JSON.stringify(turn1))!.body).prompt_cache_key, k1);
  // Responses: instructions + first user item; a plain string input too.
  const r1 = withPromptCacheKey(JSON.stringify({ model: "gpt-5.5", instructions: "I", input: [{ role: "user", content: "go" }] }))!.key;
  const r2 = withPromptCacheKey(JSON.stringify({ model: "gpt-5.5", instructions: "I", input: [{ role: "user", content: "go" }, { type: "function_call_output", call_id: "c", output: "x" }] }))!.key;
  assert.equal(r1, r2);
  assert.ok(withPromptCacheKey(JSON.stringify({ model: "gpt-5.5", input: "hello" })));
  // Left alone.
  assert.equal(withPromptCacheKey(JSON.stringify({ ...turn1, prompt_cache_key: "tenant-7" })), undefined, "the app's key");
  assert.equal(withPromptCacheKey(JSON.stringify({ ...turn1, prompt_cache_key: "" })), undefined, "even an empty one");
  assert.equal(withPromptCacheKey(JSON.stringify({ model: "gpt-5.5", previous_response_id: "r", input: [{ role: "user", content: "n" }] })), undefined);
  assert.equal(withPromptCacheKey(JSON.stringify({ model: "gpt-5.5", conversation: "conv_1", input: [{ role: "user", content: "n" }] })), undefined);
  assert.equal(withPromptCacheKey(JSON.stringify({ ...turn1, model: "gpt-5.6-sol" })), undefined);
  assert.equal(withPromptCacheKey("not json"), undefined);
});

test("the proxy adds it toward api.openai.com by default, not toward another upstream unless asked", async () => {
  const bodies: any[] = [];
  const up = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { bodies.push(JSON.parse(b)); res.setHeader("content-type", "application/json"); res.end("{}"); }); });
  await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
  const upstream = `http://127.0.0.1:${(up.address() as AddressInfo).port}`;
  const send = async (opts: Parameters<typeof startProxy>[0]) => {
    const px = startProxy({ port: 0, openaiUpstream: upstream, ...opts });
    await new Promise<void>((r) => px.once("listening", r));
    try {
      await fetch(`http://127.0.0.1:${(px.address() as AddressInfo).port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-test" }, body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }) });
    } finally { px.close(); }
  };
  await send({ autopilot: true });
  assert.equal(bodies.at(-1).prompt_cache_key, undefined, "a non-OpenAI upstream may reject the field");
  await send({ autopilot: true, promptCacheKey: true });
  assert.match(bodies.at(-1).prompt_cache_key, /^cd-/);
  up.close();
});
