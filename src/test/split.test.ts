/** overhead split: big sections move word for word to a reference file; indexes stay; nothing is written without --write. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySplit, planSplit } from "../split.js";

const big = "The architecture has many moving parts that rarely matter. ".repeat(40);
const claudeMd = `# Project\n\nAlways run tests.\n\n## Rules\n\nUse tabs.\n\n## Architecture\n\n${big}\n\n## Data model\n\n${big}\n\n## Links\n\n- [API](docs/api.md)\n- [Ops](docs/ops.md)\n`;

test("large sections move, consecutive ones share one pointer, rules and link lists stay", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-split-"));
  const path = join(dir, "CLAUDE.md");
  writeFileSync(path, claudeMd);
  const plan = planSplit(path);
  assert.deepEqual(plan.sections.map((s) => `${s.heading}:${s.moved}`), ["Rules:false", "Architecture:true", "Data model:true", "Links:false"]);
  assert.match(plan.keptText, /Sections moved to CLAUDE\.reference\.md .*"Architecture", "Data model"/);
  assert.equal(plan.keptText.match(/moved to/gi)!.length, 1);
  assert.ok(plan.tokensAfter < plan.tokensBefore / 3);
  assert.equal(readFileSync(path, "utf8"), claudeMd, "planning writes nothing");
});

test("applying keeps every line (lean file + reference), and backs up the original", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-split-"));
  const path = join(dir, "CLAUDE.md");
  writeFileSync(path, claudeMd);
  const { backup } = applySplit(planSplit(path), 42);
  assert.equal(readFileSync(backup, "utf8"), claudeMd);
  const after = readFileSync(path, "utf8") + readFileSync(join(dir, "CLAUDE.reference.md"), "utf8");
  for (const line of claudeMd.split("\n").filter((l) => l.trim())) assert.ok(after.includes(line), `lost: ${line.slice(0, 40)}`);
});

test("an auto-memory MEMORY.md keeps only its index; the rest moves behind one index line", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-split-"));
  const path = join(dir, "MEMORY.md");
  writeFileSync(path, "# Memory\n\n## Notes\n\nsmall note\n\n## Other\n\nanother small note\n\n## Index\n\n- [A](a.md) — a\n- [B](b.md) — b\n");
  const plan = planSplit(path);
  assert.deepEqual(plan.sections.filter((s) => s.moved).map((s) => s.heading), ["Notes", "Other"]);
  assert.match(plan.keptText, /^- \[Notes; Other\]\(MEMORY\.reference\.md\)/m);
  assert.match(plan.keptText, /- \[A\]\(a\.md\)/);
});

test("a lean file has nothing to move", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-split-"));
  const path = join(dir, "AGENTS.md");
  writeFileSync(path, "# Agents\n\n## Style\n\nShort.\n\n## Tests\n\nnpm test\n");
  const plan = planSplit(path);
  assert.ok(plan.sections.every((s) => !s.moved));
  assert.ok(!existsSync(join(dir, "AGENTS.reference.md")));
});
