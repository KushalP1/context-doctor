/**
 * `compact-window off` with nothing set created a settings.json of `{}` and
 * claimed to have removed the setting; `compact-window 400k` on a machine
 * with no settings.json claimed "a .backup was kept" for a file that never
 * existed. Each now says what it actually did.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setCompactWindow } from "../compactwindow.js";
import { sandboxEnv } from "./sandbox.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

test("compact-window off / <size> say what happened, and claim no backup that does not exist", () => {
  const home = mkdtempSync(join(tmpdir(), "ctxdoc-cwset-"));
  mkdirSync(join(home, ".claude"));
  const settings = join(home, ".claude", "settings.json");
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, "compact-window", ...args], { encoding: "utf8", env: sandboxEnv(home) });

  let r = run("off");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No auto-compact window was set/);
  assert.ok(!existsSync(settings), "off with nothing set writes nothing");

  r = run("400k");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /autoCompactWindow = 400000 .*\(a new file\)/);
  assert.ok(!/backup/i.test(r.stdout), r.stdout);
  assert.ok(!existsSync(`${settings}.context-doctor.backup`));
  assert.equal(JSON.parse(readFileSync(settings, "utf8")).autoCompactWindow, 400000);

  r = run("400k");
  assert.match(r.stdout, /already 400000/);

  r = run("300k");
  // Paths print with the platform separator; compare with forward slashes.
  assert.match(r.stdout.replace(/\\/g, "/"), /previous file is kept as ~\/\.claude\/settings\.json\.context-doctor\.backup/);
  assert.ok(existsSync(`${settings}.context-doctor.backup`));

  r = run("off");
  assert.match(r.stdout, /✓ autoCompactWindow removed/);
  assert.equal(JSON.parse(readFileSync(settings, "utf8")).autoCompactWindow, undefined);
  r = run("off");
  assert.match(r.stdout, /No auto-compact window was set/);
});

test("setCompactWindow reports changed / created / backup", () => {
  const home = mkdtempSync(join(tmpdir(), "ctxdoc-cwset-lib-"));
  assert.deepEqual(setCompactWindow(undefined, home), { changed: false, created: false });
  assert.ok(!existsSync(join(home, ".claude", "settings.json")));
  const first = setCompactWindow(500_000, home);
  assert.equal(first.changed, true);
  assert.equal(first.created, true);
  assert.equal(first.backup, undefined);
});
