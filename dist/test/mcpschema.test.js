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
    const use = (name) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name, input: {} }] } });
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
    assert.equal(ok.tools, 4);
    assert.ok(ok.schemaTokens > ok.nameTokens && ok.nameTokens > 10);
    const dead = await measureServer({ name: "dead", scope: "user", command: process.execPath, args: ["-e", "setTimeout(()=>{}, 60000)"] }, 1500);
    assert.match(dead.error, /no answer/);
});
test("an unused server is flagged at full size, or at its names when tool search defers it", () => {
    const configs = [{ name: "big", scope: "user" }, { name: "used", scope: "user" }];
    const sizes = [{ name: "big", tools: 40, schemaTokens: 9000, nameTokens: 400 }, { name: "used", tools: 3, schemaTokens: 900, nameTokens: 30 }];
    const full = mcpFindings({ configs, sizes, usage: { calls: new Map([["used", 5]]), sessions: 10, toolSearchSessions: 0 } });
    assert.equal(full.length, 1);
    assert.match(full[0].message, /"big".*~9.0k tokens/);
    const deferred = mcpFindings({ configs, sizes, usage: { calls: new Map(), sessions: 10, toolSearchSessions: 9 } });
    assert.match(deferred[0].message, /~400 tokens to every request even deferred/);
});
