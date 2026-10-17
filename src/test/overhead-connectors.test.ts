/**
 * Connectors added on claude.ai show up in Claude Code under a UUID. overhead
 * listed them as bare UUIDs; it names them as connectors, short id kept so
 * two can be told apart, and --json still has the full name.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpDisplayName, renderOverhead, type OverheadReport } from "../overhead.js";

test("a UUID server name reads as a claude.ai connector", () => {
  assert.equal(mcpDisplayName("1a59c906-04da-521d-bda7-7f71b9f9e01c"), "claude.ai connector 1a59c906");
  assert.equal(mcpDisplayName("claude-in-chrome"), "claude-in-chrome");
  assert.equal(mcpDisplayName("1a59c906"), "1a59c906", "only a whole UUID");
});

test("the overhead report lists connectors by that name", () => {
  const report: OverheadReport = {
    cwd: "/w",
    baselines: [],
    files: [],
    findings: [],
    mcp: {
      configs: [],
      usage: { calls: new Map([["1a59c906-04da-521d-bda7-7f71b9f9e01c", 11], ["claude-in-chrome", 30]]), sessions: 4, toolSearchSessions: 4 },
    },
  };
  const text = renderOverhead(report, "/home/x");
  assert.match(text, /claude\.ai connector 1a59c906\s+11 calls/);
  assert.ok(!text.includes("04da-521d"), "no bare UUID");
  assert.match(text, /claude-in-chrome\s+30 calls/);
});
