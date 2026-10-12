/**
 * Rotation folds dropped ledger lines into a rollup; the rollup must count
 * exactly what the live reports (impact, dashboard) count, or a total jumps
 * the moment the ledger rotates.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { foldTotals, type LedgerEntry } from "../ledger.js";

test("only hook checks count as checks; other events never add checks or shrinkage", () => {
  const entries: LedgerEntry[] = [
    { ts: 1, ev: "check", sid: "s1", tok: 900_000, warn: true },
    // A cold resume's tok is the context size at the resume; a precompact's
    // tok is a CHARACTER count of the instructions. Neither is a check.
    { ts: 2, ev: "cold_resume", sid: "s1", tok: 950_000, model: "claude-opus-5" },
    { ts: 3, ev: "precompact", sid: "s1", tok: 2_400 },
    // doctor's probe (before 0.30) is excluded from the live check count.
    { ts: 4, ev: "check", sid: "doctor-probe", tok: 0 },
    // "mcp-sketch" was one id shared by unrelated chats: counted, never a session.
    { ts: 5, ev: "check", sid: "mcp-sketch", tok: 50_000 },
    { ts: 6, ev: "check", sid: "mcp-sketch", tok: 1_000 },
    { ts: 7, sid: "s1", tok: 400_000 }, // pre-0.3.6 check: no ev
  ];
  const t = foldTotals(entries);
  assert.equal(t.checks, 4, "s1 twice and mcp-sketch twice");
  assert.equal(t.warnings, 1);
  assert.equal(t.shrinkage, 500_000, "only s1's real 900k -> 400k drop");
  assert.equal(t.since, 1, "every folded entry still dates the window");
});
