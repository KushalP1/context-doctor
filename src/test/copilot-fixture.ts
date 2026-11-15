/** A Copilot CLI session-state fixture: the shape copilotusage.ts reads, made-up numbers. Shared by the spend tests. */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();

const record = (id: string, t: number, usage: Record<string, unknown>) => ({ type: "session.usage_record", id, timestamp: iso(t), parentId: null, data: { usage } });

/** Session a: a start with its context, two calls (one written twice), two compactions (one a record names), a call on Auto, an old call, a torn last line. Session b: a flat file, no context. */
export function writeCopilot(home: string, now: number): void {
  const root = join(home, ".copilot", "session-state");
  mkdirSync(join(root, "sess-a"), { recursive: true });
  const t = now - 2 * DAY;
  const rows = [
    { type: "session.start", id: "s1", timestamp: iso(t), data: { sessionId: "sess-a", copilotVersion: "1.0.112", selectedModel: "claude-opus-4.6-1m", context: { cwd: "/Users/dev/tech/shop/web", gitRoot: "/Users/dev/tech/shop", branch: "feat/cart", repository: "acme/shop" } } },
    { type: "user.message", id: "m1", timestamp: iso(t + 500), data: { content: "SECRET PROMPT TEXT" } },
    record("e1", t + 1_000, { model: "claude-opus-4.6-1m", inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 6_000, cacheWriteTokens: 2_000, reasoningTokens: 100, cost: 1, duration: 4_000, apiCallId: "call-1", copilotUsage: { totalNanoAiu: 50e9 } }),
    // The same call received again: counted once.
    record("e1-again", t + 1_200, { model: "claude-opus-4.6-1m", inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 6_000, cacheWriteTokens: 2_000, cost: 1, apiCallId: "call-1", copilotUsage: { totalNanoAiu: 50e9 } }),
    record("e2", t + 2_000, { model: "gpt-5.4", inputTokens: 4_000, outputTokens: 200, cacheReadTokens: 1_000, cacheWriteTokens: 0, cost: 0, apiCallId: "call-2", copilotUsage: { totalNanoAiu: 1e9 } }),
    // A compaction a usage record already names (call-2): not again.
    { type: "session.compaction_complete", id: "c1", timestamp: iso(t + 2_100), data: { requestId: "call-2", compactionTokensUsed: { model: "gpt-5.4", inputTokens: 4_000, outputTokens: 200 } } },
    // One no record names: a call of its own, its model from the behavior model.
    { type: "session.compaction_complete", id: "c2", timestamp: iso(t + 3_000), data: { requestId: "compact-9", behaviorModelId: "claude-sonnet-4.5", compactionTokensUsed: { inputTokens: 3_000, outputTokens: 300 } } },
    // Auto has no list price: counted, not priced.
    record("e3", t + 4_000, { model: "auto", inputTokens: 100, outputTokens: 10, cost: 0 }),
    // Outside the window.
    record("e0", now - 40 * DAY, { model: "gpt-5.4", inputTokens: 999_999, outputTokens: 1, apiCallId: "old" }),
  ];
  writeFileSync(join(root, "sess-a", "events.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + '\n{"type":"session.usage_record","data":{"usa');
  writeFileSync(join(root, "sess-b.jsonl"), JSON.stringify(record("b1", t + 5_000, { model: "claude-sonnet-4.5-1m", inputTokens: 1_000, outputTokens: 100, cost: 1, accounting: { sourceSessionId: "sess-b", usageId: "u1" }, copilotUsage: { totalNanoAiu: 2e9 } })) + "\n");
}

/**
 * By hand. Opus 4.6 ($5 / $0.50 read / $6.25 write / $25): 2,000 uncached + 6,000 read + 2,000 written + 500 out.
 * GPT-5.4 ($2.50 / $0.25 / $15): 3,000 uncached + 1,000 read + 200 out. Sonnet 4.5 ($3 / $15): 3,000 in + 300 out, then 1,000 in + 100 out.
 */
export const COPILOT_USD = (2_000 * 5 + 6_000 * 0.5 + 2_000 * 6.25 + 500 * 25 + 3_000 * 2.5 + 1_000 * 0.25 + 200 * 15 + 3_000 * 3 + 300 * 15 + 1_000 * 3 + 100 * 15) / 1e6;

