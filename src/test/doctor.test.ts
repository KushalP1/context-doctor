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
  const out = await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, "doctor"],
      { env: { ...process.env, CONTEXT_DOCTOR_HOOK_STATE: join(stateDir, "state.json") }, timeout: 20000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
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

  await new Promise<void>((resolve, reject) => {
    execFile(process.execPath, [cliPath, "install"], { env: { ...process.env, HOME: home } }, (err) =>
      err ? reject(err) : resolve()
    );
  });

  const config = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  const entry = config.mcpServers["context-doctor"];
  // process.execPath is version-pinned on Homebrew/nvm/asdf: a Node upgrade
  // deletes that path and every config we wrote breaks silently.
  assert.notEqual(entry.command, process.execPath, "must not pin the running node binary");
  assert.ok(["node", "npx"].includes(entry.command), `expected node or npx, got ${entry.command}`);

  const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  const hookCmd = settings.hooks.UserPromptSubmit[0].hooks[0].command as string;
  assert.ok(!hookCmd.includes(process.execPath), "hook must not pin the running node binary either");
  assert.match(hookCmd, /^(node|npx)\b/, "hook resolves its runtime from PATH");
});

test("re-running install repairs a stale hook instead of leaving it", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");

  const home = mkdtempSync(join(tmpdir(), "ctxdoc-stale-"));
  mkdirSync(join(home, ".claude"), { recursive: true });

  // Simulate what an older version wrote: a pinned binary that no longer exists.
  const stale = '"/opt/homebrew/Cellar/node/1.2.3/bin/node" "/gone/context-doctor/dist/cli.js" hook';
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: stale }] }] } })
  );

  const run = () =>
    new Promise<void>((resolve, reject) => {
      execFile(process.execPath, [cliPath, "install"], { env: { ...process.env, HOME: home } }, (err) =>
        err ? reject(err) : resolve()
      );
    });
  await run();

  const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  const entries = settings.hooks.UserPromptSubmit;
  assert.equal(entries.length, 1, "the stale entry is replaced, not duplicated");
  assert.notEqual(entries[0].hooks[0].command, stale, "stale command must be repaired");
  assert.match(entries[0].hooks[0].command, /^node /);

  // And a second run is a no-op: install stays idempotent.
  await run();
  const again = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(again.hooks.UserPromptSubmit.length, 1, "no duplicate entries on repeat installs");
});

test("a stale hook from a differently-named checkout is still repaired", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");

  const home = mkdtempSync(join(tmpdir(), "ctxdoc-renamed-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  // No "context-doctor" anywhere in the command — the repo was cloned as ctxdoc.
  const stale = '"/opt/homebrew/Cellar/node/1.2.3/bin/node" "/Users/dev/ctxdoc/dist/cli.js" hook';
  const foreign = { hooks: [{ type: "command", command: "echo unrelated-hook" }] };
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ hooks: { UserPromptSubmit: [foreign, { hooks: [{ type: "command", command: stale }] }] } })
  );

  await new Promise<void>((resolve, reject) => {
    execFile(process.execPath, [cliPath, "install"], { env: { ...process.env, HOME: home } }, (err) =>
      err ? reject(err) : resolve()
    );
  });

  const entries = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).hooks.UserPromptSubmit;
  const commands = entries.map((e: any) => e.hooks[0].command as string);
  assert.ok(!commands.includes(stale), "the stale entry is gone");
  assert.ok(commands.includes("echo unrelated-hook"), "somebody else's hook is left alone");
  assert.equal(commands.filter((c: string) => c.includes("hook") && c.startsWith("node")).length, 1, "exactly one of ours");
});

test("a hook is never pointed into npx's garbage-collected cache", async () => {
  const { mkdtempSync, mkdirSync, cpSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { execFile } = await import("node:child_process");

  // Reproduce the `npx -y context-doctor install` layout: our dist living
  // inside an `_npx` directory that npm may delete at any time.
  const root = mkdtempSync(join(tmpdir(), "ctxdoc-npx-"));
  const pkg = join(root, "_npx", "abc123", "node_modules", "context-doctor");
  mkdirSync(pkg, { recursive: true });
  cpSync(dirname(cliPath), join(pkg, "dist"), { recursive: true });
  cpSync(join(dirname(cliPath), "..", "skills"), join(pkg, "skills"), { recursive: true });

  const home = mkdtempSync(join(tmpdir(), "ctxdoc-npxhome-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    execFile(process.execPath, [join(pkg, "dist", "cli.js"), "install"], { env: { ...process.env, HOME: home } }, (err) =>
      err ? reject(err) : resolve()
    );
  });

  const cmd = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"))
    .hooks.UserPromptSubmit[0].hooks[0].command as string;
  assert.ok(!cmd.includes("_npx"), `hook must not live in the npx cache, got: ${cmd}`);
  assert.match(cmd, /\bhook\s*$/);
});
