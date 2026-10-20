/** report prices only tokens with a known price, and says how many are not. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildImpactReport } from "../impact.js";
import { formatTokens } from "../tokens.js";
import { withSandboxHome } from "./sandbox.js";
test("optimize savings on an unpriced model are labelled, not priced at another's rate", async () => {
    const home = mkdtempSync(join(tmpdir(), "cd-report-priced-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    const now = Date.now();
    writeFileSync(join(home, ".claude", ".context-doctor-ledger.jsonl"), [
        { ts: now, ev: "optimize", src: "cli", saved: 10_000, model: "claude-sonnet-5" },
        { ts: now, ev: "optimize", src: "cli", saved: 5_000, model: "some-local-model" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const out = await withSandboxHome(home, () => buildImpactReport(1));
    assert.match(out, /optimizations applied via CLI\/chat tools \(exact\): 15k over 2 run\(s\)/);
    assert.match(out, /≈ \$0\.020 on the 10k with a known price; 5\.0k unpriced/, out);
    writeFileSync(join(home, ".claude", ".context-doctor-ledger.jsonl"), JSON.stringify({ ts: now, ev: "optimize", src: "cli", saved: 5_000, model: "some-local-model" }) + "\n");
    const unpriced = await withSandboxHome(home, () => buildImpactReport(1));
    assert.match(unpriced, /\(no known price for these models\)/);
});
test("formatTokens rounds before choosing the unit", () => {
    assert.equal(formatTokens(999_999.9), "1.0M");
    assert.equal(formatTokens(999_999), "1.0M");
    assert.equal(formatTokens(9_999), "10k");
    assert.equal(formatTokens(999.9), "1.0k");
    assert.equal(formatTokens(999.4), "999");
    assert.equal(formatTokens(-1500), "-1.5k");
    assert.equal(formatTokens(Number.NaN), "0");
});
