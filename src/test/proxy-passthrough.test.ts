/**
 * A client routed through the proxy uses more than the conversation
 * endpoints. Pinned: every other path is forwarded (to Anthropic when the
 * request says it is one, else OpenAI), and bodies the proxy does not rewrite
 * reach upstream byte for byte (binary uploads were corrupted by a UTF-8
 * round trip before 0.24).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { startProxy, upstreamFor } from "../proxy.js";

const hits: Array<{ who: string; url: string; body: Buffer }> = [];
const make = (who: string) => http.createServer((q, r) => { const c: Buffer[] = []; q.on("data", (d) => c.push(d)); q.on("end", () => { hits.push({ who, url: q.url!, body: Buffer.concat(c) }); r.setHeader("content-type", "application/json"); r.end("{}"); }); });
const anth = make("anthropic"), oai = make("openai");
await new Promise<void>((r) => anth.listen(0, "127.0.0.1", r));
await new Promise<void>((r) => oai.listen(0, "127.0.0.1", r));
const opts = { anthropicUpstream: `http://127.0.0.1:${(anth.address() as AddressInfo).port}`, openaiUpstream: `http://127.0.0.1:${(oai.address() as AddressInfo).port}` };
after(() => { anth.close(); oai.close(); });

test("upstreamFor: conversation paths are fixed; other paths follow the request's own headers", () => {
  assert.equal(upstreamFor("/v1/models", opts, { "anthropic-version": "2023-06-01" }), opts.anthropicUpstream);
  assert.equal(upstreamFor("/v1/models", opts, { authorization: "Bearer sk-x" }), opts.openaiUpstream);
  assert.equal(upstreamFor("/v1/messages/count_tokens", opts, {}), opts.anthropicUpstream);
  assert.equal(upstreamFor("/v1/responses", opts, { "anthropic-version": "x" }), opts.openaiUpstream);
});

for (const autopilot of [false, true]) {
  test(`${autopilot ? "autopilot" : "optimizer"} mode: other endpoints are forwarded, binary bodies arrive intact`, async () => {
    const px = startProxy({ port: 0, ...opts, autopilot });
    await new Promise<void>((r) => px.once("listening", r));
    const P = `http://127.0.0.1:${(px.address() as AddressInfo).port}`;
    try {
      hits.length = 0;
      assert.equal((await fetch(`${P}/v1/models`, { headers: { "anthropic-version": "2023-06-01" } })).status, 200);
      assert.equal((await fetch(`${P}/v1/models`, { headers: { authorization: "Bearer sk-x" } })).status, 200);
      const bin = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 37 + 11) % 256));
      await fetch(`${P}/v1/files`, { method: "POST", headers: { "anthropic-version": "2023-06-01", "content-type": "application/octet-stream" }, body: bin });
      assert.deepEqual(hits.map((h) => `${h.who} ${h.url}`), ["anthropic /v1/models", "openai /v1/models", "anthropic /v1/files"]);
      assert.ok(hits[2].body.equals(bin), "binary body forwarded byte for byte");
    } finally {
      px.close();
    }
  });
}
