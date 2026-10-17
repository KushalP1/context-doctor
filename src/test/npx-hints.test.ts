/**
 * Next-step hints name the command as the user can type it. After
 * `npx context-doctor …` there is no `context-doctor` on PATH, so a hint
 * like "run: context-doctor install" was "command not found".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchedViaNpx, needsNpx, selfCommand, withInvocation } from "../invocation.js";
import { sandboxEnv } from "./sandbox.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const nodeOnly = dirname(process.execPath);

function env(home: string, npx: boolean): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...sandboxEnv(home), PATH: nodeOnly };
  delete e.npm_command;
  if (npx) e.npm_command = "exec";
  return e;
}

test("launchedViaNpx: npm's npm_command=exec, or a script inside npx's cache", () => {
  assert.equal(launchedViaNpx({ npm_command: "exec" }, "/repo/dist/cli.js"), true);
  assert.equal(launchedViaNpx({}, "/Users/me/.npm/_npx/9f2c/node_modules/context-doctor/dist/cli.js"), true);
  assert.equal(launchedViaNpx({}, "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\9f2c\\node_modules\\context-doctor\\dist\\cli.js"), true);
  assert.equal(launchedViaNpx({ npm_command: "run-script" }, "/repo/dist/cli.js"), false);
});

test("hints are rewritten for npx, and only the command hints", () => {
  const npx = { npm_command: "exec", PATH: nodeOnly };
  assert.equal(selfCommand("savings", npx), "npx context-doctor savings");
  assert.equal(withInvocation("— run: context-doctor install", npx), "— run: npx context-doctor install");
  assert.equal(withInvocation("Turn it on:  context-doctor autopilot on", npx), "Turn it on:  npm i -g context-doctor && context-doctor autopilot on", "autopilot needs a global install");
  for (const keep of [
    "MCP entry runs `npx context-doctor-mcp`",
    "provided by the context-doctor plugin",
    "npm i -g context-doctor && context-doctor install",
    "already npx context-doctor savings",
    "/opt/context-doctor/dist/cli.js install",
  ]) {
    assert.equal(withInvocation(keep, npx), keep);
  }
  assert.equal(withInvocation("run: context-doctor install", { PATH: nodeOnly }), "run: context-doctor install", "not from npx: unchanged");
});

test("a global install on PATH means the plain command works, even from npx", { skip: platform() === "win32" && "a POSIX executable stub" }, () => {
  const bin = mkdtempSync(join(tmpdir(), "ctxdoc-globalcd-"));
  writeFileSync(join(bin, "context-doctor"), "#!/bin/sh\n");
  chmodSync(join(bin, "context-doctor"), 0o755);
  assert.equal(needsNpx({ npm_command: "exec", PATH: bin }), false);
  // npx's own cache and a project's node_modules/.bin are not the user's shell.
  const cache = join(mkdtempSync(join(tmpdir(), "ctxdoc-npxcache-")), "_npx", "abc", "node_modules", ".bin");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "context-doctor"), "#!/bin/sh\n");
  chmodSync(join(cache, "context-doctor"), 0o755);
  assert.equal(needsNpx({ npm_command: "exec", PATH: cache }), true);
});

test("savings, install and doctor print npx hints after an npx run, plain ones otherwise", () => {
  const home = mkdtempSync(join(tmpdir(), "ctxdoc-npxhints-"));
  const s = spawnSync(process.execPath, [cli, "savings"], { encoding: "utf8", env: env(home, true) });
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /`npx context-doctor savings`/);
  const plain = spawnSync(process.execPath, [cli, "savings"], { encoding: "utf8", env: env(home, false) });
  assert.match(plain.stdout, /run this again: `context-doctor savings`/);

  const appHome = mkdtempSync(join(tmpdir(), "ctxdoc-npxhints-app-"));
  mkdirSync(join(appHome, ".cursor"));
  const i = spawnSync(process.execPath, [cli, "install"], { encoding: "utf8", env: env(appHome, true) });
  assert.equal(i.status, 0, i.stderr);
  assert.match(i.stdout, /npx context-doctor savings/);
  assert.match(i.stdout, /npx context-doctor instructions --copy/);

  const broken = mkdtempSync(join(tmpdir(), "ctxdoc-npxhints-doc-"));
  mkdirSync(join(broken, ".claude"));
  writeFileSync(join(broken, ".claude.json"), JSON.stringify({ numStartups: 2 }));
  const d = spawnSync(process.execPath, [cli, "doctor"], { encoding: "utf8", env: env(broken, true), timeout: 30_000 });
  assert.match(d.stdout, /run: npx context-doctor install/);
  assert.ok(!/run: context-doctor install/.test(d.stdout));
});
