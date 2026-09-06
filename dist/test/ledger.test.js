/**
 * The ledger is capped, and everything it feeds is a LIFETIME total.
 *
 * Rotation used to drop old lines outright, so the moment a heavy user crossed
 * the cap their reported savings fell off a cliff and kept falling: measured at
 * 1,692,000 tokens saved becoming 501,000. A number that goes backwards is
 * worse than no number, so rotation folds what it drops into a rollup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/** Lifetime proxy savings the way the reports compute them. */
async function lifetimeSaved() {
    const { readLedger, foldTotals } = await import("../ledger.js");
    const entries = readLedger();
    const carried = foldTotals(entries.filter((e) => e.ev === "rollup"));
    return entries.filter((e) => e.ev === "proxy").reduce((s, e) => s + (e.saved ?? 0), 0) + carried.proxySaved;
}
test("lifetime totals survive ledger rotation exactly", async () => {
    const { recordLedger, ledgerPath } = await import("../ledger.js");
    const dir = mkdtempSync(join(tmpdir(), "ctxdoc-ledger-"));
    const previous = process.env.CONTEXT_DOCTOR_HOOK_STATE;
    process.env.CONTEXT_DOCTOR_HOOK_STATE = join(dir, "state.json");
    try {
        let rotations = 0;
        let lastSize = 0;
        const entries = 4000; // comfortably past the 256KB cap
        for (let i = 0; i < entries; i++) {
            recordLedger({ ev: "proxy", src: "proxy", saved: 1000, usd: 0.01, requests: 1, sid: "x".repeat(60) });
            const size = statSync(ledgerPath()).size;
            if (size < lastSize)
                rotations++;
            lastSize = size;
        }
        assert.ok(rotations >= 1, "the fixture must actually cross the rotation cap");
        assert.equal(await lifetimeSaved(), entries * 1000, "not one token may be lost to rotation");
    }
    finally {
        if (previous === undefined)
            delete process.env.CONTEXT_DOCTOR_HOOK_STATE;
        else
            process.env.CONTEXT_DOCTOR_HOOK_STATE = previous;
    }
});
test("folding is idempotent across repeated rotations", async () => {
    const { foldTotals } = await import("../ledger.js");
    // A rollup absorbing an older rollup must not double-count or drop.
    const first = foldTotals([
        { ts: 1, ev: "optimize", saved: 100, usd: 0.5 },
        { ts: 2, ev: "proxy", saved: 700, usd: 1, requests: 3 },
        { ts: 3, sid: "s1", tok: 900, warn: true },
        { ts: 4, sid: "s1", tok: 400 }, // shrank by 500
    ]);
    assert.equal(first.optimizeSaved, 100);
    assert.equal(first.proxySaved, 700);
    assert.equal(first.checks, 2);
    assert.equal(first.warnings, 1);
    assert.equal(first.shrinkage, 500);
    const second = foldTotals([
        { ts: 5, ev: "rollup", carried: first },
        { ts: 6, ev: "proxy", saved: 300, requests: 1 },
    ]);
    assert.equal(second.proxySaved, 1000, "carried plus new");
    assert.equal(second.optimizeSaved, 100, "carried through untouched");
    assert.equal(second.shrinkage, 500);
    assert.equal(second.since, 1, "the window start survives folding");
});
