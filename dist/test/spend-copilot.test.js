/**
 * `spend` reads Copilot CLI's `session.usage_record` events: each model call
 * once (a call written twice, a compaction a record already names), its
 * input less both cache counts, priced at list where the model has a price
 * and counted where it has none, its AI credits and premium requests kept
 * beside the price. The records are the shape GitHub's own collector and
 * the other readers parse (copilotusage.ts), with made-up numbers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copilotFileCalls, copilotModel } from "../copilotusage.js";
import { copilotSpend, renderSpend, spendReport } from "../spend.js";
import { clearScanMemo } from "../scan.js";
import { withSandboxHome } from "./sandbox.js";
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-14T12:00:00Z");
const iso = (t) => new Date(t).toISOString();
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
const record = (id, t, usage) => ({ type: "session.usage_record", id, timestamp: iso(t), parentId: null, data: { usage } });
/** Session a: a start with its context, two calls (one written twice), two compactions (one a record names), a call on Auto, an old call, a torn last line. Session b: a flat file, no context. */
export function writeCopilot(home, now = NOW) {
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
function sandbox(fn) {
    const home = mkdtempSync(join(tmpdir(), "cd-copilot-"));
    const saved = process.env.CONTEXT_DOCTOR_CACHE_DIR;
    process.env.CONTEXT_DOCTOR_CACHE_DIR = join(home, "cache");
    clearScanMemo();
    return withSandboxHome(home, () => fn(home)).finally(() => {
        if (saved === undefined)
            delete process.env.CONTEXT_DOCTOR_CACHE_DIR;
        else
            process.env.CONTEXT_DOCTOR_CACHE_DIR = saved;
        clearScanMemo();
        rmSync(home, { recursive: true, force: true });
    });
}
test("copilot: model ids lose the context-size suffix and a BYOK provider's id", () => {
    assert.equal(copilotModel("claude-opus-4.6-1m"), "claude-opus-4.6");
    assert.equal(copilotModel("claude-opus-4.6-1m-internal"), "claude-opus-4.6");
    assert.equal(copilotModel("0b5e3c1a-1234-4abc-9def-0123456789ab/gpt-5.4"), "gpt-5.4");
    assert.equal(copilotModel("gpt-5.4"), "gpt-5.4");
});
test("copilot: each call once, input less both cache counts, a compaction a record names not again", async () => {
    await sandbox((home) => {
        writeCopilot(home);
        const calls = copilotFileCalls(join(home, ".copilot", "session-state", "sess-a", "events.jsonl"), "sess-a", NOW - 30 * DAY, NOW);
        assert.deepEqual(calls.map((c) => [c.model, c.input, c.read, c.write, c.output]), [
            ["claude-opus-4.6", 2_000, 6_000, 2_000, 500],
            ["gpt-5.4", 3_000, 1_000, 0, 200],
            ["claude-sonnet-4.5", 3_000, 0, 0, 300],
            ["auto", 100, 0, 0, 10],
        ]);
        assert.equal(calls[0].credits, 50);
        assert.equal(calls[0].premium, 1);
        assert.equal(calls[0].branch, "feat/cart");
        assert.equal(calls[0].gitRoot, "/Users/dev/tech/shop");
    });
});
test("copilot: spend prices at list where the model has a price, counts Auto, keeps credits and premium requests beside", async () => {
    await sandbox((home) => {
        writeCopilot(home);
        const items = copilotSpend(NOW - 30 * DAY, NOW, home);
        assert.equal(items.length, 5);
        close(items.reduce((n, i) => n + i.usd, 0), COPILOT_USD, "list price");
        const r = spendReport(30, { home, now: NOW, claudePaths: [], progress: false });
        const t = r.tools.find((x) => x.tool === "copilot");
        assert.equal(t.name, "Copilot CLI");
        close(t.usd, COPILOT_USD, "report");
        assert.equal(t.requests, 5);
        assert.equal(t.unpriced, 1);
        assert.deepEqual(t.unpricedModels, ["auto"]);
        assert.equal(t.credits, 53);
        assert.equal(t.premium, 2);
        assert.ok(r.projects.some((p) => p.project === "tech-shop-web"), JSON.stringify(r.projects));
        assert.ok(r.projects.some((p) => p.project === "copilot"));
        const text = renderSpend(r);
        assert.match(text, /Copilot CLI\s+\$0\.07\s+5 requests\s+53 AI credits, 1 not priced/);
        assert.match(text, /Copilot counted 53 AI credits \(\$0\.53 at \$0\.01\) and 2 premium requests/);
        assert.doesNotMatch(text, /SECRET PROMPT/);
    });
});
test("copilot: no session-state folder is no Copilot row", async () => {
    await sandbox((home) => {
        const r = spendReport(30, { home, now: NOW, claudePaths: [], progress: false });
        assert.equal(r.tools.find((x) => x.tool === "copilot"), undefined);
        assert.match(renderSpend(r), /Gemini CLI, Cursor or Copilot CLI on this machine/);
    });
});
