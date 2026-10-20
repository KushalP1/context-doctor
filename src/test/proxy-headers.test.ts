/** The proxy forwards every value of a repeated header, and refuses a body past its cap with 413 instead of buffering it. */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { startProxy } from "../proxy.js";

async function withProxy(opts: Parameters<typeof startProxy>[0], fn: (proxyPort: number, seen: { headers?: http.IncomingHttpHeaders; bytes: number }) => Promise<void>): Promise<void> {
  const seen: { headers?: http.IncomingHttpHeaders; bytes: number } = { bytes: 0 };
  const upstream = http.createServer((req, res) => {
    seen.headers = req.headers;
    req.on("data", (c) => (seen.bytes += c.length));
    req.on("end", () => {
      res.setHeader("set-cookie", ["a=1; Path=/", "b=2; Path=/"]);
      res.setHeader("x-multi", ["one", "two"]);
      res.setHeader("content-type", "application/json");
      res.end('{"usage":{"input_tokens":1,"output_tokens":1}}');
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const proxy = startProxy({ ...opts, port: 0, anthropicUpstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` });
  await new Promise<void>((r) => proxy.once("listening", () => r()));
  try {
    await fn((proxy.address() as AddressInfo).port, seen);
  } finally {
    proxy.close();
    upstream.close();
  }
}

function post(port: number, body: string | Buffer, headers: Record<string, string | string[]> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json", "x-api-key": "sk-test-not-real", ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("every Set-Cookie (and every value of a repeated header) reaches the client", async () => {
  await withProxy({}, async (port, seen) => {
    const r = await post(port, JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }), { "x-trace": ["t1", "t2"] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.headers["set-cookie"], ["a=1; Path=/", "b=2; Path=/"]);
    assert.match(String(r.headers["x-multi"]), /one.*two/);
    assert.match(String(seen.headers?.["x-trace"]), /t1.*t2/, "repeated request headers are forwarded too");
  });
});

test("a body past the cap gets 413 and never reaches upstream", async () => {
  await withProxy({ maxBodyBytes: 64 * 1024 }, async (port, seen) => {
    const big = JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "x".repeat(200 * 1024) }] });
    const r = await post(port, big);
    assert.equal(r.status, 413);
    assert.match(r.text, /request body over/);
    assert.equal(seen.headers, undefined, "upstream never called");
    const ok = await post(port, JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "small" }] }));
    assert.equal(ok.status, 200);
  });
});

test("a chunked body (no content-length) past the cap gets 413 too", async () => {
  await withProxy({ maxBodyBytes: 64 * 1024 }, async (port) => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      for (let i = 0; i < 10; i++) req.write("y".repeat(20 * 1024));
      req.end();
    });
    assert.equal(status, 413);
  });
});
