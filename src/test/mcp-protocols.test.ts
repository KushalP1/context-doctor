/**
 * E8: the server on the MCP SDK's v2 packages answers both protocol eras.
 *
 *  - 2025-era clients open with `initialize` (Claude Desktop, Cursor, Codex,
 *    Gemini CLI, Copilot, ChatGPT; Claude Code with
 *    MCP_PROTOCOL_NEGOTIATION=legacy), at whatever 2024/2025 revision they
 *    speak;
 *  - 2026-07-28 clients (Claude Code 2.1.323's default) open with
 *    `server/discover` and stamp every request with a `_meta` envelope.
 *
 * Each is checked with a real client of its generation (the v1 SDK's, the
 * v2 SDK's in its legacy, pinned and auto modes) and with raw JSON-RPC, over
 * stdio and --http. Every server runs with a throwaway home directory.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client as V1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as V1StdioTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { handoffDir } from "../handoff.js";
import { freePort } from "./freeport.js";
import { sandboxEnv } from "./sandbox.js";

const mcpPath = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp.js");
const MODERN = "2026-07-28";
const OLD_REVISIONS = ["2024-10-07", "2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const TOOLS = ["profile_context", "optimize_context", "pack_context", "save_handoff", "recall", "context_best_practices"];
const text = (r: unknown) => ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n");
const home = (tag: string) => mkdtempSync(join(tmpdir(), `cd-e8-${tag}-`));
const stdioParams = (h: string) => ({ command: process.execPath, args: [mcpPath], env: sandboxEnv(h) as Record<string, string> });
type Mode = "legacy" | "auto" | { pin: string };
const v2 = (mode: Mode, capabilities: Record<string, unknown> = {}) => new Client({ name: "e8-v2", version: "1" }, { versionNegotiation: { mode }, capabilities });
/** The definitions as a client sends them to the model. */
const sent = (tools: Array<{ name: string; description?: string; inputSchema?: unknown }>) =>
  JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })));

// -- stdio, real clients of both generations ----------------------------------

test("stdio: the v1 SDK's client and the v2 SDK's (legacy, 2026-07-28 pinned, auto) all get the same server", async () => {
  const listings: string[] = [];
  const v1 = new V1Client({ name: "e8-v1", version: "1" });
  await v1.connect(new V1StdioTransport(stdioParams(home("v1"))));
  try {
    assert.equal(v1.getServerVersion()?.name, "context-doctor");
    assert.match(v1.getInstructions() ?? "", /^Context hygiene rules/);
    const tools = (await v1.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name), TOOLS, "the order is the registration order");
    listings.push(JSON.stringify(tools));
  } finally {
    await v1.close();
  }
  for (const [mode, era, version] of [["legacy", "legacy", "2025-11-25"], [{ pin: MODERN }, "modern", MODERN], ["auto", "modern", MODERN]] as const) {
    const client = v2(mode as Mode);
    await client.connect(new StdioClientTransport(stdioParams(home("v2"))));
    try {
      const label = JSON.stringify(mode);
      assert.equal(client.getProtocolEra(), era, label);
      assert.equal(client.getNegotiatedProtocolVersion(), version, label);
      assert.equal(client.getServerVersion()?.name, "context-doctor", label);
      assert.match(client.getInstructions() ?? "", /^Context hygiene rules/, label);
      const listed = await client.listTools();
      listings.push(JSON.stringify(listed.tools));
      if (era === "modern") {
        // A list that changes only with a release: a day in a 2026-07-28 client's cache.
        assert.equal(listed.ttlMs, 86_400_000, label);
        assert.equal(listed.cacheScope, "private", label);
      }
      assert.deepEqual((await client.listPrompts()).prompts.map((p) => p.name), ["context_checkup", "handoff", "ask_file"], label);
      const sketch = await client.callTool({ name: "profile_context", arguments: { sketch: { turns: 12, blocks: [{ turn: 2, kind: "paste", label: "log", approx_lines: 3000 }] } } });
      assert.ok(!sketch.isError && /Context estimate from sketch/.test(text(sketch)), `${label}: ${text(sketch).slice(0, 120)}`);
      const latest = await client.readResource({ uri: "handoff://latest" });
      assert.match((latest.contents[0] as { text?: string }).text ?? "", /No handoff saved yet/, label);
    } finally {
      await client.close();
    }
  }
  assert.ok(listings.every((l) => l === listings[0]), "tools/list is byte-identical in both eras and across clients");
  assert.ok(!listings[0].includes("$schema") && !listings[0].includes("9007199254740991"), "no dialect line, no safe-integer bounds");
});

