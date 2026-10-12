/** overhead split: kept text is kept byte for byte; only the spacing around an inserted pointer is tidied. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planSplit } from "../split.js";
const big = "The architecture has many moving parts that rarely matter. ".repeat(40);
test("a kept fenced block with blank lines inside survives byte for byte", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-split-blank-"));
    const path = join(dir, "CLAUDE.md");
    const kept = "## Rules\n\nUse tabs.\n\n```py\ndef f():\n    pass\n\n\n\ndef g():\n    pass\n```\n";
    writeFileSync(path, `# Project\n\n${kept}\n\n\n## Architecture\n\n${big}\n\n## Links\n\n- [API](docs/api.md)\n`);
    const plan = planSplit(path);
    assert.ok(plan.sections.find((s) => s.heading === "Architecture").moved);
    assert.ok(plan.keptText.includes(kept), plan.keptText.slice(0, 200));
    // The blank lines before the moved section shrink to one in front of its pointer.
    assert.ok(plan.keptText.includes("```\n\n## Architecture\nMoved to CLAUDE.reference.md"), plan.keptText.slice(0, 200));
});
