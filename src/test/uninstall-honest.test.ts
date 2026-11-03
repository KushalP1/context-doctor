/**
 * uninstall takes out what install put in, and says what it did: files
 * install created are deleted once they hold nothing (not left as
 * {"mcpServers":{}}), containers it added go, the user's own content and
 * the backups of their originals stay (and are listed), and a machine with
 * nothing installed is told so instead of a bare "Done.".
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

function run(home: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, ...args], { env: sandboxEnv(home), timeout: 30_000 }, (error, stdout, stderr) =>
      resolve({ code: error ? (error as { code?: number }).code ?? 1 : 0, out: stdout, err: stderr })
    );
  });
}

const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

function apps(): string {
  const home = mkdtempSync(join(tmpdir(), "ctxdoc-unin-"));
  for (const d of [".claude", ".cursor", ".codex"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }));
  return home;
}

test("nothing installed: says so, not a bare Done.", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxdoc-unin-none-"));
  const r = await run(home, ["uninstall"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), "Nothing of context-doctor's was installed.");
});

test("files install created are deleted once empty; the user's file loses only what install added", async () => {
  const home = apps();
  assert.equal((await run(home, ["install", "--statusline"])).code, 0);
  const r = await run(home, ["uninstall"]);
  assert.equal(r.code, 0, r.err);
  for (const f of [".claude.json", ".cursor/mcp.json", ".cursor/hooks.json", ".codex/config.toml", ".codex/hooks.json"]) {
    assert.ok(!existsSync(join(home, f)), `${f}: install created it and it holds nothing now`);
  }
  assert.match(r.out.replace(/\\/g, "/"), /Deleted files install had created, now empty: .*~\/\.cursor\/mcp\.json/);
  assert.deepEqual(json(join(home, ".claude", "settings.json")), { theme: "dark" }, "no hooks: {} left behind");
  // The backup of the original is kept, untouched, and named.
  const backup = join(home, ".claude", "settings.json.context-doctor.backup");
  assert.deepEqual(json(backup), { theme: "dark" });
  assert.match(r.out.replace(/\\/g, "/"), /Backups install made of your configs.*kept:\n {2}~\/\.claude\/settings\.json\.context-doctor\.backup/);
  assert.match(r.out, /Done\./);
  assert.ok(!existsSync(join(home, ".claude", "skills", "context-doctor")));
});

test("install run twice: the second backup holds our own write, and the file is still recognised as ours", async () => {
  const home = apps();
  await run(home, ["install"]);
  await run(home, ["install"]);
  assert.ok(existsSync(join(home, ".cursor", "mcp.json.context-doctor.backup")), "fixture: the second run backed up our own file");
  await run(home, ["uninstall"]);
  assert.ok(!existsSync(join(home, ".cursor", "mcp.json")));
});

test("a config that existed before install keeps its shape, empty containers included", async () => {
  const home = apps();
  writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: {} }));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ numStartups: 3 }));
  await run(home, ["install"]);
  const r = await run(home, ["uninstall"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(json(join(home, ".cursor", "mcp.json")), { mcpServers: {} }, "the user's own (empty) file stays");
  assert.deepEqual(json(join(home, ".claude.json")), { numStartups: 3 }, "mcpServers was ours to remove");
});

test("only the SKILL.md install copied is removed from the skill folder", async () => {
  const home = apps();
  await run(home, ["install"]);
  const mine = join(home, ".claude", "skills", "context-doctor", "notes.md");
  writeFileSync(mine, "my notes");
  await run(home, ["uninstall"]);
  assert.ok(!existsSync(join(home, ".claude", "skills", "context-doctor", "SKILL.md")));
  assert.ok(existsSync(mine), "a file the user put there is theirs");
});

test("a malformed config for one app does not stop uninstall from removing the rest", async () => {
  const home = apps();
  mkdirSync(join(home, ".gemini"), { recursive: true });
  assert.equal((await run(home, ["install", "--statusline"])).code, 0);
  // The user breaks Gemini's settings after install.
  writeFileSync(join(home, ".gemini", "settings.json"), "{ broken");
  const r = await run(home, ["uninstall"]);
  assert.equal(r.code, 1, "a step that failed is not a clean uninstall");
  assert.match(r.err, /✗ Gemini CLI[^\n]*not valid JSON/);
  assert.match(r.err, /Not removed: .*Gemini CLI/);
  // Everything after it in the old order still went.
  const settings = json(join(home, ".claude", "settings.json"));
  assert.equal(settings.statusLine, undefined, "status line removed");
  assert.equal(settings.hooks, undefined, "Claude Code hooks removed");
  assert.ok(!existsSync(join(home, ".codex", "config.toml")) || !readFileSync(join(home, ".codex", "config.toml"), "utf8").includes("context-doctor"));
  assert.ok(!existsSync(join(home, ".cursor", "hooks.json")), "Cursor hooks removed");
  assert.equal(readFileSync(join(home, ".gemini", "settings.json"), "utf8"), "{ broken", "the broken file is left as the user had it");
});

test("CODEX_HOME: install, doctor and uninstall use the Codex home Codex reads", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxdoc-unin-codexhome-"));
  const codex = join(home, "elsewhere", "codex");
  mkdirSync(codex, { recursive: true });
  writeFileSync(join(codex, "config.toml"), 'model = "gpt-5.6"\n');
  const env = { ...sandboxEnv(home), CODEX_HOME: codex };
  const go = (args: string[]) => new Promise<{ code: number; out: string }>((resolve) => {
    execFile(process.execPath, [cliPath, ...args], { env, timeout: 30_000 }, (error, stdout) => resolve({ code: error ? 1 : 0, out: stdout }));
  });
  assert.equal((await go(["install"])).code, 0);
  assert.match(readFileSync(join(codex, "config.toml"), "utf8"), /\[mcp_servers\.context-doctor\]/);
  assert.ok(existsSync(join(codex, "hooks.json")) && existsSync(join(codex, "skills", "context-doctor", "SKILL.md")));
  assert.ok(!existsSync(join(home, ".codex")), "not the default folder Codex does not read");
  const doc = await go(["doctor"]);
  assert.match(doc.out, /✓ Codex MCP/);
  assert.match(doc.out, /✓ Codex hook/);
  assert.equal((await go(["uninstall"])).code, 0);
  assert.equal(readFileSync(join(codex, "config.toml"), "utf8"), 'model = "gpt-5.6"\n');
  assert.ok(!existsSync(join(codex, "hooks.json")) && !existsSync(join(codex, "skills")));
});

test("a ~/.claude holding only context-doctor's files is not Claude Code: install skips it, uninstall removes the folder", async () => {
  // Codex only. `budget` no longer makes a ~/.claude: its files go to our own state folder.
  const fresh = mkdtempSync(join(tmpdir(), "ctxdoc-unin-codex-"));
  mkdirSync(join(fresh, ".codex", "sessions"), { recursive: true });
  assert.equal((await run(fresh, ["budget", "50/day"])).code, 0);
  assert.ok(!existsSync(join(fresh, ".claude")), "no ~/.claude made for the budget");
  const state = process.platform === "win32" ? join(fresh, "AppData", "Local", "context-doctor") : join(fresh, ".local", "state", "context-doctor");
  assert.ok(existsSync(join(state, ".context-doctor-budget.json")));
  assert.equal((await run(fresh, ["uninstall"])).code, 0);
  assert.ok(!existsSync(state), "uninstall removes it, and the folder");
  // A ~/.claude an older version made for the budget (only our files in it).
  const home = mkdtempSync(join(tmpdir(), "ctxdoc-unin-codex-"));
  mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", ".context-doctor-budget.json"), JSON.stringify({ usd: 50, period: "day", block: false, at: 0 }));
  const i = await run(home, ["install"]);
  assert.equal(i.code, 0, i.err);
  assert.ok(!/Claude Code/.test(i.out), i.out);
  assert.match(i.out, /Codex: MCP server added/);
  for (const f of [".claude.json", ".claude/settings.json", ".claude/skills"]) assert.ok(!existsSync(join(home, f)), `${f} written for an absent Claude Code`);
  const u = await run(home, ["uninstall"]);
  assert.equal(u.code, 0, u.err);
  assert.ok(!existsSync(join(home, ".claude")), "the folder only our files were in");
  assert.ok(existsSync(join(home, ".codex", "sessions")));
  // A Claude Code folder stays, whatever it holds.
  const cc = mkdtempSync(join(tmpdir(), "ctxdoc-unin-cc-"));
  mkdirSync(join(cc, ".claude", "projects"), { recursive: true });
  assert.equal((await run(cc, ["uninstall"])).code, 0);
  assert.ok(existsSync(join(cc, ".claude", "projects")));
});

test("fixes applied with fix stay in the settings, and uninstall says how to revert them", async () => {
  const home = apps();
  writeFileSync(join(home, ".claude", ".context-doctor-fixes.json"), JSON.stringify({ version: 2, fixes: [{ id: "cache-ttl", at: 1, value: "1h" }] }));
  assert.equal((await run(home, ["install"])).code, 0);
  const r = await run(home, ["uninstall"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Fixes applied with `context-doctor fix` stay in your settings \(cache-ttl\): run `npx context-doctor fix undo`/);
  assert.ok(existsSync(join(home, ".claude", ".context-doctor-fixes.json")), "fix undo still needs its record");
  const none = await run(apps(), ["uninstall"]);
  assert.doesNotMatch(none.out, /Fixes applied/);
});
