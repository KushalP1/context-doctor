/**
 * A proxied stream ends the way the real one would. Pinned:
 *  - a client that walks away cancels the upstream request (it used to run
 *    to the end: client gone at 0.1 s, upstream streaming until 3 s);
 *  - an upstream that dies mid-body cuts the client's connection instead of
 *    appending a JSON error to a 200 and ending cleanly;
 *  - SIGTERM lets a stream in flight finish before the process exits (a
 *    service restart used to cut every open stream).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { startProxy } from "../proxy.js";
import { freePort } from "./freeport.js";

const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));

/** An upstream that streams `chunks` SSE events `everyMs` apart and records how far it got. */
function slowUpstream(chunks: number, everyMs: number) {
  const state = { written: 0, closedAt: 0, start: 0 };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      state.start = Date.now();
      res.writeHead(200, { "content-type": "text/event-stream" });
      let n = 0;
      const timer = setInterval(() => {
        if (++n > chunks) { clearInterval(timer); res.end(); return; }
        state.written = n;
        res.write(`event: chunk\ndata: {"n":${n}}\n\n`);
      }, everyMs);
      res.on("close", () => { clearInterval(timer); state.closedAt = Date.now(); });
    });
  });
  return { server, state };
}

test("a client that disconnects cancels the upstream request", async () => {
  const { server: up, state } = slowUpstream(30, 100);
  const proxy = startProxy({ port: 0, anthropicUpstream: `http://127.0.0.1:${await listen(up)}` });
  await new Promise<void>((r) => proxy.once("listening", r));
  try {
    let abortedAt = 0;
    await new Promise<void>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: (proxy.address() as AddressInfo).port, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json" } }, (res) => {
        res.once("data", () => { abortedAt = Date.now(); req.destroy(); resolve(); });
      });
      req.on("error", () => undefined);
      req.end(JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }));
    });
    await new Promise((r) => setTimeout(r, 800));
    assert.ok(state.closedAt > 0, "upstream connection closed after the client left");
    assert.ok(state.closedAt - abortedAt < 500, `closed ${state.closedAt - abortedAt} ms after the client left`);
    assert.ok(state.written < 30, `upstream stopped at chunk ${state.written} of 30`);
  } finally {
    proxy.close();
    up.close();
  }
});

test("an upstream that dies mid-body is a failed response for the client, not a clean 200", async () => {
  const up = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: message_start\ndata: {"type":"message_start"}\n\n`);
      setTimeout(() => res.socket?.destroy(), 100);
    });
  });
  const proxy = startProxy({ port: 0, anthropicUpstream: `http://127.0.0.1:${await listen(up)}` });
  await new Promise<void>((r) => proxy.once("listening", r));
  try {
    const r = await fetch(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 200, "the status was already on its way");
    await assert.rejects(r.text(), "reading the body fails, as it would against the real upstream");
    const health = await fetch(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}/health`).then((x) => x.json() as Promise<{ ok: boolean }>);
    assert.equal(health.ok, true, "the proxy itself is fine");
  } finally {
    proxy.close();
    up.close();
  }
});

test("SIGTERM lets a stream in flight finish, then the proxy exits 0", { skip: process.platform === "win32" }, async () => {
  const { server: up } = slowUpstream(10, 100);
  const upPort = await listen(up);
  const port = await freePort();
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  const child = spawn(process.execPath, [cli, "proxy", "--port", String(port), "--upstream-anthropic", `http://127.0.0.1:${upPort}`], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stderr!.on("data", (d) => /listening/.test(String(d)) && resolve());
      child.once("exit", () => reject(new Error("proxy exited before listening")));
    });
    const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }) });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const first = await reader.read();
    text += dec.decode(first.value);
    child.kill("SIGTERM");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    assert.equal((text.match(/event: chunk/g) ?? []).length, 10, "all 10 chunks arrived after the SIGTERM");
    assert.equal(await exited, 0);
  } finally {
    child.kill("SIGKILL");
    up.close();
  }
});
