/** pack reads what was named, once: no symlink escapes or loops, no duplicates, ignored folders explained, emoji kept whole. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkSource, packContext, readSources } from "../pack.js";

// Creating symlinks needs admin rights or developer mode on Windows.
const noSymlinks = process.platform === "win32" && "symlinks need extra rights on Windows";
const names = (r: { sources: Array<{ name: string }> }) => r.sources.map((s) => s.name.replace(/\\/g, "/")).sort();

test("symlinks inside a repository are not followed out of it", { skip: noSymlinks }, () => {
  const top = mkdtempSync(join(tmpdir(), "cd-pack-links-"));
  mkdirSync(join(top, "outside"));
  writeFileSync(join(top, "outside", "secret.txt"), "TOP SECRET from beside the repo\n");
  const dir = join(top, "a", "repo");
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "guide.md"), "# Guide\n\nHello.\n");
  symlinkSync("../../outside/secret.txt", join(dir, "secret.txt"));
  symlinkSync(join(top, "outside", "secret.txt"), join(dir, "absolute.txt"));
  execFileSync("git", ["add", "-A"], { cwd: dir });
  const r = readSources([dir], dir);
  assert.deepEqual(names(r), ["guide.md"]);
  assert.ok(!r.sources.some((s) => s.text.includes("TOP SECRET")));
  assert.equal(r.skipped.filter((s) => /symlink pointing outside/.test(s)).length, 2, r.skipped.join("\n"));
});

test("a symlink loop outside git reads each file once", { skip: noSymlinks }, () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-pack-loop-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "a.md"), "# A\n\nalpha\n");
  writeFileSync(join(dir, "sub", "b.md"), "# B\n\nbeta\n");
  symlinkSync("..", join(dir, "sub", "up"));
  const r = readSources([dir], dir);
  assert.deepEqual(names(r), ["a.md", "sub/b.md"]);
  assert.deepEqual(r.skipped, []);
});

test("a file reached twice is packed once, so chunk ids stay unique", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-pack-dupe-"));
  writeFileSync(join(dir, "guide.md"), "# Guide\n\nHello.\n");
  const r = readSources([dir, join(dir, "guide.md")], dir);
  assert.deepEqual(names(r), ["guide.md"]);
  const ids = packContext(r.sources, { query: "hello" }).chunks.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("a .gitignore'd folder named outright stays out, and the user is told why", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-pack-ignored-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, ".gitignore"), "notes/\n");
  mkdirSync(join(dir, "notes"));
  writeFileSync(join(dir, "notes", "keys.md"), "# Keys\n\nAPI_KEY=do-not-pack\n");
  const r = readSources([join(dir, "notes")], dir);
  assert.equal(r.sources.length, 0, "the .gitignore guarantee holds");
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0], /ignored by git \(\.gitignore\)/);
});

test("a long line of emoji is cut between characters, never inside a surrogate pair", () => {
  const text = "a" + "😀".repeat(500);
  const chunks = chunkSource({ name: "x.txt", text }, { maxChunkTokens: 50 });
  assert.ok(chunks.length > 1);
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const c of chunks) assert.ok(!lone.test(c.text), `${c.id} has half an emoji`);
  assert.equal(chunks.map((c) => c.text.replace(/\n/g, "")).join(""), text, "nothing lost at the cuts");
});
