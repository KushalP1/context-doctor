/**
 * MCP usage counts what the transcripts really hold: calls made by
 * subagents (in <session>/subagents/agent-*.jsonl) count, a forked session's
 * copy of its parent's calls counts once, and --days applies to each call's
 * own time, not to whichever file was last touched.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpUsage } from "../mcpschema.js";
import { mcpFindings } from "../overhead.js";

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const call = (id: string, name: string, at: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "assistant", uuid: `row-${id}`, timestamp: iso(at), ...extra, message: { id: `msg-${id}`, role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] } });

test("subagent calls count, a fork's copied calls count once, and each call is dated by its own row", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-mcp-usage-"));
  const now = Date.now();
  const parentRows = [
    call("toolu_gh1", "mcp__github__list_prs", now - 2 * DAY),
    call("toolu_old", "mcp__github__create_issue", now - 40 * DAY), // the session began long ago
    call("toolu_ts", "ToolSearch", now - 2 * DAY),
  ];
  const parent = join(dir, "parent.jsonl");
  writeFileSync(parent, parentRows.join("\n") + "\n");
  // Only the subagents used Slack.
  mkdirSync(join(dir, "parent", "subagents"), { recursive: true });
  writeFileSync(
    join(dir, "parent", "subagents", "agent-a1.jsonl"),
    [call("toolu_sl1", "mcp__slack__search", now - DAY, { isSidechain: true }), call("toolu_sl2", "mcp__slack__read_thread", now - DAY, { isSidechain: true })].join("\n") + "\n"
  );
  // A fork: the parent's rows verbatim, then one call of its own.
  const fork = join(dir, "fork.jsonl");
  writeFileSync(fork, [...parentRows, call("toolu_gh2", "mcp__github__list_prs", now - 3_600_000)].join("\n") + "\n");

  const u = mcpUsage(30, [parent, fork]);
  assert.equal(u.calls.get("slack"), 2, "subagent calls are calls");
  assert.equal(u.calls.get("github"), 2, "one in the parent, one of the fork's own; not the copy, not the 40-day-old call");
  assert.equal(u.sessions, 2);

  // So Slack is not reported as unused.
  const configs = [{ name: "slack", scope: "user" as const }];
  const sizes = [{ name: "slack", tools: 12, schemaTokens: 5000, nameTokens: 120 }];
  assert.deepEqual(mcpFindings({ configs, sizes, usage: u }), []);
});
