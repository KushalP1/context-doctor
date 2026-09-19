/**
 * The server driven by the OFFICIAL MCP client, over both transports — the way
 * Claude Desktop, Claude Code and Cursor (stdio) and remote connectors (HTTP)
 * actually connect. Lived in a scratch script for weeks; a scratch script is
 * not coverage.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const mcpPath = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp.js");
const conversation = JSON.stringify({
    model: "claude-sonnet-5",
    messages: [
        { role: "user", content: "analyse this ".repeat(200) },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "row | ".repeat(3000) }] },
        { role: "user", content: "analyse this ".repeat(200) },
        ...Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i}` })),
    ],
});
async function exercise(client) {
    assert.ok((client.getInstructions() ?? "").length > 100, "standing instructions must reach the client — that is what makes plain chat work");
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["context_best_practices", "optimize_context", "profile_context"]);
    const profile = await client.callTool({ name: "profile_context", arguments: { conversation, model: "claude-sonnet-5" } });
    const profileText = profile.content.map((c) => c.text ?? "").join("\n");
    assert.match(profileText, /CONTEXT DOCTOR — profile/);
    assert.match(profileText, /Tool result at message #2/, "the oversized tool result is found");
    assert.ok(!/NaN|undefined/.test(profileText));
    const optimized = await client.callTool({ name: "optimize_context", arguments: { conversation } });
    const summary = optimized.content[0]?.text ?? "";
    assert.match(summary, /Saved ~[\d.]+k? tokens/, "optimize reports a saving");
    const tips = await client.callTool({ name: "context_best_practices", arguments: { provider: "anthropic" } });
    assert.match(tips.content[0]?.text ?? "", /cache_control/);
}
test("stdio: the transport Claude Desktop, Claude Code and Cursor use", async () => {
    const client = new Client({ name: "e2e", version: "1" }, { capabilities: {} });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpPath] }));
    try {
        await exercise(client);
    }
    finally {
        await client.close();
    }
});
test("streamable HTTP: the transport remote connectors use", async () => {
    const port = 8300 + Math.floor(Math.random() * 500);
    const child = spawn(process.execPath, [mcpPath, "--http", "--port", String(port)], { stdio: "ignore" });
    try {
        const deadline = Date.now() + 15000;
        for (;;) {
            try {
                await fetch(`http://127.0.0.1:${port}/health`);
                break;
            }
            catch {
                if (Date.now() > deadline)
                    throw new Error("http server never came up");
                await new Promise((r) => setTimeout(r, 150));
            }
        }
        const client = new Client({ name: "e2e-http", version: "1" }, { capabilities: {} });
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
        try {
            await exercise(client);
        }
        finally {
            await client.close();
        }
    }
    finally {
        child.kill();
    }
});
