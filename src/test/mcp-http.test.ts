/**
 * MCP streamable-HTTP transport: spawn `mcp.js --http`, run the initialize
 * handshake and a tool call over plain HTTP, exactly as a URL-based client
 * (e.g. a ChatGPT developer-mode connector) would.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const mcpPath = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp.js");
const PORT = 8898;

const child = spawn(process.execPath, [mcpPath, "--http", "--port", String(PORT)], { stdio: ["ignore", "ignore", "pipe"] });
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("HTTP MCP server did not start")), 8000);
  child.stderr.on("data", (d: Buffer) => {
    if (d.toString().includes("streamable HTTP")) {
      clearTimeout(timer);
      resolve();
    }
  });
});

after(() => child.kill());

async function rpc(body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // Streamable HTTP may answer as SSE ("data: {...}") or plain JSON.
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  return { status: res.status, json: JSON.parse(dataLine ? dataLine.slice(6) : text) };
}

test("initialize over HTTP returns server info + instructions", async () => {
  const { status, json } = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  });
  assert.equal(status, 200);
  assert.equal(json.result.serverInfo.name, "context-doctor");
  assert.ok((json.result.instructions as string).includes("Context hygiene"));
});

test("tools/call works statelessly over HTTP", async () => {
  const { json } = await rpc({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "profile_context",
      arguments: { conversation: JSON.stringify({ messages: [{ role: "user", content: "hello world" }] }) },
    },
  });
  assert.ok((json.result.content[0].text as string).includes("CONTEXT DOCTOR"));
});

test("health endpoint responds; non-POST is rejected", async () => {
  const health = (await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()) as { ok: boolean };
  assert.equal(health.ok, true);
  const get = await fetch(`http://127.0.0.1:${PORT}/mcp`);
  assert.equal(get.status, 405);
});
