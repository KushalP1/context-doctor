/**
 * What Claude Code counts that the usage totals leave out, and Claude Code's
 * own figure beside ours (ROADMAP F1).
 *
 * A fixture session with: a plain request; one that consulted the advisor
 * (the shape of Anthropic's "Advisor tool" page: top-level usage is the sum
 * of the executor's iterations, the advisor's call is billed on top at its
 * own model); one a server-side fallback answered (the shape of a real reply
 * on the author's machine: top-level usage is the attempt that answered, the
 * declined attempt is billed on top), written as two rows; a client-side
 * refusal Claude Code retried (no row has its usage); and Claude Code's own
 * `cost-state`. Every total is checked against a hand count.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { billedCost, extraIterations, requestCost } from "../pricing.js";
import { claudeFileUsage, USAGE_ROWS } from "../limits.js";
import { claudeCodeSession, claudeSpend, renderSpend, sessionPriceEnded, spendReport } from "../spend.js";
import { compareSessions, gapParts, gapText, renderSessionComparison } from "../ccost.js";
import { periodSpend } from "../budget.js";
import { sessionTotal } from "../sessionprice.js";
import { claudeCodeCostCheck } from "../doctor.js";
import { clearScanMemo, rowsOf } from "../scan.js";
import { withSandboxHome } from "./sandbox.js";
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const SID = "f1000000-0000-4000-8000-00000000cc01";
const iso = (t) => new Date(t).toISOString();
// The advisor tool page's example, with a Fable 5.2 advisor (a valid pair for an Opus 5.5 executor).
const ADVISOR_USAGE = {
    input_tokens: 1760, cache_read_input_tokens: 412, cache_creation_input_tokens: 0, output_tokens: 531,
    iterations: [
        { type: "message", input_tokens: 412, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 89 },
        { type: "advisor_message", model: "claude-fable-5-2", input_tokens: 823, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1612 },
        { type: "message", input_tokens: 1348, cache_read_input_tokens: 412, cache_creation_input_tokens: 0, output_tokens: 442 },
    ],
};
// A reply on the author's machine (2.1.170): Fable 5 declined after reading 294k tokens, Opus 4.8 answered.
// Its top-level split (274,994 at 1 hour) is the first attempt's; its total is the last's.
const FALLBACK_USAGE = {
    input_tokens: 2, cache_creation_input_tokens: 236_045, cache_read_input_tokens: 39_344, output_tokens: 5656,
    cache_creation: { ephemeral_1h_input_tokens: 274_994, ephemeral_5m_input_tokens: 0 },
    iterations: [
        { input_tokens: 2, output_tokens: 723, cache_read_input_tokens: 19_672, cache_creation_input_tokens: 274_994, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 274_994 }, type: "message", model: "claude-fable-5" },
        { input_tokens: 2, output_tokens: 5656, cache_read_input_tokens: 39_344, cache_creation_input_tokens: 236_045, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 236_045 }, type: "fallback_message", model: "claude-opus-4-8" },
    ],
};
// By hand, USD per million: Opus 5.5 $4 / $20, reads $0.20, 1-hour writes $8; Fable 5.2 $8 / $40;
// Fable 5 $10 / $50, reads $1, 1-hour writes $20; Opus 4.8 $5 / $25, reads $0.50, 1-hour writes $10.
const PLAIN = (10 * 4 + 100_000 * 8 + 500 * 20) / 1e6;
const ADVISOR_EXECUTOR = (1760 * 4 + 412 * 0.2 + 531 * 20) / 1e6;
const ADVISOR_CALL = (823 * 8 + 1612 * 40) / 1e6;
const ANSWERED = (2 * 5 + 39_344 * 0.5 + 236_045 * 10 + 5656 * 25) / 1e6;
const DECLINED = (2 * 10 + 19_672 * 1 + 274_994 * 20 + 723 * 50) / 1e6;
const OURS = PLAIN + ADVISOR_EXECUTOR + ADVISOR_CALL + ANSWERED + DECLINED;
// Claude Code's own: the same, plus a request Fable 5.1 declined before a client-side retry ($0.30, no row) and its side requests on Haiku 5.5 ($0.05, 2 web searches).
const CC = OURS + 0.3 + 0.05;
test("the iterations a request's usage leaves out: an advisor's call, a declined attempt; none for the common request", () => {
    assert.deepEqual(extraIterations({ input_tokens: 5, iterations: [{ type: "message", input_tokens: 5 }] }), []);
    assert.deepEqual(extraIterations({ input_tokens: 5 }), []);
    const adv = extraIterations(ADVISOR_USAGE);
    assert.equal(adv.length, 1);
    assert.equal(adv[0].type, "advisor_message");
    assert.equal(adv[0].model, "claude-fable-5-2");
    const fb = extraIterations(FALLBACK_USAGE);
    assert.equal(fb.length, 1, "the answering attempt is the top-level usage: only the declined one is extra");
    assert.equal(fb[0].model, "claude-fable-5");
    assert.equal(fb[0].usage.cache_creation_input_tokens, 274_994);
    // A shape neither rule explains: only the advisor's (never in the top-level), nothing counted twice.
    const odd = extraIterations({ input_tokens: 7, iterations: [{ type: "message", input_tokens: 3 }, { type: "compaction", input_tokens: 2 }, { type: "advisor_message", model: "claude-opus-5-5", input_tokens: 9 }] });
    assert.deepEqual(odd.map((x) => x.type), ["advisor_message"]);
    // As billed, by hand.
    near(billedCost("claude-opus-5-5", ADVISOR_USAGE, NOW).totalUsd, ADVISOR_EXECUTOR + ADVISOR_CALL, "advisor");
    near(billedCost("claude-opus-5-5", ADVISOR_USAGE, NOW).extra.usd, ADVISOR_CALL, "advisor's call");
    near(billedCost("claude-opus-4-8", FALLBACK_USAGE, NOW).totalUsd, ANSWERED + DECLINED, "fallback");
    // requestCost stays the request's own usage.
    near(requestCost("claude-opus-4-8", FALLBACK_USAGE, NOW).totalUsd, ANSWERED, "top-level only");
});
/** The fixture session under `home`: its transcript's path. */
function writeSession(home, opts = {}) {
    const dir = join(home, ".claude", "projects", "-work-app");
    mkdirSync(dir, { recursive: true });
    const t0 = NOW - 2 * 3_600_000;
    let n = 0;
    const reply = (at, id, model, usage) => ({ type: "assistant", uuid: `u-${++n}`, sessionId: SID, timestamp: iso(at), version: "2.1.325", message: { id, model, role: "assistant", content: [{ type: "text", text: "ok" }], usage } });
    const rows = [
        { type: "user", uuid: "u-0", sessionId: SID, timestamp: iso(t0), message: { role: "user", content: "go" } },
        reply(t0 + 1000, "msg_plain", "claude-opus-5-5", { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 100_000, cache_creation: { ephemeral_1h_input_tokens: 100_000, ephemeral_5m_input_tokens: 0 }, output_tokens: 500, iterations: [{ type: "message", input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 100_000, output_tokens: 500 }] }),
        reply(t0 + 60_000, "msg_advisor", "claude-opus-5-5", ADVISOR_USAGE),
        { type: "system", subtype: "model_refusal_fallback", trigger: "refusal", originalModel: "claude-fable-5-1", fallbackModel: "claude-opus-4-8", uuid: "u-r", sessionId: SID, timestamp: iso(t0 + 90_000) },
        reply(t0 + 120_000, "msg_fallback", "claude-opus-4-8", FALLBACK_USAGE),
        // The same reply's later row: counted once.
        reply(t0 + 121_000, "msg_fallback", "claude-opus-4-8", FALLBACK_USAGE),
    ];
    if (opts.costState) {
        rows.push({
            type: "cost-state", sessionId: SID, totalCostUSD: CC, startTime: opts.restartedAt ?? t0 - 500,
            modelUsage: {
                "claude-opus-5-5": { inputTokens: 1770, outputTokens: 1031, cacheReadInputTokens: 412, cacheCreationInputTokens: 100_000, cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 100_000, webSearchRequests: 0, costUSD: PLAIN + ADVISOR_EXECUTOR },
                "claude-fable-5-2": { inputTokens: 823, outputTokens: 1612, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: ADVISOR_CALL },
                "claude-fable-5": { inputTokens: 2, outputTokens: 723, cacheReadInputTokens: 19_672, cacheCreationInputTokens: 274_994, cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 274_994, webSearchRequests: 0, costUSD: DECLINED },
                "claude-opus-4-8": { inputTokens: 2, outputTokens: 5656, cacheReadInputTokens: 39_344, cacheCreationInputTokens: 236_045, cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 236_045, webSearchRequests: 0, costUSD: ANSWERED },
                "claude-fable-5-1": { inputTokens: 2, outputTokens: 0, cacheReadInputTokens: 20_000, cacheCreationInputTokens: 14_000, webSearchRequests: 0, costUSD: 0.3 },
                "claude-haiku-5-5": { inputTokens: 300_000, outputTokens: 10_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 2, costUSD: 0.05 },
            },
            hasUnknownModelCost: false,
        });
    }
    const path = join(dir, `${SID}.jsonl`);
    writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    utimesSync(path, (t0 + 200_000) / 1000, (t0 + 200_000) / 1000);
    return path;
}
async function inHome(fn) {
    const home = mkdtempSync(join(tmpdir(), "cd-ccost-"));
    const real = Date.now;
    const saved = process.env.CONTEXT_DOCTOR_CACHE_DIR;
    process.env.CONTEXT_DOCTOR_CACHE_DIR = join(home, ".cache-cd");
    Date.now = () => NOW;
    clearScanMemo();
    try {
        return await withSandboxHome(home, () => fn(home));
    }
    finally {
        Date.now = real;
        if (saved === undefined)
            delete process.env.CONTEXT_DOCTOR_CACHE_DIR;
        else
            process.env.CONTEXT_DOCTOR_CACHE_DIR = saved;
        clearScanMemo();
        rmSync(home, { recursive: true, force: true });
    }
}
test("every Claude reader counts the advisor's call and the declined attempt, each at its own model: spend, the budget, the session price", async () => {
    await inHome((home) => {
        const path = writeSession(home);
        // The scan keeps the iterations only where some bill beyond the usage: the plain request's are dropped.
        const recs = rowsOf(path, USAGE_ROWS).filter((r) => r.type === "assistant" && r.message?.model);
        assert.equal(recs[0].message.usage.iterations, undefined);
        assert.equal(recs[1].message.usage.iterations.length, 3);
        const reqs = claudeFileUsage(path, 0);
        assert.equal(reqs.length, 3, "three requests, the streamed one once");
        near(reqs.reduce((n, r) => n + r.usd, 0), OURS, "claudeFileUsage");
        assert.equal(reqs[1].extra?.[0].model, "claude-fable-5-2");
        const items = claudeSpend(0, Infinity, [path]);
        near(items.reduce((n, it) => n + it.usd, 0), OURS, "spend");
        const advisor = items.find((it) => it.iteration === "advisor_message");
        assert.equal(advisor.model, "claude-fable-5-2");
        near(advisor.usd, ADVISOR_CALL, "the advisor's item");
        near(advisor.outputUsd, (1612 * 40) / 1e6, "its output, at its own rates");
        const declined = items.find((it) => it.iteration === "message");
        assert.equal(declined.model, "claude-fable-5");
        near(declined.usd, DECLINED, "the declined attempt's item");
        near(items.find((it) => it.model === "claude-opus-4-8").usd, ANSWERED, "the answer, its own usage");
        const r = spendReport(30, { claudePaths: [path], progress: false, now: NOW });
        assert.equal(r.requests, 3, "an iteration is not a request of its own");
        near(r.usd, OURS, "spend's total");
        assert.deepEqual(Object.keys(r.iterations ?? {}).sort(), ["advisor_message", "message"]);
        const text = renderSpend(r);
        assert.match(text, /Of it, 1 advisor call \$0\.07 \(claude-fable-5-2\), beyond their requests' usage totals/);
        assert.match(text, /Of it, 1 attempt a fallback model replaced \$5\.56 \(claude-fable-5\)/);
        // The budget and the every-prompt session price read the same rows.
        near(periodSpend("day", NOW, home).usd, OURS, "budget");
        near(sessionTotal({ sessionId: SID, transcript: path }, NOW).usd, OURS, "session price");
    });
});
test("a streamed reply whose advisor call is settled on a later row is counted once, with the call", async () => {
    await inHome((home) => {
        const dir = join(home, ".claude", "projects", "-work-app");
        mkdirSync(dir, { recursive: true });
        const at = NOW - 3_600_000;
        const first = { input_tokens: 412, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1, iterations: [{ type: "message", input_tokens: 412, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }] };
        const row = (t, usage) => JSON.stringify({ type: "assistant", uuid: `u-${t}`, sessionId: SID, timestamp: iso(t), message: { id: "msg_s", model: "claude-opus-5-5", usage } });
        const path = join(dir, "stream.jsonl");
        writeFileSync(path, [row(at, first), row(at + 5000, { ...ADVISOR_USAGE, input_tokens: 412 + 1348 })].join("\n") + "\n");
        const [q] = claudeFileUsage(path, 0);
        assert.equal(q.extra?.length, 1);
        near(q.extra[0].usd, ADVISOR_CALL, "the advisor's call, from the later row");
        near(q.usd, (412 * 4 + 531 * 20) / 1e6 + ADVISOR_CALL, "the first row's prompt, the settled output, the call");
    });
});
test("Claude Code's own figure beside ours, the gap taken apart: a declined request no row records, its side requests", async () => {
    await inHome((home) => {
        const path = writeSession(home, { costState: true });
        const [g] = compareSessions([path], claudeSpend(0, Infinity, [path]));
        near(g.ccUsd, CC, "Claude Code's");
        near(g.ourUsd, OURS, "ours");
        const p = gapParts([g]);
        near(p.declinedUsd, 0.3, "declined");
        assert.equal(p.declined, 1);
        assert.deepEqual(p.declinedModels, ["claude-fable-5-1"]);
        near(p.sideUsd, 0.05, "side requests");
        assert.equal(p.sideSearches, 2);
        assert.ok(Math.abs(p.tokensUsd) < 1e-9 && Math.abs(p.priceUsd) < 1e-9, `same tokens, same prices: ${p.tokensUsd} ${p.priceUsd}`);
        near(p.declinedUsd + p.sideUsd + p.tokensUsd + p.priceUsd, g.ccUsd - g.ourUsd, "the parts add up");
        const lines = renderSessionComparison(claudeCodeSession(path));
        assert.match(lines[0], /Claude Code's own figure for this session: \$9\.33; ours \$8\.98 \(-3\.8%\)/);
        assert.match(lines.join("\n"), /requests it declined \(1 refusal recorded\)/);
        assert.match(lines.join("\n"), /\$0\.05 more on claude-haiku-5-5, its own side requests \(2 web searches among them\)/);
        assert.match(gapText([g]).join("\n"), /From Claude Code 2\.1\.325 its figure also counts other mods' own model calls/);
        // spend: the sessions wholly in its window.
        const r = spendReport(30, { claudePaths: [path], progress: false, now: NOW });
        near(r.claudeCode.ccUsd, CC, "spend: Claude Code's");
        assert.match(renderSpend(r), /Claude Code's own figure \(its cost-state\), 1 session wholly in the window: \$9\.33; ours \$8\.98 \(-3\.8%\)\n  0 of the 1 over \$0\.50 within 2%/);
        // A session that began before the window is not compared.
        assert.equal(spendReport(1 / 48, { claudePaths: [path], progress: false, now: NOW }).claudeCode, undefined);
        // doctor: the check, from the transcripts alone (no mod).
        const c = claudeCodeCostCheck(30, NOW);
        assert.equal(c.status, "warn");
        assert.match(c.detail, /\$8\.98 against Claude Code.s \$9\.33 \(-3\.8%\) on 1 session of the last 30 days/);
    });
});
test("a record that restarted after the session began is compared from its own start; none, no comparison", async () => {
    await inHome((home) => {
        const t0 = NOW - 2 * 3_600_000;
        const path = writeSession(home, { costState: true, restartedAt: t0 + 100_000 });
        const [g] = compareSessions([path], claudeSpend(0, Infinity, [path]));
        assert.equal(g.from, t0 + 100_000);
        near(g.ourUsd, ANSWERED + DECLINED, "only the request after its start");
        rmSync(path);
        clearScanMemo();
        const bare = writeSession(home);
        assert.equal(claudeCodeSession(bare), undefined);
        assert.deepEqual(renderSessionComparison(undefined), []);
    });
});
test("a session priced past a price's end says which price ended and the one used, never silently", async () => {
    await inHome((home) => {
        const dir = join(home, ".claude", "projects", "-work-app");
        mkdirSync(dir, { recursive: true });
        // gpt-5.6-sol's promotion ends 2026-11-30 with no later price published; a request on 2026-12-02.
        const row = (t, model) => JSON.stringify({ type: "assistant", uuid: `u-${t}`, sessionId: SID, timestamp: iso(t), message: { id: `m-${t}`, model, usage: { input_tokens: 1000, output_tokens: 100 } } });
        const path = join(dir, "ended.jsonl");
        writeFileSync(path, [row(Date.UTC(2026, 10, 29), "gpt-5.6-sol"), row(Date.UTC(2026, 11, 2), "gpt-5.6-sol")].join("\n") + "\n");
        const said = sessionPriceEnded(path);
        assert.match(said, /^1 request \(\$0\.01\) priced past the day its model's price ended or changed: gpt-5\.6-sol's price ended on 2026-12-01 and no later price is published: priced at the one that ended \(\$4 in \/ \$20 out per M\)/);
        const before = join(dir, "before.jsonl");
        writeFileSync(before, row(Date.UTC(2026, 10, 29), "gpt-5.6-sol") + "\n");
        assert.equal(sessionPriceEnded(before), undefined);
    });
});
