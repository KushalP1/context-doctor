/**
 * `autopilot pause|resume` only means something while autopilot is on. It
 * used to claim "✓ Paused" with autopilot off, and to throw ENOENT on a
 * machine without ~/.claude.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { autopilotPauseResult, autopilotPaths } from "../autopilot.js";
import { sandboxEnv } from "./sandbox.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

function run(home: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, ...args], { env: sandboxEnv(home), timeout: 30_000 }, (error, stdout, stderr) =>
      resolve({ code: error ? (error as { code?: number }).code ?? 1 : 0, out: stdout, err: stderr })
    );
  });
}

test("pause and resume with autopilot off say so, exit 1, and write nothing (even without ~/.claude)", async () => {
  const bare = mkdtempSync(join(tmpdir(), "ctxdoc-pause-bare-"));
  for (const sub of ["pause", "resume"]) {
    const r = await run(bare, ["autopilot", sub]);
    assert.equal(r.code, 1, r.err);
    assert.match(r.out, new RegExp(`Autopilot is off; nothing to ${sub}`));
    assert.ok(!/ENOENT|at .*autopilot\.js/.test(r.err), r.err);
    assert.ok(!/✓/.test(r.out), "no success claimed");
  }
  assert.ok(!existsSync(join(bare, ".claude")), "no ~/.claude created for nothing");

  const claude = mkdtempSync(join(tmpdir(), "ctxdoc-pause-off-"));
  mkdirSync(join(claude, ".claude"));
  const r = await run(claude, ["autopilot", "pause"]);
  assert.equal(r.code, 1);
  assert.ok(!existsSync(autopilotPaths(claude).pauseFile), "no pause file without autopilot");
});

test("with autopilot on: pause, pause again, resume, resume again", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxdoc-pause-on-"));
  mkdirSync(join(home, ".claude"));
  const paths = autopilotPaths(home);
  writeFileSync(paths.config, JSON.stringify({ port: 8787, previousBaseUrl: null, node: "node", cli: "/x/cli.js" }));

  let r = await run(home, ["autopilot", "pause"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /✓ Paused/);
  assert.ok(existsSync(paths.pauseFile));
  r = await run(home, ["autopilot", "pause"]);
  assert.match(r.out, /Already paused/);
  r = await run(home, ["autopilot", "resume"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /✓ Resumed/);
  assert.ok(!existsSync(paths.pauseFile));
  r = await run(home, ["autopilot", "resume"]);
  assert.match(r.out, /Not paused/);
});

test("the pause file's directory is created when it does not exist", () => {
  const root = mkdtempSync(join(tmpdir(), "ctxdoc-pause-dir-"));
  const config = join(root, "autopilot.json");
  writeFileSync(config, JSON.stringify({ port: 8787 }));
  const paths = { ...autopilotPaths(root), config, pauseFile: join(root, "not", "yet", "paused") };
  const r = autopilotPauseResult(true, paths);
  assert.equal(r.ok, true);
  assert.ok(existsSync(paths.pauseFile));
});
