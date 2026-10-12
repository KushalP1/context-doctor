/**
 * `overhead --mcp` from the Claude Code plugin: the plugin runs dist/ from a
 * git checkout with no node_modules, so the MCP SDK cannot load. That must be
 * a note per server, not an ERR_MODULE_NOT_FOUND crash that loses the report.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "./sandbox.js";
const dist = join(dirname(fileURLToPath(import.meta.url)), "..");
test("overhead --mcp without the MCP SDK still prints the report, servers marked unmeasured", async () => {
    // A plugin-shaped install: dist/ and package.json, no node_modules anywhere above it.
    const plugin = mkdtempSync(join(tmpdir(), "ctxdoc-plugin-"));
    const tests = join(dist, "test");
    cpSync(dist, join(plugin, "dist"), { recursive: true, filter: (src) => src !== tests && !src.startsWith(tests + sep) });
    copyFileSync(join(dist, "..", "package.json"), join(plugin, "package.json"));
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-plugin-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "ctxdoc-plugin-cwd-"));
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: ["-e", "0"] } } }));
    const r = await new Promise((resolve) => {
        execFile(process.execPath, [join(plugin, "dist", "cli.js"), "overhead", "--mcp"], { cwd, env: sandboxEnv(home), timeout: 30_000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
    });
    assert.equal(r.code, 0, r.stderr.slice(0, 400));
    assert.match(r.stdout, /FIXED OVERHEAD/);
    assert.match(r.stdout, /demo .*MCP SDK not installed/);
});
