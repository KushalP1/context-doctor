/**
 * The proxy answers only requests that name it: a web page that rebinds its
 * own host name to 127.0.0.1 (DNS rebinding) reaches the port with that name
 * in Host, and a page elsewhere sends its Origin. Both are refused before any
 * upstream call, as by the MCP server's --http (httpguard.ts). SDKs and CLIs
 * (Host 127.0.0.1:<port> or localhost:<port>, no Origin), a client in a
 * container calling by address, a configured --host or --allowed-hosts name,
 * and anything behind a token are served.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { startProxy } from "../proxy.js";
import { sandboxEnv } from "./sandbox.js";

let upstreamHits = 0;
const upstream = http.createServer((req, res) => {
  upstreamHits++;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ id: "x", choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
});
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

async function listening(opts: Parameters<typeof startProxy>[0]): Promise<{ server: http.Server; port: number }> {
  const server = startProxy({ port: 0, openaiUpstream: upstreamUrl, ...opts });
  await new Promise<void>((r) => server.once("listening", r));
  return { server, port: (server.address() as AddressInfo).port };
}

const plain = await listening({ allowedHosts: "proxy" });
const tokened = await listening({ token: "s3cret" });
after(() => { plain.server.close(); tokened.server.close(); upstream.close(); });

/** A request with the Host and Origin a browser or a client would send (fetch cannot set Host). */
function send(port: number, path: string, headers: Record<string, string>): Promise<number> {
  const body = JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: path.endsWith("/health") ? "GET" : "POST", headers: { "content-type": "application/json", authorization: "Bearer k", ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(path.endsWith("/health") ? undefined : body);
  });
}

test("a rebinding page's Host or a foreign Origin is refused before any upstream call", async () => {
  const p = plain.port;
  const before = upstreamHits;
  assert.equal(await send(p, "/v1/chat/completions", { host: `attacker.example:${p}` }), 403);
  assert.equal(await send(p, "/stats", { host: `attacker.example:${p}` }), 403);
  assert.equal(await send(p, "/v1/chat/completions", { host: `127.0.0.1:${p}`, origin: "https://attacker.example" }), 403);
  assert.equal(await send(p, "/v1/chat/completions", { host: `127.0.0.1:${p}`, origin: "http://1.2.3.4" }), 403, "a page served from an address is a foreign origin");
  assert.equal(upstreamHits, before, "nothing refused reached upstream");
  // /health stays open for probes, whatever they call the host.
  assert.equal(await send(p, "/health", { host: `attacker.example:${p}` }), 200);
});

test("SDKs and CLIs, an address, a configured name and a loopback page are served", async () => {
  const p = plain.port;
  const before = upstreamHits;
  for (const host of [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`, `10.0.0.5:${p}`, `proxy:${p}`]) {
    assert.equal(await send(p, "/v1/chat/completions", { host }), 200, host);
  }
  assert.equal(await send(p, "/v1/chat/completions", { host: `127.0.0.1:${p}`, origin: "http://localhost:3000" }), 200);
  assert.equal(upstreamHits, before + 6);
});

test("behind a token, a tunnel's host name is served (the token is the guard)", async () => {
  const p = tokened.port;
  assert.equal(await send(p, "/t/s3cret/v1/chat/completions", { host: "my-tunnel.example.dev" }), 200);
  assert.equal(await send(p, "/v1/chat/completions", { host: "my-tunnel.example.dev" }), 401);
});

test("proxy --port 0 names the port it got, not 0", async () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
  const home = mkdtempSync(join(tmpdir(), "cd-proxy-port0-"));
  const child = spawn(process.execPath, [cli, "proxy", "--port", "0"], { env: sandboxEnv(home), stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  try {
    const line = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no listening line: ${err}`)), 20_000);
      child.stderr!.on("data", (d) => {
        err += d;
        const m = /Cumulative savings: (\S+)/.exec(err);
        if (m && /listening on \S+/.test(err)) { clearTimeout(timer); resolve(err); }
      });
    });
    const port = Number(/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(line)?.[1]);
    assert.ok(port > 0, line);
    assert.match(line, new RegExp(`ANTHROPIC_BASE_URL=http://127\\.0\\.0\\.1:${port}\\b`));
    assert.match(line, new RegExp(`Cumulative savings: http://127\\.0\\.0\\.1:${port}/stats`));
  } finally {
    child.kill();
  }
});
