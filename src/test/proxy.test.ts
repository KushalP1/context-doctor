/**
 * Proxy end-to-end test against a mock upstream: verifies in-flight
 * optimization, tool_result preservation, header passthrough, SSE-style
 * streaming, and the /stats endpoint.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { startProxy } from "../proxy.js";

const bigTool = "row of data | ".repeat(2000);
const doc = "TERMS: usage is billed monthly per seat with overage charged at cycle end. ".repeat(8);
const payload = JSON.stringify({
  model: "claude-sonnet-5",
  max_tokens: 100,
  system: "You are helpful.",
  messages: [
    { role: "user", content: "check the data\n" + doc },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "query_db", input: { q: "select *" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: bigTool }] },
    { role: "assistant", content: "Done." },
    { role: "user", content: "check the data\n" + doc },
    ...Array.from({ length: 7 }, (_, i) => ({ role: "user" as const, content: `follow-up ${i}` })),
  ],
});

let received = "";
let receivedApiKey: string | undefined;

const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received = body;
    receivedApiKey = req.headers["x-api-key"] as string;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: message_start\ndata: {}\n\n");
    res.write("event: message_stop\ndata: {}\n\n");
    res.end();
  });
});

await new Promise<void>((r) => upstream.listen(0, r));
const upstreamPort = (upstream.address() as AddressInfo).port;
const proxy = startProxy({ port: 0, anthropicUpstream: `http://localhost:${upstreamPort}` });
await new Promise<void>((r) => proxy.once("listening", () => r()));
const proxyPort = (proxy.address() as AddressInfo).port;

after(() => {
  proxy.close();
  upstream.close();
});

test("proxy optimizes in flight and passes through auth + streaming", async () => {
  const resp = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-test-not-real", "anthropic-version": "2023-06-01" },
    body: payload,
  });
  const respText = await resp.text();

  assert.ok(received.length < payload.length, "upstream received a smaller body");
  const parsed = JSON.parse(received);
  const toolBlock = parsed.messages[2].content[0];
  assert.equal(toolBlock.type, "tool_result");
  assert.equal(toolBlock.tool_use_id, "t1");
  assert.equal(parsed.model, "claude-sonnet-5");
  assert.equal(receivedApiKey, "sk-test-not-real");
  assert.equal(resp.status, 200);
  assert.ok(respText.includes("message_start") && respText.includes("message_stop"), "SSE streamed through");
});

test("/stats reports cumulative savings with dollar estimate", async () => {
  const stats = await (await fetch(`http://localhost:${proxyPort}/stats`)).json() as Record<string, number>;
  assert.equal(stats.requests, 1);
  assert.equal(stats.optimizedRequests, 1);
  assert.ok(stats.tokensSaved > 1000, `saved tokens tracked (${stats.tokensSaved})`);
  assert.ok(stats.estUsdSaved > 0, "dollar savings estimated from the request's model");
});

test("unsupported paths get a clear 404, health stays up", async () => {
  const notFound = await fetch(`http://localhost:${proxyPort}/v1/nope`, { method: "POST", body: "{}" });
  assert.equal(notFound.status, 404);
  const health = await (await fetch(`http://localhost:${proxyPort}/health`)).json() as { ok: boolean };
  assert.equal(health.ok, true);
});
