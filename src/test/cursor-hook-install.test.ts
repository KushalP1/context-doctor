/**
 * Cursor's native hook: install writes a postToolUse entry to
 * ~/.cursor/hooks.json (the only Cursor event near the prompt whose output
 * reaches the model), repairs rather than duplicates it, keeps the user's own
 * hooks, and uninstall removes only ours.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "./sandbox.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

test("install adds Cursor's postToolUse hook once, keeps theirs, and uninstall removes only ours", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxdoc-cursorhome-"));
  mkdirSync(join(home, ".cursor"), { recursive: true });
  const hooksPath = join(home, ".cursor", "hooks.json");
  writeFileSync(hooksPath, JSON.stringify({ version: 1, hooks: { postToolUse: [{ command: "./their-formatter.sh" }], afterFileEdit: [{ command: "./fmt.sh" }] } }));
  const run = (cmd: string) =>
    new Promise<string>((resolve, reject) => {
      execFile(process.execPath, [cliPath, cmd], { env: sandboxEnv(home) }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
    });

  assert.match(await run("install"), /Cursor after-tool-call hook installed/);
  await run("install"); // idempotent
  const config = JSON.parse(readFileSync(hooksPath, "utf8"));
  assert.equal(config.version, 1);
  const commands = (config.hooks.postToolUse as Array<{ command: string }>).map((h) => h.command);
  assert.equal(commands.length, 2, "theirs plus exactly one of ours");
  assert.equal(commands[0], "./their-formatter.sh");
  assert.match(commands[1], /cli\.js" hook$/);
  assert.deepEqual(config.hooks.afterFileEdit, [{ command: "./fmt.sh" }], "other events untouched");

  await run("uninstall");
  const left = JSON.parse(readFileSync(hooksPath, "utf8"));
  assert.deepEqual(left.hooks.postToolUse, [{ command: "./their-formatter.sh" }]);
  assert.deepEqual(left.hooks.afterFileEdit, [{ command: "./fmt.sh" }]);
});

test("install creates ~/.cursor/hooks.json when Cursor has none", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxdoc-cursorhome-"));
  mkdirSync(join(home, ".cursor"), { recursive: true });
  await new Promise((resolve, reject) => execFile(process.execPath, [cliPath, "install"], { env: sandboxEnv(home) }, (err) => (err ? reject(err) : resolve(undefined))));
  const config = JSON.parse(readFileSync(join(home, ".cursor", "hooks.json"), "utf8"));
  assert.equal(config.version, 1);
  assert.equal(config.hooks.postToolUse.length, 1);
  assert.equal(config.hooks.postToolUse[0].timeout, 10);
});
