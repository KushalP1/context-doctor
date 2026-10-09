/** pack: chunk along structure, rank against a question, fit a budget, never lose track of lines. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkSource, packContext, readSources, renderPack, terms } from "../pack.js";

const filler = (n: number) => "Nothing relevant in this paragraph at all. ".repeat(n);
const manual = [
  "# Manual",
  "",
  "## Install",
  "",
  filler(30),
  "",
  "## Rotating keys",
  "",
  "Run `keyctl rotate --signing` to rotate the signing key. Old keys stay valid for 24 hours.",
  "",
  "## Billing",
  "",
  filler(30),
].join("\n");

test("markdown chunks follow headings and carry the heading path", () => {
  const chunks = chunkSource({ name: "manual.md", text: manual });
  const keys = chunks.find((c) => c.text.includes("keyctl"))!;
  assert.equal(keys.heading, "Manual > Rotating keys");
  assert.equal(keys.startLine, 7);
  assert.equal(keys.endLine, 9);
  assert.ok(!keys.text.includes("Billing"), "a heading always starts a new chunk");
});

test("a query packs the matching section and leaves the rest out", () => {
  const r = packContext([{ name: "manual.md", text: manual }], { query: "how do I rotate the signing key?", budget: 200 });
  assert.equal(r.mode, "query");
  assert.ok(r.selected.some((c) => c.text.includes("keyctl")));
  assert.ok(r.packedTokens <= 200);
  assert.ok(r.packedTokens < r.totalTokens / 3);
  assert.match(renderPack(r), /^PACKED .* for "how do I rotate the signing key\?"/);
});

test("no query gives an outline; ids pick chunks from it", () => {
  const src = [{ name: "manual.md", text: manual }];
  const outline = packContext(src);
  assert.equal(outline.mode, "outline");
  assert.equal(outline.selected.length, 0);
  const id = outline.chunks.find((c) => c.heading.endsWith("Billing"))!.id;
  const r = packContext(src, { ids: [id, "nope#9"] });
  assert.deepEqual(r.selected.map((c) => c.id), [id]);
  assert.deepEqual(r.missingIds, ["nope#9"]);
  assert.match(renderPack(r), /Unknown ids: nope#9/);
});

test("code is chunked at top-level declarations and labelled by them, not their doc comment", () => {
  const code = [
    "/** Adds. */",
    "export function add(a: number, b: number) {",
    "  return a + b;",
    "}",
    "",
    "/** Parses the config file. */",
    "export function parseConfig(path: string) {",
    "  return JSON.parse(path);",
    "}",
  ].join("\n");
  const chunks = chunkSource({ name: "x.ts", text: code }, { maxChunkTokens: 50 });
  assert.equal(chunks.length, 2);
  assert.match(chunks[1].heading, /^export function parseConfig/);
  const r = packContext([{ name: "x.ts", text: code }], { query: "parse config", maxChunkTokens: 50 });
  assert.equal(r.selected[0].id, "x.ts#2");
});

test("one enormous line is cut into chunks that keep its true line number", () => {
  const text = "first\n" + "word ".repeat(20_000) + "\nlast";
  const chunks = chunkSource({ name: "log.txt", text }, { maxChunkTokens: 200 });
  assert.ok(chunks.length > 10);
  assert.ok(chunks.every((c) => c.tokens <= 260), "no chunk far past the limit");
  assert.ok(chunks.slice(1, -1).every((c) => c.startLine === 2 && c.endLine === 2));
});

test("the budget is a hard cap", () => {
  const big = Array.from({ length: 50 }, (_, i) => `## Part ${i}\n\nsigning key rotation details ${filler(10)}`).join("\n\n");
  const r = packContext([{ name: "big.md", text: big }], { query: "signing key rotation", budget: 500 });
  assert.ok(r.packedTokens <= 500 && r.selected.length > 0);
  assert.match(renderPack(r), /Not included: \d+ chunk\(s\)\. Next best: big\.md#/);
});

test("terms split camelCase and snake_case, drop stopwords, fold plurals", () => {
  assert.deepEqual(terms("How do the parseConfig_files work?"), ["parse", "config", "file", "work"]);
});

test("readSources walks folders, skips dependencies and binaries, and says what it skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-pack-"));
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "node_modules", "dep.js"), "x");
  writeFileSync(join(dir, "a.md"), "# A\n\ntext");
  writeFileSync(join(dir, "img.png"), Buffer.from([0x89, 0x50, 0, 0, 1]));
  const { sources, skipped } = readSources([dir, join(dir, "img.png"), join(dir, "missing.md")], dir);
  assert.deepEqual(sources.map((s) => s.name), ["a.md"]);
  assert.ok(skipped.some((s) => /img\.png: binary/.test(s)));
  assert.ok(skipped.some((s) => /missing\.md: not found/.test(s)));
});

test("inside a git repository a folder is read as git sees it: .gitignore'd files stay out", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-pack-git-"));
  const git = (...a: string[]) => spawnSync("git", a, { cwd: dir });
  if (git("init", "-q").status !== 0) return; // no git on this machine
  writeFileSync(join(dir, ".gitignore"), "out/\nsecrets.env\n");
  mkdirSync(join(dir, "out"));
  writeFileSync(join(dir, "out", "bundle.js"), "built");
  writeFileSync(join(dir, "secrets.env"), "KEY=x");
  writeFileSync(join(dir, "notes.md"), "# Notes\n\nuntracked but not ignored");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;");
  git("add", "src/a.ts");
  const names = readSources([dir], dir).sources.map((s) => s.name.replace(/\\/g, "/")).sort();
  assert.deepEqual(names, [".gitignore", "notes.md", "src/a.ts"]);
});
