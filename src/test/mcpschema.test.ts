/** MCP schema tax: usage per server from transcripts, sizes from the servers themselves, findings for unused ones. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeMcpConfigs, mcpUsage, measureServer, toolPrefixName } from "../mcpschema.js";
import { mcpFindings } from "../overhead.js";

test("usage counts calls per server and the sessions that used tool search", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-mcp-"));
  const use = (name: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name, input: {} }] } });
  writeFileSync(join(dir, "a.jsonl"), [use("mcp__github__create_issue"), use("mcp__github__list_prs"), use("ToolSearch")].join("\n"));
  writeFileSync(join(dir, "b.jsonl"), [use("mcp__my_db__query"), use("Read")].join("\n"));
  const u = mcpUsage(30, [join(dir, "a.jsonl"), join(dir, "b.jsonl")]);
  assert.equal(u.calls.get("github"), 2);
  assert.equal(u.calls.get("my_db"), 1);
  assert.equal(u.sessions, 2);
  assert.equal(u.toolSearchSessions, 1);
  assert.equal(toolPrefixName("my.db"), "my_db");
});

test("configs come from user and project scope in ~/.claude.json and from .mcp.json", () => {
  const home = mkdtempSync(join(tmpdir(), "cd-mcp-home-"));
  const proj = mkdtempSync(join(tmpdir(), "cd-mcp-proj-"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { a: { command: "x" } }, projects: { [proj]: { mcpServers: { b: { type: "http", url: "http://h/mcp" } } } } }));
  writeFileSync(join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { c: { command: "y" } } }));
  assert.deepEqual(claudeMcpConfigs(proj, home).map((c) => `${c.name}:${c.scope}`), ["a:user", "b:project", "c:.mcp.json"]);
});

test("a real server is sized by listing its tools; a dead one reports an error instead of hanging", async () => {
  const ok = await measureServer({ name: "context-doctor", scope: "user", command: process.execPath, args: ["dist/mcp.js"] });
  assert.equal(ok.tools, 6);
  assert.ok(ok.schemaTokens! > ok.nameTokens! && ok.nameTokens! > 10);
  const dead = await measureServer({ name: "dead", scope: "user", command: process.execPath, args: ["-e", "setTimeout(()=>{}, 60000)"] }, 1500);
  assert.match(dead.error!, /no answer/);
});

test("an unused server is flagged at full size, or at its names when tool search defers it", () => {
  const configs = [{ name: "big", scope: "user" as const }, { name: "used", scope: "user" as const }];
  const sizes = [{ name: "big", tools: 40, schemaTokens: 9000, nameTokens: 400 }, { name: "used", tools: 3, schemaTokens: 900, nameTokens: 30 }];
  const full = mcpFindings({ configs, sizes, usage: { calls: new Map([["used", 5]]), names: new Map([["mcp__used__run", 5]]), resources: new Map(), sessions: 10, toolSearchSessions: 0 } });
  assert.equal(full.length, 1);
  assert.match(full[0].message, /"big".*~9.0k tokens/);
  const deferred = mcpFindings({ configs, sizes, usage: { calls: new Map(), names: new Map(), resources: new Map(), sessions: 10, toolSearchSessions: 9 } });
  assert.match(deferred[0].message, /~400 tokens to every request even deferred/);
});

// -- N5: a server whose tool list changes between listings ------------------

test("toolListChange tells order from content", async () => {
  const { toolListChange } = await import("../mcpschema.js");
  const a = { name: "a", description: "A", inputSchema: { type: "object" } };
  const b = { name: "b", description: "B", inputSchema: { type: "object" } };
  assert.equal(toolListChange([a, b], [a, b]), undefined);
  assert.equal(toolListChange([a, b], [b, a]), "order");
  assert.equal(toolListChange([a, b], [a, { ...b, description: "B at 12:01" }]), "content");
  assert.equal(toolListChange([a, b], [a]), "content");
});

test("overhead --mcp flags a server that lists its tools in another order the second time", async () => {
  // A minimal stdio MCP server, no SDK: answers initialize, then alternates its tool order.
  const dir = mkdtempSync(join(tmpdir(), "cd-mcp-shuffle-"));
  const script = join(dir, "server.mjs");
  writeFileSync(
    script,
    `import { createInterface } from "node:readline";
let n = 0;
const tools = [{ name: "a", description: "A", inputSchema: { type: "object" } }, { name: "b", description: "B", inputSchema: { type: "object" } }];
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "shuffle", version: "1" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: n++ % 2 ? [...tools].reverse() : tools } });
  else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
`
  );
  const shuffled = await measureServer({ name: "shuffle", scope: "user", command: process.execPath, args: [script] });
  assert.equal(shuffled.unstable, "order", JSON.stringify(shuffled));
  const ours = await measureServer({ name: "context-doctor", scope: "user", command: process.execPath, args: ["dist/mcp.js"] });
  assert.equal(ours.unstable, undefined);
  const findings = mcpFindings({ configs: [{ name: "shuffle", scope: "user" }], sizes: [shuffled], usage: { calls: new Map([["shuffle", 3]]), names: new Map(), resources: new Map(), sessions: 5, toolSearchSessions: 0 } });
  assert.equal(findings.length, 1, "flagged even though it is used");
  assert.match(findings[0].message, /in a different order.*tools_changed/);
  assert.match(findings[0].suggestion ?? "", /deterministic tools\/list order/);
});
