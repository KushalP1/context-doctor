/**
 * The Claude Code plugin and `install` both give Claude Code our MCP server,
 * skill and hooks. With both, every session loads the server's instructions
 * and tools twice. install must leave Claude Code to the plugin, and doctor
 * must say so when an earlier install is still there.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "./sandbox.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function run(home: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, ...args], { env: sandboxEnv(home), timeout: 30_000 }, (error, stdout, stderr) =>
      resolve({ code: error ? (error as { code?: number }).code ?? 1 : 0, out: stdout, err: stderr })
    );
  });
}

/** The key Claude Code writes for our plugin, from our own marketplace file. */
function pluginKey(): string {
  const market = JSON.parse(readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"));
  return `${market.plugins[0].name}@${market.name}`;
}

function homeWith(settings: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "ctxdoc-plugin-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".cursor"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(settings));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ numStartups: 3 }));
  return home;
}

test("the marketplace names the plugin context-doctor@context-doctor", () => {
  assert.equal(pluginKey(), "context-doctor@context-doctor");
});

test("install leaves Claude Code to an enabled plugin, says why, and still wires the other apps", async () => {
  const home = homeWith({ enabledPlugins: { [pluginKey()]: true }, theme: "dark" });
  const r = await run(home, ["install"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Claude Code: skipped the MCP server, skill and hooks/);
  assert.match(r.out, /plugin is enabled/);
  assert.match(r.out, /twice/);
  assert.equal(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers?.["context-doctor"], undefined, "no second MCP server");
  const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.hooks, undefined, "no second hook");
  assert.ok(!existsSync(join(home, ".claude", "skills", "context-doctor")), "no second skill");
  assert.ok(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers["context-doctor"], "Cursor is still wired");
});

test("a disabled plugin is not a reason to skip Claude Code", async () => {
  const home = homeWith({ enabledPlugins: { [pluginKey()]: false } });
  const r = await run(home, ["install"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(!/skipped the MCP server/.test(r.out));
  assert.ok(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers["context-doctor"]);
  assert.ok(existsSync(join(home, ".claude", "skills", "context-doctor", "SKILL.md")));
});

test("doctor warns when the plugin and an install are both active, and install names the leftovers", async () => {
  // Installed first, plugin enabled afterwards: the common way to end up with both.
  const home = homeWith({});
  assert.equal((await run(home, ["install"])).code, 0);
  const settingsPath = join(home, ".claude", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  writeFileSync(settingsPath, JSON.stringify({ ...settings, enabledPlugins: { [pluginKey()]: true } }));

  const d = await run(home, ["doctor"]);
  assert.match(d.out, /! Plugin \+ install\s+.*plugin is enabled.*load twice/);
  assert.match(d.out, /MCP server in ~\/\.claude\.json/);
  assert.match(d.out, /context-doctor uninstall/);

  const again = await run(home, ["install"]);
  assert.match(again.out, /earlier install is still in place/);

  // Plugin only: no warning.
  const clean = homeWith({ enabledPlugins: { [pluginKey()]: true } });
  const d2 = await run(clean, ["doctor"]);
  assert.ok(!/Plugin \+ install/.test(d2.out), d2.out);
});
