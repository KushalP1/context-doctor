/** ci: what git hands back is read as git means it: folders are not files, non-ASCII paths are paths, an unknown base is an error. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ciReport } from "../ci.js";

/** A repo with a memory file under a non-ASCII path; its CLAUDE.md can import a folder. */
function repo(importFolder = false): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "cd-ci-paths-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  mkdirSync(join(dir, "src", "components"), { recursive: true });
  mkdirSync(join(dir, "pkgs", "café"), { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), importFolder ? "# Project\n\nComponents live in @src/components\n" : "# Project\n\nRun the tests.\n");
  writeFileSync(join(dir, "src", "components", "button.ts"), "export const Button = 1;\n");
  writeFileSync(join(dir, "pkgs", "café", "CLAUDE.md"), "Rules for the café package.\n");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  return { dir, base: git("rev-parse", "HEAD").trim() };
}

const paths = (r: ReturnType<typeof ciReport>) => r.files.map((f) => f.path.normalize("NFC"));

test("an @import that names a folder is not a file: no EISDIR at HEAD", () => {
  const { dir } = repo(true);
  assert.ok(!paths(ciReport({ cwd: dir })).includes("src/components"));
});

test("an @import that names a folder in the base is not counted from its tree listing", () => {
  const { dir, base } = repo(true);
  writeFileSync(join(dir, "CLAUDE.md"), "# Project\n\nNo imports now.\n");
  const r = ciReport({ cwd: dir, base });
  assert.ok(!paths(r).includes("src/components"), "`git show base:src/components` is a folder listing, not an imported file");
});

test("memory files under non-ASCII paths are found on both sides", () => {
  const { dir, base } = repo();
  const r = ciReport({ cwd: dir, base });
  const cafe = r.files.find((f) => f.path.normalize("NFC") === "pkgs/café/CLAUDE.md");
  assert.ok(cafe, `missing from ${paths(r).join(", ")}`);
  assert.ok(cafe.base > 0 && cafe.base === cafe.head);
});

test("a base git cannot resolve fails with a clear message instead of counting every file as new", () => {
  const { dir } = repo();
  assert.throws(() => ciReport({ cwd: dir, base: "origin/mian", maxIncrease: 0 }), /--base origin\/mian is not a commit.*fetch/);
  // What a shallow clone without the base commit looks like: a well-formed SHA that is not there.
  assert.throws(() => ciReport({ cwd: dir, base: "0123456789abcdef0123456789abcdef01234567" }), /not a commit/);
});

test("the ci command reports an unknown base in one line, not a stack trace", () => {
  const { dir } = repo();
  const cli = join(process.cwd(), "dist", "cli.js");
  const r = spawnSync(process.execPath, [cli, "ci", "--base", "origin/mian"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^context-doctor: --base origin\/mian is not a commit/);
  assert.doesNotMatch(r.stderr, /\n\s+at /, "no stack trace");
});
