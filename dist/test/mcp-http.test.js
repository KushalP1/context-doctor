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
await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("HTTP MCP server did not start")), 8000);
    child.stderr.on("data", (d) => {
        if (d.toString().includes("streamable HTTP")) {
            clearTimeout(timer);
            resolve();
        }
    });
});
after(() => child.kill());
async function rpc(body) {
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
    assert.ok(json.result.instructions.includes("Context hygiene"));
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
    assert.ok(json.result.content[0].text.includes("CONTEXT DOCTOR"));
});
test("health endpoint responds; non-POST is rejected", async () => {
    const health = (await (await fetch(`http://127.0.0.1:${PORT}/health`)).json());
    assert.equal(health.ok, true);
    const get = await fetch(`http://127.0.0.1:${PORT}/mcp`);
    assert.equal(get.status, 405);
});
test("clients that do not ask for SSE get JSON instead of a 406", async () => {
    const { spawn } = await import("node:child_process");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const mcp = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp.js");
    const port = 8000 + Math.floor(Math.random() * 900);
    const child = spawn(process.execPath, [mcp, "--http", "--port", String(port)], { stdio: "ignore" });
    try {
        // Wait for the listener rather than sleeping a fixed amount.
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
        const init = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } },
        });
        // The spec says a client MUST accept both types; real ones often do not,
        // and a 406 is indistinguishable from "this server is broken".
        for (const accept of ["application/json", "*/*", undefined]) {
            const headers = { "content-type": "application/json" };
            if (accept)
                headers.accept = accept;
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
    }
    finally {
        child.kill();
    }
});
