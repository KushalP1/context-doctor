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
import { freePort } from "./freeport.js";

const mcpPath = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp.js");
const PORT = await freePort();

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

test("every tool is annotated read-only, so clients that gate on approval (Codex exec) can run it", async () => {
  // Over HTTP save_handoff stores nothing (no --store-handoffs), so it is read-only too.
  const { json } = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
  const tools = json.result.tools as Array<{ name: string; annotations?: Record<string, unknown> }>;
  assert.equal(tools.length, 5);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true, `${t.name} readOnlyHint`);
    assert.equal(t.annotations?.destructiveHint, false, `${t.name} destructiveHint`);
    assert.equal(t.annotations?.openWorldHint, false, `${t.name} openWorldHint`);
  }
});

test("health endpoint responds; non-POST is rejected", async () => {
  const health = (await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()) as { ok: boolean };
  assert.equal(health.ok, true);
  const get = await fetch(`http://127.0.0.1:${PORT}/mcp`);
  assert.equal(get.status, 405);
});

test("clients that do not ask for SSE get JSON instead of a 406", async () => {
  const { spawn } = await import("node:child_process");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const mcp = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp.js");
  const port = await freePort();
  const child = spawn(process.execPath, [mcp, "--http", "--port", String(port)], { stdio: "ignore" });
  try {
    // Wait for the listener rather than sleeping a fixed amount.
    const deadline = Date.now() + 15000;
    for (;;) {
      try {
        await fetch(`http://127.0.0.1:${port}/health`);
        break;
      } catch {
        if (Date.now() > deadline) throw new Error("http server never came up");
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    const init = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } },
    });
    // The spec says a client MUST accept both types; real ones often do not,
    // and a 406 is indistinguishable from "this server is broken".
    for (const accept of ["application/json", "*/*", undefined]) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (accept) headers.accept = accept;
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers, body: init });
      assert.equal(res.status, 200, `Accept: ${accept ?? "(none)"} must be served, not refused`);
      const body = await res.text();
      assert.ok(body.includes("context-doctor"), `Accept: ${accept ?? "(none)"} must complete the handshake`);
      assert.ok(!body.startsWith("event:"), "a client that did not ask for a stream should not get one");
    }

    // And a spec-correct client still gets the streaming form.
    const sse = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: init,
    });
    assert.ok((await sse.text()).startsWith("event:"), "SSE clients keep SSE");
  } finally {
    child.kill();
  }
});

test("the standing instruction is action-shaped and small, and the checkup prompt is exposed", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const mcp = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp.js");

  const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcp] }));
  try {
    const instructions = client.getInstructions() ?? "";
    // On Claude Desktop this string is the only thing that reaches the model
    // unprompted. It must tell the model WHEN to act, and stay cheap.
    assert.match(instructions, /call profile_context .*BEFORE answering/i, "a condition-and-action, not an offer");
    assert.match(instructions, /~30 turns/);
    assert.match(instructions, /Do not estimate token counts yourself/);
    assert.ok(instructions.length <= 700, `instructions ride in every chat; ${instructions.length} chars is too many`);
    // ChatGPT's guide: keep what matters most in the first 512 characters.
    const head = instructions.slice(0, 512);
    assert.match(head, /^Context hygiene rules/);
    for (const must of [/call profile_context .*BEFORE answering/, /~30 turns/, /Do not estimate token counts yourself/, /When a chat grows long, offer a handoff once/, /save_handoff/, /over ~2k tokens/, /inline base64\./]) assert.match(head, must);
    // ...and those 512 stand alone: they end exactly at the end of a rule, so a
    // client that keeps only them cuts no rule mid-sentence.
    assert.ok(instructions.length <= 512 || instructions[511] === "\n" || instructions[512] === "\n", `character 512 falls inside a rule: ${JSON.stringify(instructions.slice(490, 530))}`);
    assert.match(head.trimEnd(), /\.$/);
    // The handoff comes right after the measuring rule, not last.
    assert.ok(instructions.indexOf("handoff") < instructions.indexOf("over ~2k tokens"));

    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name), ["context_checkup", "handoff", "ask_file"]);
    const got = await client.getPrompt({ name: "context_checkup", arguments: {} });
    const text = (got.messages[0]?.content as { text?: string }).text ?? "";
    assert.match(text, /profile_context/);
    assert.match(text, /Do not re-quote/);
  } finally {
    await client.close();
  }
});

test("the tool definitions stay small: they ride on every request in clients that load them up front", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const { estimateTokens } = await import("../tokens.js");
  const client = new Client({ name: "size-check", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/mcp.js"] }));
  try {
    const { tools } = await client.listTools();
    // Counted as an upper bound, not an estimate: the definitions exactly as
    // a client sends them to the model, at the densest Claude tokenization
    // measured on code and JSON (2.1 chars/token, the p10 in docs/tokenizer.md).
    const sent = JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })));
    const bound = Math.ceil(sent.length / 2.1);
    assert.ok(bound <= 2400, `tool definitions are at most ${bound} Claude tokens (${sent.length} chars); keep them under 2,400`);
    assert.ok(estimateTokens(sent, "claude") <= bound);
    assert.ok(!sent.includes("$schema"), "the schema dialect line is left out");
  } finally {
    await client.close();
  }
});

test("profile_context: both inputs get a note; a label that is really content is cut to a name", async () => {
  const longLabel = "the full nginx config " + "server { listen 80; } ".repeat(200);
  const { json } = await rpc({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "profile_context",
      arguments: {
        conversation: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
        sketch: { turns: 12, blocks: [{ turn: 2, kind: "paste", label: longLabel, approx_tokens: 9000, repeated: 3 }] },
      },
    },
  });
  const text = json.result.content[0].text as string;
  assert.match(text, /both `conversation` and `sketch` were passed; profiled the sketch only/);
  assert.ok(!text.includes(longLabel.slice(0, 200)), "the long label is not echoed whole");
  assert.match(text, /the full nginx config/);
  assert.ok(text.length < 3000, `short output (${text.length} chars)`);
});

test("bounds the schema no longer spells out are checked by the tools themselves", async () => {
  const call = async (name: string, args: unknown) => (await rpc({ jsonrpc: "2.0", id: 91, method: "tools/call", params: { name, arguments: args } })).json.result;
  const turns = await call("profile_context", { sketch: { turns: 200_000, blocks: [] } });
  assert.equal(turns.isError, true);
  assert.match(turns.content[0].text, /turns is 200000/);
  const zero = await call("profile_context", { sketch: { turns: 3, blocks: [{ turn: 1, kind: "paste", label: "x", approx_tokens: 0 }] } });
  assert.match(zero.content[0].text, /approx_tokens is 0; a size is above 0/);
  const many = await call("pack_context", { text: "hello world", query: "hello", ids: Array.from({ length: 201 }, (_, i) => `text#${i}`) });
  assert.match(many.content[0].text, /201 ids; ask for at most 200/);
  const budget = await call("pack_context", { text: "hello world", query: "hello", max_tokens: 300_000 });
  assert.match(budget.content[0].text, /the most is 200000/);
});