test("stdio, 2026-07-28: the tool definitions keep the same budget (under 2,400 Claude tokens)", async () => {
  const client = v2({ pin: MODERN });
  await client.connect(new StdioClientTransport(stdioParams(home("budget"))));
  try {
    const s = sent((await client.listTools()).tools);
    const bound = Math.ceil(s.length / 2.1);
    assert.ok(bound <= 2400, `tool definitions are at most ${bound} Claude tokens (${s.length} chars); keep them under 2,400`);
  } finally {
    await client.close();
  }
});

test("stdio, 2026-07-28: a call over 10,000 elements is refused; a handoff saves and reads back as a resource; a bad id is refused", async () => {
  const h = home("modern-io");
  const client = v2({ pin: MODERN });
  await client.connect(new StdioClientTransport(stdioParams(h)));
  try {
    const big = await client.callTool({ name: "pack_context", arguments: { text: "a b c", ids: Array.from({ length: 10_001 }, (_, i) => `x#${i}`) } });
    assert.equal(big.isError, true);
    assert.match(text(big), /maximum/);
    const saved = await client.callTool({ name: "save_handoff", arguments: { brief: "Goal: ship E8.\nState: tests green.", title: "e8" } });
    assert.match(text(saved), /^Handoff saved: /);
    const id = text(saved).match(/Handoff saved: (\S+)/)![1];
    assert.ok(existsSync(join(handoffDir(h), id)), "written under the sandboxed home");
    const { resources } = await client.listResources();
    assert.ok(resources.some((r) => r.uri === `handoff://${id}`), resources.map((r) => r.uri).join(", "));
    assert.match((await client.readResource({ uri: "handoff://latest" })).contents[0] && ((await client.readResource({ uri: "handoff://latest" })).contents[0] as { text: string }).text, /# Handoff: e8/);
    const refused = await client.readResource({ uri: "handoff://..%2F..%2Fetc%2Fpasswd" }).then(() => "read", (e: { code?: number }) => e.code);
    assert.equal(refused, -32602);
  } finally {
    await client.close();
  }
});

test("stdio, 2026-07-28: consent travels as an input_required form and fails closed", async () => {
  const h = home("modern-consent");
  const args = { brief: "Goal: x.\nState: y.", title: "consent", verbatim: [{ label: "cfg", text: "port=8080" }] };
  const cases: Array<[unknown, RegExp]> = [
    [{ action: "decline" }, /^Not saved: the user declined/],
    [{ action: "cancel" }, /^Not saved: the user dismissed the prompt/],
    [{ action: "accept", content: { include_verbatim: "no" } }, /^Not saved: the consent form failed/],
    [{ action: "accept", content: { include_verbatim: false } }, /^Handoff saved: /],
  ];
  for (const [answer, expected] of cases) {
    const asked: string[] = [];
    const client = v2({ pin: MODERN }, { elicitation: { form: {} } });
    client.setRequestHandler("elicitation/create", async (req) => {
      asked.push(req.params.message);
      return answer as never;
    });
    await client.connect(new StdioClientTransport(stdioParams(h)));
    try {
      const r = await client.callTool({ name: "save_handoff", arguments: args });
      assert.match(text(r), expected, JSON.stringify(answer));
      assert.equal(asked.length, 1);
      assert.match(asked[0], /Save a handoff of this chat on this computer.*1 verbatim block\(s\): cfg/);
    } finally {
      await client.close();
    }
  }
  // The one accepted without its block: saved, the block left out.
  const conversation = JSON.stringify(Array.from({ length: 16 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i} `.repeat(200) })));
  for (const [answer, digest] of [[{ action: "decline" }, false], [{ action: "accept", content: { prune: true } }, true]] as const) {
    const client = v2({ pin: MODERN }, { elicitation: { form: {} } });
    client.setRequestHandler("elicitation/create", async () => answer as never);
    await client.connect(new StdioClientTransport(stdioParams(h)));
    try {
      const r = await client.callTool({ name: "optimize_context", arguments: { conversation, strategies: ["prune-history"], keep_recent: 4 } });
      assert.equal(/PRUNED TURNS DIGEST/.test(text(r)), digest, text(r).slice(0, 200));
    } finally {
      await client.close();
    }
  }
  // No elicitation declared: nothing is asked (consent was the chat's), as in the 2025 era.
  const plain = v2({ pin: MODERN });
  await plain.connect(new StdioClientTransport(stdioParams(h)));
  try {
    assert.match(text(await plain.callTool({ name: "save_handoff", arguments: { brief: "Goal: z." } })), /^Handoff saved/);
  } finally {
    await plain.close();
  }
});

// -- stdio, raw JSON-RPC ------------------------------------------------------

/** A server on stdio driven line by line, the way a hand-built client would. */
function rawStdio(h: string) {
  const child = spawn(process.execPath, [mcpPath], { env: sandboxEnv(h) }) as ChildProcessWithoutNullStreams;
  let buf = "";
  const waiting = new Map<number, (m: any) => void>();
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 10_000);
      waiting.set(n, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    });
  const notify = (method: string) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  return { send, notify, close: () => child.kill() };
}

const envelope = (capabilities: Record<string, unknown> = {}) => ({
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "raw", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": capabilities,
});

test("stdio, raw JSON-RPC: initialize at every 2024/2025 revision is answered at that revision", async () => {
  for (const revision of OLD_REVISIONS) {
    const s = rawStdio(home("raw-old"));
    try {
      const init = await s.send("initialize", { protocolVersion: revision, capabilities: {}, clientInfo: { name: "raw", version: "1" } });
      assert.equal(init.result.protocolVersion, revision);
      assert.equal(init.result.serverInfo.name, "context-doctor");
      assert.ok(init.result.capabilities.resources, "the handoff resources, on the local server");
      s.notify("notifications/initialized");
      const list = await s.send("tools/list");
      assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), TOOLS, revision);
      assert.equal(list.result.ttlMs, undefined, "no 2026 cache fields in a 2025 answer");
    } finally {
      s.close();
    }
  }
});

test("stdio, raw JSON-RPC: server/discover offers 2026-07-28, and enveloped requests are served", async () => {
  const s = rawStdio(home("raw-new"));
  try {
    const discover = await s.send("server/discover", { _meta: envelope() });
    assert.deepEqual(discover.result.supportedVersions, [MODERN]);
    assert.match(discover.result.instructions, /^Context hygiene rules/);
    assert.ok(discover.result.capabilities.tools && discover.result.capabilities.prompts && discover.result.capabilities.resources);
    assert.equal(discover.result.ttlMs, 86_400_000);
    const list = await s.send("tools/list", { _meta: envelope() });
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), TOOLS);
    assert.equal(list.result.resultType, "complete");
    const call = await s.send("tools/call", { name: "context_best_practices", arguments: { provider: "anthropic" }, _meta: envelope() });
    assert.match(call.result.content[0].text, /cache_control/);
    // Consent asked of a 2026 client that declares forms: the form comes back as the result.
    const pending = await s.send("tools/call", { name: "save_handoff", arguments: { brief: "Goal: raw." }, _meta: envelope({ elicitation: { form: {} } }) });
    assert.equal(pending.result.resultType, "input_required");
    assert.equal(pending.result.inputRequests.consent.method, "elicitation/create");
    const retried = await s.send("tools/call", { name: "save_handoff", arguments: { brief: "Goal: raw." }, inputResponses: { consent: { action: "decline" } }, _meta: envelope({ elicitation: { form: {} } }) });
    assert.match(retried.result.content[0].text, /^Not saved: the user declined/);
  } finally {
    s.close();
  }
});

// -- --http, both eras ----------------------------------------------------------

const httpHome = home("http");
const httpPort = await freePort();
const httpChild = spawn(process.execPath, [mcpPath, "--http", "--port", String(httpPort)], { stdio: ["ignore", "ignore", "pipe"], env: sandboxEnv(httpHome) });
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("HTTP MCP server did not start")), 8000);
  httpChild.stderr.on("data", (d: Buffer) => {
    if (d.toString().includes("streamable HTTP")) {
      clearTimeout(timer);
      resolve();
    }
  });
});
after(() => httpChild.kill());
const url = `http://127.0.0.1:${httpPort}/mcp`;

async function post(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...headers }, body: JSON.stringify(body) });
  const t = await res.text();
  const dataLine = t.split("\n").find((l) => l.startsWith("data: "));
  return { status: res.status, json: t ? JSON.parse(dataLine ? dataLine.slice(6) : t) : undefined };
}
const modernHeaders = (method: string) => ({ "mcp-protocol-version": MODERN, "mcp-method": method });

test("--http, raw JSON-RPC: initialize at every 2024/2025 revision; discover and enveloped calls at 2026-07-28", async () => {
  for (const revision of OLD_REVISIONS) {
    const { status, json } = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: revision, capabilities: {}, clientInfo: { name: "raw", version: "1" } } });
    assert.equal(status, 200);
    assert.equal(json.result.protocolVersion, revision);
    assert.equal(json.result.capabilities.resources, undefined, "no handoff resources over HTTP");
  }
  const discover = await post({ jsonrpc: "2.0", id: 2, method: "server/discover", params: { _meta: envelope() } }, modernHeaders("server/discover"));
  assert.equal(discover.status, 200);
  assert.deepEqual(discover.json.result.supportedVersions, [MODERN]);
  assert.match(discover.json.result.instructions, /^Context hygiene rules/);
  const list = await post({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: envelope() } }, modernHeaders("tools/list"));
  const legacyList = await post({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
  assert.deepEqual(list.json.result.tools, legacyList.json.result.tools, "the same five tools in both eras");
  assert.equal(list.json.result.tools.length, 5);
  const bound = Math.ceil(sent(list.json.result.tools).length / 2.1);
  assert.ok(bound <= 2400, `HTTP tool definitions are at most ${bound} Claude tokens; keep them under 2,400`);
  const call = await post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "profile_context", arguments: { sketch: { turns: 3, blocks: [] } }, _meta: envelope() } }, { ...modernHeaders("tools/call"), "mcp-name": "profile_context" });
  assert.equal(call.status, 200, JSON.stringify(call.json).slice(0, 300));
  assert.match(call.json.result.content[0].text, /Context estimate from sketch/);
  const big = await post({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "pack_context", arguments: { text: "a", ids: Array.from({ length: 10_001 }, (_, i) => `x#${i}`) }, _meta: envelope() } }, { ...modernHeaders("tools/call"), "mcp-name": "pack_context" });
  assert.ok(big.json.error || big.json.result?.isError, `refused: ${JSON.stringify(big.json).slice(0, 200)}`);
});

