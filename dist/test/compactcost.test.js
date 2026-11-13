/**
 * A compaction's own request, which no transcript row records usage for:
 * estimated from its boundary (the context it read) and its summary (the
 * output), and counted by spend, the budget and a session's price alike, so
 * the mod's comparison with Claude Code's own cost (which holds it) closes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newTrack, SUMMARY_TOKENS_UNSEEN, trackCompaction } from "../compactcost.js";
import { periodSpend } from "../budget.js";
import { claudeSpend, renderSpend, summarizeSpend } from "../spend.js";
import { sessionTotal } from "../sessionprice.js";
import { requestCost } from "../pricing.js";
import { clearScanMemo } from "../scan.js";
import { tokensForLength } from "../tokens.js";
import { withSandboxHome } from "./sandbox.js";
const MIN = 60_000, HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 10, 12, 18, 0, 0);
const T0 = NOW - 6 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const MODEL = "claude-opus-5-5";
const reply = (id, at, usage, extra = {}) => ({ type: "assistant", uuid: `u-${id}`, sessionId: "s1", timestamp: iso(at), message: { id, model: MODEL, role: "assistant", content: [{ type: "text", text: "ok" }], usage }, ...extra });
const boundary = (id, at, pre, sessionId = "s1") => ({ type: "system", subtype: "compact_boundary", uuid: id, sessionId, timestamp: iso(at), content: "Conversation compacted", compactMetadata: { trigger: "auto", preTokens: pre } });
const summary = (at, chars) => ({ type: "user", isCompactSummary: true, sessionId: "s1", timestamp: iso(at), message: { role: "user", content: "x".repeat(chars) } });
const w1h = (n) => ({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: n });
/** One session: a compaction mid-turn on a live cache, then one after a 3-hour idle on the 1-hour cache. */
const ROWS = [
    reply("m0", T0, { input_tokens: 10, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 20_000, cache_creation: w1h(20_000), output_tokens: 1_000 }),
    boundary("c1", T0 + MIN, 420_010),
    summary(T0 + MIN + 500, 40_000),
    reply("m1", T0 + 2 * MIN, { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 30_000, cache_creation: w1h(30_000), output_tokens: 500 }),
    boundary("c2", T0 + 3 * HOUR + 2 * MIN, 50_000),
    summary(T0 + 3 * HOUR + 2 * MIN + 500, 8_000),
    reply("m2", T0 + 3 * HOUR + 3 * MIN, { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 25_000, cache_creation: w1h(25_000), output_tokens: 300 }),
];
// Opus 5.5: $4 in, $20 out, reads $0.20, 1-hour writes 2x.
const S1 = tokensForLength(40_000, false, MODEL), S2 = tokensForLength(8_000, false, MODEL);
const WARM = (420_010 * 0.2 + S1 * 20) / 1e6;
const COLD = (50_000 * 8 + S2 * 20) / 1e6;
const ROWS_USD = ROWS.filter((r) => r.type === "assistant").reduce((n, r) => n + requestCost(MODEL, r.message.usage, Date.parse(r.timestamp)).totalUsd, 0);
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);
test("a compaction's request: the context read from a live cache, or written again past its life; the summary as output", () => {
    const st = newTrack();
    const out = ROWS.map((r) => trackCompaction(st, r)).filter((x) => x !== undefined);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((c) => [c.uuid, c.warm, c.model]), [["c1", true, MODEL], ["c2", false, MODEL]]);
    near(out[0].cost.totalUsd, WARM, "mid-turn: read");
    near(out[1].cost.totalUsd, COLD, "after 3 hours on the 1-hour cache: written again");
    // No summary row before the next reply: the measured median's output.
    const lone = newTrack();
    const got = [ROWS[0], boundary("c3", T0 + MIN, 420_010), ROWS[3]].map((r) => trackCompaction(lone, r)).filter(Boolean);
    near(got[0].cost.totalUsd, (420_010 * 0.2 + SUMMARY_TOKENS_UNSEEN * 20) / 1e6, "summary unseen");
    // A boundary with no reply before it (nothing says the model): not priced.
    assert.equal([boundary("c4", T0, 1_000), summary(T0 + 1, 100)].map((r) => trackCompaction(newTrack(), r)).filter(Boolean).length, 0);
});
test("spend, the budget (read whole and appended) and the session price count each compaction's request, and the mod's gap to Claude Code's cost closes", async () => {
    const home = mkdtempSync(join(tmpdir(), "cd-compactcost-"));
    const cache = mkdtempSync(join(tmpdir(), "cd-compactcost-cache-"));
    const saved = process.env.CONTEXT_DOCTOR_CACHE_DIR;
    process.env.CONTEXT_DOCTOR_CACHE_DIR = cache;
    const real = Date.now;
    Date.now = () => NOW;
    try {
        await withSandboxHome(home, () => {
            const dir = join(home, ".claude", "projects", "-work-app");
            mkdirSync(dir, { recursive: true });
            const path = join(dir, "s1.jsonl");
            writeFileSync(path, ROWS.slice(0, 4).map((r) => JSON.stringify(r)).join("\n") + "\n");
            // The budget, read whole: the first compaction is in it.
            near(periodSpend("week", NOW, home).usd, ROWS_USD - requestCost(MODEL, ROWS[6].message.usage, Date.parse(ROWS[6].timestamp)).totalUsd + WARM, "budget, read whole");
            // The rest appended: the second, its boundary known from where the read stopped.
            appendFileSync(path, ROWS.slice(4).map((r) => JSON.stringify(r)).join("\n") + "\n");
            near(periodSpend("week", NOW, home).usd, ROWS_USD + WARM + COLD, "budget, appended");
            clearScanMemo();
            const items = claudeSpend(NOW - 7 * 24 * HOUR, NOW);
            near(items.reduce((n, i) => n + i.usd, 0), ROWS_USD + WARM + COLD, "spend");
            assert.equal(items.filter((i) => i.compaction).length, 2);
            const r = summarizeSpend(items, 7, NOW - 7 * 24 * HOUR, NOW);
            assert.deepEqual(r.compactions && [r.compactions.requests, Math.round(r.compactions.usd * 1e6)], [2, Math.round((WARM + COLD) * 1e6)]);
            assert.match(renderSpend(r), /Of it, 2 Claude Code compactions' own requests \$0\.\d\d, an estimate \(no row records their usage\)/);
            const t = sessionTotal({ sessionId: "s1", transcript: path }, NOW);
            near(t.usd, ROWS_USD + WARM + COLD, "session price");
            // Claude Code's own figure holds the compactions as billed (here: thinking added a little to each summary).
            const cc = ROWS_USD + WARM + COLD + (2 * 200 * 20) / 1e6;
            assert.ok(Math.abs(t.usd - cc) / cc < 0.01, `within 1%: ${t.usd} vs ${cc}`);
            assert.ok(Math.abs(ROWS_USD - cc) / cc > 0.05, `the rows alone were ${(((cc - ROWS_USD) / cc) * 100).toFixed(1)}% short`);
        });
    }
    finally {
        Date.now = real;
        if (saved === undefined)
            delete process.env.CONTEXT_DOCTOR_CACHE_DIR;
        else
            process.env.CONTEXT_DOCTOR_CACHE_DIR = saved;
        clearScanMemo();
        rmSync(home, { recursive: true, force: true });
        rmSync(cache, { recursive: true, force: true });
    }
});
