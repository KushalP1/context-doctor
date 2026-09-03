/**
 * A client that walks away mid-stream must not take the proxy down with it.
 *
 * Ctrl-C on a streaming request, a closed laptop lid, an SDK timeout — all
 * destroy the client socket while the proxy is still piping upstream bytes
 * into it. If that path throws, the user's proxy dies and every subsequent
 * request in every app fails.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { startProxy } from "../proxy.js";

// An upstream that streams slowly, so the client can abort mid-flight.
const upstream = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let n = 0;
    const timer = setInterval(() => {
      if (++n > 40) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(`event: chunk\ndata: {"n":${n}}\n\n`);
    }, 25);
    res.on("close", () => clearInterval(timer));
  });
});

test("the proxy survives a client that aborts mid-stream", async () => {
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const proxy = startProxy({ port: 0, anthropicUpstream: `http://127.0.0.1:${upstreamPort}` });
  await new Promise<void>((r) => proxy.once("listening", r));
  const proxyPort = (proxy.address() as AddressInfo).port;
  after(() => {
    proxy.close();
    upstream.close();
  });

  const body = JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hello" }] });
  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: proxyPort, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        // Kill the connection as soon as the first streamed byte lands.
        res.once("data", () => {
          req.destroy();
          resolve();
        });
        res.on("error", () => resolve()); // the abort surfaces here; that is the point
      }
    );
    req.on("error", () => resolve()); // ECONNRESET from our own destroy()
    req.write(body);
    req.end();
    setTimeout(() => reject(new Error("upstream never streamed")), 5000).unref?.();
  });

  // Give the proxy a moment to notice the dead socket and unwind.
  await new Promise((r) => setTimeout(r, 400));

  // The proxy must still be serving. If the abort crashed it, this hangs or refuses.
  const health = await fetch(`http://127.0.0.1:${proxyPort}/health`).then((r) => r.json() as Promise<{ ok: boolean }>);
  assert.equal(health.ok, true, "proxy must still be alive after a client abort");
});