test("--http: the Host and Origin checks guard 2026-07-28 requests too; a non-JSON body is refused", async () => {
  const foreign = await post({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: envelope() } }, { ...modernHeaders("server/discover"), origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
  assert.match(foreign.json.error.message, /Origin "https:\/\/evil.example" is not allowed/);
  // fetch cannot set Host; node:http can (a DNS-rebinding page's requests carry the attacker's name).
  const { request } = await import("node:http");
  const rebound = await new Promise<number>((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: envelope() } });
    const req = request({ host: "127.0.0.1", port: httpPort, path: "/mcp", method: "POST", headers: { host: `evil.example:${httpPort}`, "content-type": "application/json", accept: "application/json", ...modernHeaders("server/discover") } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(body);
  });
  assert.equal(rebound, 403, "a foreign Host is refused for a 2026-07-28 request");
  const plain = await fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
  assert.equal(plain.status, 415);
});

test("--http: the v2 SDK's client in both eras, and the v1 SDK's, get the same tools; nothing is stored", async () => {
  const listings: string[] = [];
  for (const mode of ["legacy", { pin: MODERN }] as Mode[]) {
    const client = v2(mode);
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    try {
      assert.equal(client.getProtocolEra(), mode === "legacy" ? "legacy" : "modern");
      assert.match(client.getInstructions() ?? "", /^Context hygiene rules/);
      listings.push(JSON.stringify((await client.listTools()).tools));
      const saved = await client.callTool({ name: "save_handoff", arguments: { brief: "Goal: x." } });
      assert.match(text(saved), /not stored: this server runs over HTTP/);
    } finally {
      await client.close();
    }
  }
  const { StreamableHTTPClientTransport: V1Http } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const v1 = new V1Client({ name: "e8-v1", version: "1" });
  await v1.connect(new V1Http(new URL(url)));
  try {
    listings.push(JSON.stringify((await v1.listTools()).tools));
  } finally {
    await v1.close();
  }
  assert.ok(listings.every((l) => l === listings[0]), "byte-identical across eras and clients");
  assert.equal(existsSync(handoffDir(httpHome)), false, "an HTTP server keeps no handoffs without --store-handoffs");
});
