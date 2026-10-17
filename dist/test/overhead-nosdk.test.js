/**
 * dist/ with no node_modules anywhere above it: how the Claude Code plugin
 * runs (a git checkout), and what the npm package now is (it declares no
 * runtime dependencies; the MCP SDK and zod are bundled into dist/mcp.js and
 * dist/mcpclient.js). `overhead --mcp` used to note "MCP SDK not installed"
 * there; it now measures the servers, and the server itself starts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "./sandbox.js";
const dist = join(dirname(fileURLToPath(import.meta.url)), "..");
test("overhead --mcp with no node_modules measures servers through the bundled SDK client", async () => {
    // A plugin-shaped install: dist/ and package.json, no node_modules anywhere above it.
    const plugin = mkdtempSync(join(tmpdir(), "ctxdoc-plugin-"));
    const tests = join(dist, "test");
    cpSync(dist, join(plugin, "dist"), { recursive: true, filter: (src) => src !== tests && !src.startsWith(tests + sep) });
    copyFileSync(join(dist, "..", "package.json"), join(plugin, "package.json"));
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-plugin-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "ctxdoc-plugin-cwd-"));
    // The server to measure is our own, from the same dependency-free dist/.
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [join(plugin, "dist", "mcp.js")] } } }));
    const r = await new Promise((resolve) => {
        execFile(process.execPath, [join(plugin, "dist", "cli.js"), "overhead", "--mcp"], { cwd, env: sandboxEnv(home), timeout: 60_000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
    });
    assert.equal(r.code, 0, r.stderr.slice(0, 400));
    assert.match(r.stdout, /FIXED OVERHEAD/);
    assert.match(r.stdout, /demo .*\d+ tools, ~[\d.]+k? tokens of definitions/, r.stdout);
});
test("the npm package declares no runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(dist, "..", "package.json"), "utf8"));
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], "they are bundled into dist/mcp.js and dist/mcpclient.js");
    assert.ok(pkg.devDependencies["@modelcontextprotocol/sdk"] && pkg.devDependencies.zod, "still needed to build the bundles");
});
