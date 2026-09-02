/** doctor must always produce a diagnosis and exit 0, even on a bare machine. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
test("doctor runs, checks the MCP handshake, and exits 0", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ctxdoc-doctor-"));
    const out = await new Promise((resolve, reject) => {
        execFile(process.execPath, [cliPath, "doctor"], { env: { ...process.env, CONTEXT_DOCTOR_HOOK_STATE: join(stateDir, "state.json") }, timeout: 20000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    assert.ok(out.includes("CONTEXT DOCTOR — self-check"));
    assert.ok(out.includes("MCP server handshake"));
    assert.ok(/✓ MCP server handshake/.test(out), "our own server must pass its own handshake");
    assert.ok(out.includes("Ledger"));
});
test("install never writes a version-pinned node binary into configs", async () => {
    const { mkdtempSync, mkdirSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFile } = await import("node:child_process");
    // A sandbox HOME so the developer's real config is never touched.
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-home-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".cursor"), { recursive: true });
    await new Promise((resolve, reject) => {
        execFile(process.execPath, [cliPath, "install"], { env: { ...process.env, HOME: home } }, (err) => err ? reject(err) : resolve());
    });
    const config = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    const entry = config.mcpServers["context-doctor"];
    // process.execPath is version-pinned on Homebrew/nvm/asdf: a Node upgrade
    // deletes that path and every config we wrote breaks silently.
    assert.notEqual(entry.command, process.execPath, "must not pin the running node binary");
    assert.ok(["node", "npx"].includes(entry.command), `expected node or npx, got ${entry.command}`);
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    const hookCmd = settings.hooks.UserPromptSubmit[0].hooks[0].command;
    assert.ok(!hookCmd.includes(process.execPath), "hook must not pin the running node binary either");
    assert.match(hookCmd, /^(node|npx)\b/, "hook resolves its runtime from PATH");
});
