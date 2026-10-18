/**
 * Codex through autopilot, on an API key only. Pinned: config.toml gets one
 * top-level `openai_base_url` line and nothing else changes; ChatGPT sign-in,
 * another provider or someone else's address leave the file alone; `off` and
 * the self-heal (sign-in changed to ChatGPT) take our line out; the proxy
 * answers WebSocket upgrades with 426 (Codex then uses HTTP at once) and
 * relays ChatGPT-signed-in Codex to ChatGPT's backend byte for byte.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAuthMode, routeCodex, setTopLevelString, topLevelString } from "../codexroute.js";
import { autopilotOff, autopilotPaths, ensureProxyUp, proxyUrl, type ServiceExec } from "../autopilot.js";
import { startProxy } from "../proxy.js";

const noExec: ServiceExec = () => true;
const URL_ = "http://127.0.0.1:8787/v1";
const ours = (u: string) => u === URL_;

function codexHome(auth: unknown, toml: string): string {
  const home = mkdtempSync(join(tmpdir(), "cd-codex-route-"));
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  if (auth) writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify(auth));
  writeFileSync(join(home, ".codex", "config.toml"), toml);
  return home;
}
const toml = (home: string) => readFileSync(join(home, ".codex", "config.toml"), "utf8");

const USER_TOML = `# my settings\nmodel = "gpt-5.5"\n\n[mcp_servers.other]\ncommand = "x"\nopenai_base_url = "not top level"\n`;

test("top-level keys: read before the first table, inserted there, replaced and removed in place", () => {
  assert.equal(topLevelString(USER_TOML, "model"), "gpt-5.5");
  assert.equal(topLevelString(USER_TOML, "openai_base_url"), undefined, "a key inside a table is not top level");
  const set = setTopLevelString(USER_TOML, "openai_base_url", URL_);
  assert.equal(set, `# my settings\nmodel = "gpt-5.5"\n\nopenai_base_url = "${URL_}"\n[mcp_servers.other]\ncommand = "x"\nopenai_base_url = "not top level"\n`);
  assert.equal(topLevelString(set, "openai_base_url"), URL_);
  assert.equal(setTopLevelString(set, "openai_base_url", undefined), USER_TOML, "removing gives the user's file back");
  assert.equal(topLevelString(`'openai_base_url' = 'http://x/v1' # gateway\n`, "openai_base_url"), "http://x/v1");
  assert.equal(setTopLevelString("", "openai_base_url", URL_), `openai_base_url = "${URL_}"`);
});

test("routeCodex: an API key is routed; ChatGPT sign-in, another provider and another address are left alone", () => {
  const key = codexHome({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test" }, USER_TOML);
  const r = routeCodex(key, URL_, ours);
  assert.equal(r.routed, true);
  assert.match(r.line!, /Codex \(API key\) routed/);
  assert.equal(topLevelString(toml(key), "openai_base_url"), URL_);
  assert.equal(readFileSync(join(key, ".codex", "config.toml.context-doctor.backup"), "utf8"), USER_TOML);

  const chatgpt = codexHome({ auth_mode: "chatgpt", tokens: {} }, USER_TOML);
  const c = routeCodex(chatgpt, URL_, ours);
  assert.equal(c.routed, false);
  assert.match(c.line!, /signs in with ChatGPT: left untouched/);
  assert.equal(toml(chatgpt), USER_TOML);

  const provider = codexHome({ auth_mode: "apikey" }, `model_provider = "azure"\n${USER_TOML}`);
  assert.equal(routeCodex(provider, URL_, ours).routed, false);
  const gateway = codexHome({ auth_mode: "apikey" }, `openai_base_url = "https://gateway.example/v1"\n`);
  assert.match(routeCodex(gateway, URL_, ours).line!, /already sends its requests to https:\/\/gateway\.example\/v1/);
  assert.equal(toml(gateway), `openai_base_url = "https://gateway.example/v1"\n`);

  assert.equal(codexAuthMode(join(mkdtempSync(join(tmpdir(), "cd-none-")), ".codex")), undefined);
  assert.equal(routeCodex(mkdtempSync(join(tmpdir(), "cd-nocodex-")), URL_, ours).line, undefined, "no Codex: nothing to say");
});

test("autopilot off takes our line out of config.toml and leaves the rest", async () => {
  const home = codexHome({ auth_mode: "apikey" }, setTopLevelString(USER_TOML, "openai_base_url", URL_));
  const paths = autopilotPaths(home);
  writeFileSync(paths.config, JSON.stringify({ port: 8787, codexRouted: true, node: process.execPath, cli: "/x" }));
  const lines = await autopilotOff(paths, noExec);
  assert.equal(toml(home), USER_TOML);
  assert.match(lines.join("\n"), /Codex no longer routed/);
});

test("self-heal: signed in with ChatGPT since autopilot on, Codex is taken off the proxy before its next session", async () => {
  const px = startProxy({ port: 0, autopilot: true });
  await new Promise<void>((r) => px.once("listening", r));
  const port = (px.address() as AddressInfo).port;
  try {
    const url = `${proxyUrl(port)}/v1`;
    const home = codexHome({ auth_mode: "chatgpt", tokens: {} }, setTopLevelString(USER_TOML, "openai_base_url", url));
    const paths = autopilotPaths(home);
    writeFileSync(paths.config, JSON.stringify({ port, codexRouted: true, node: process.execPath, cli: "/x" }));
    await ensureProxyUp(paths, noExec);
    assert.equal(toml(home), USER_TOML);
    assert.equal(JSON.parse(readFileSync(paths.config, "utf8")).codexRouted, undefined);
  } finally {
    px.close();
  }
});

test("proxy: a WebSocket upgrade gets 426 at once, so Codex falls back to HTTP; ChatGPT-signed-in Codex is relayed unedited", async () => {
  const seen: Array<{ url?: string; body: string; account?: string }> = [];
  const up = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      seen.push({ url: req.url, body: b, account: req.headers["chatgpt-account-id"] as string | undefined });
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
  });
  await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
  const upstream = `http://127.0.0.1:${(up.address() as AddressInfo).port}`;
  const px = startProxy({ port: 0, autopilot: true, openaiUpstream: upstream, chatgptUpstream: `${upstream}/backend-api/codex` });
  await new Promise<void>((r) => px.once("listening", r));
  const port = (px.address() as AddressInfo).port;
  try {
    const sock = net.connect(port, "127.0.0.1");
    sock.write(`GET /v1/responses HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    const answer = await new Promise<string>((r) => sock.once("data", (d) => r(String(d))));
    assert.match(answer, /^HTTP\/1\.1 426 Upgrade Required/);
    assert.match(answer, /Connection: close/i);
    sock.destroy();
    assert.equal(seen.length, 0, "nothing goes upstream for an upgrade");

    // A long, stale history autopilot would otherwise consider: relayed byte for byte.
    const body = JSON.stringify({ model: "gpt-5.5", stream: false, input: [{ role: "user", content: "x ".repeat(5000) }, { type: "function_call_output", call_id: "c1", output: "y ".repeat(20000) }] });
    const r = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer eyJ.fake.jwt", "chatgpt-account-id": "acct-1" }, body });
    assert.equal(r.status, 200);
    assert.equal(seen[0].url, "/backend-api/codex/responses", "ChatGPT's Codex path, without the /v1");
    assert.equal(seen[0].body, body);
    assert.equal(seen[0].account, "acct-1");
    // An API-key request still goes to OpenAI's API.
    await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-test" }, body: JSON.stringify({ model: "gpt-5.5", input: "hi" }) });
    assert.equal(seen[1].url, "/v1/responses");
  } finally {
    px.close();
    up.close();
  }
});
