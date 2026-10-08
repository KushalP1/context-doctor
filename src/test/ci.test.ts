/** ci: memory files at HEAD vs a base commit, @imports followed, budgets enforced. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ciReport, renderCiMarkdown } from "../ci.js";

function repo(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "cd-ci-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(dir, "CLAUDE.md"), "# Project\n\nRun the tests. See @docs/arch.md\n");
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "arch.md"), "Short.\n");
  writeFileSync(join(dir, "AGENTS.md"), "Codex rules.\n");
  writeFileSync(join(dir, "README.md"), "Not a memory file. ".repeat(500));
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").trim();
  writeFileSync(join(dir, "docs", "arch.md"), "Architecture detail that every request now carries. ".repeat(200));
  mkdirSync(join(dir, ".cursor", "rules"), { recursive: true });
  writeFileSync(join(dir, ".cursor", "rules", "always.mdc"), "---\nalwaysApply: true\n---\nUse tabs.\n");
  writeFileSync(join(dir, ".cursor", "rules", "manual.mdc"), "---\nalwaysApply: false\n---\nOnly on request.\n");
  return { dir, base };
}

test("compares memory files with the base, follows @imports, skips non-memory and on-demand files", () => {
  const { dir, base } = repo();
  const r = ciReport({ cwd: dir, base });
  const byPath = new Map(r.files.map((f) => [f.path, f]));
  assert.ok(byPath.get("docs/arch.md")!.imported);
  assert.ok(byPath.get("docs/arch.md")!.head > byPath.get("docs/arch.md")!.base * 50);
  assert.ok(byPath.has(".cursor/rules/always.mdc"));
  assert.ok(!byPath.has(".cursor/rules/manual.mdc"), "a rule applied on request does not ride on every request");
  assert.ok(!byPath.has("README.md"));
  assert.equal(byPath.get("AGENTS.md")!.agent, "Codex");
  assert.ok(r.headTotal > r.baseTotal);
  assert.deepEqual(r.breaches, []);
});

test("budgets: total and per-PR increase, and the markdown carries the marker the action looks for", () => {
  const { dir, base } = repo();
  const r = ciReport({ cwd: dir, base, maxTokens: 100, maxIncrease: 500 });
  assert.equal(r.breaches.length, 2);
  const md = renderCiMarkdown(r, { requestsPerDay: 1000 });
  assert.match(md, /^<!-- context-doctor -->/);
  assert.match(md, /\| `docs\/arch\.md` \(imported\) \| Claude Code \|/);
  assert.match(md, /a month\./);
  assert.match(md, /\*\*Over budget:\*\*/);
});
