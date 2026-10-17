/**
 * `ci` outside a git repository listed no files, printed "No agent memory
 * files" and exited 0, so a CI step run in the wrong directory passed every
 * pull request. It must fail and say why.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ciReport } from "../ci.js";
import { sandboxEnv } from "./sandbox.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

test("ci outside a git repository exits 1 with a clear message", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxdoc-ci-norepo-"));
  writeFileSync(join(dir, "CLAUDE.md"), "# Rules\n");
  // GIT_CEILING_DIRECTORIES stops git from finding a repository above the temp dir.
  const env = { ...sandboxEnv(dir), GIT_CEILING_DIRECTORIES: dirname(dir) };
  const r = spawnSync(process.execPath, [cli, "ci"], { cwd: dir, env, encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /not inside one|not a git repository|git repository/);
  assert.ok(!/No agent memory files/.test(r.stdout));
  const j = spawnSync(process.execPath, [cli, "ci", "--json"], { cwd: dir, env, encoding: "utf8" });
  assert.equal(j.status, 1);
  assert.equal(j.stdout, "", "no JSON report for a check that did not run");
});

test("ciReport throws outside a repository instead of reporting nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxdoc-ci-norepo-lib-"));
  const saved = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(dir);
  try {
    assert.throws(() => ciReport({ cwd: dir }), /git repository/);
  } finally {
    if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = saved;
  }
});
