/**
 * The Claude Code plugin (.claude-plugin/) is what users get from
 * `/plugin install context-doctor@context-doctor`. Older Claude Code rejects a
 * manifest with any key it does not know (2.1.62 refused `displayName`), and
 * does not install npm dependencies, so: known keys only, every referenced
 * file exists, and the MCP server bundle runs with no node_modules at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
const market = JSON.parse(readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"));

test("plugin manifest uses only keys every supported Claude Code accepts", () => {
  const known = new Set(["name", "version", "description", "author", "homepage", "repository", "license", "keywords", "skills", "hooks", "mcpServers"]);
  for (const k of Object.keys(manifest)) assert.ok(known.has(k), `unknown manifest key ${k}`);
  assert.equal(market.plugins[0].name, manifest.name, "entry name and manifest name must match");
  assert.equal(market.plugins[0].source, "./");
});

test("every file the plugin references exists, and every skill has frontmatter", () => {
  const sub = (s: string) => s.replace("${CLAUDE_PLUGIN_ROOT}", root);
  assert.ok(existsSync(sub(manifest.mcpServers["context-doctor"].args[0])));
  const hookCmd: string = manifest.hooks.UserPromptSubmit[0].hooks[0].command;
  assert.ok(existsSync(join(root, "dist", "cli.js")) && hookCmd.includes("dist/cli.js\" hook"));
  const skillsDir = join(root, manifest.skills);
  const skills = readdirSync(skillsDir);
  assert.ok(skills.length >= 3);
  for (const s of skills) {
    const md = readFileSync(join(skillsDir, s, "SKILL.md"), "utf8");
    assert.match(md, new RegExp(`^---\\r?\\nname: ${s}\\r?\\ndescription: .{40,}`), `${s}/SKILL.md frontmatter`);
  }
});

test("the bundled MCP server answers from a directory with no node_modules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-bundle-"));
  copyFileSync(join(root, "dist", "mcp.bundle.js"), join(dir, "mcp.bundle.js"));
  const child = spawn(process.execPath, [join(dir, "mcp.bundle.js")], { stdio: ["pipe", "pipe", "ignore"], cwd: dir });
  const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
  const reply = new Promise<string>((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`no tools/list reply: ${out.slice(0, 200)}`)), 10_000);
    child.stdout.on("data", (d) => { out += d; if (out.includes('"id":2')) { clearTimeout(t); resolve(out); } });
  });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  try {
    const out = await reply;
    assert.match(out, /profile_context/);
    assert.match(out, /optimize_context/);
  } finally {
    child.kill();
  }
});
