/**
 * An organization's contracted rates: Claude Code's managed `modelPricing`
 * (multiplier in (0, 10], rows of input / output / cacheRead / cacheWrite
 * charged as written; settings reference and the 2.1.321 binary, read
 * 2026-11-10). Where a managed settings file sets it, every report prices a
 * Claude request at those rates and says so: a fixture session with a Fable
 * 5.2 request, a fast-mode one and a subagent, priced alike by `spend`, the
 * budget, the session price, `subagents` and its payback, at list prices,
 * under a multiplier and under a row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalClaude, orgRates, orgRatesLine, parseOrgRates, priceBasis, readOrgRatesFrom, resetOrgRates } from "../orgrates.js";
import { requestCost } from "../pricing.js";
import { claudeSpend, renderSpend, summarizeSpend } from "../spend.js";
import { periodSpend, renderBudgetStatus } from "../budget.js";
import { sessionPriceDue } from "../sessionprice.js";
import { renderSubagents, subagentReport } from "../subagents.js";
import { subagentPayback } from "../subagentpay.js";
import { clearScanMemo } from "../scan.js";
import { diagnosedMisses } from "../missledger.js";
import { withSandboxHome } from "./sandbox.js";
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);
const AT = Date.UTC(2026, 10, 11, 12);
/** Run `fn` with `modelPricing` in a managed settings file (CLAUDE_CODE_MANAGED_SETTINGS_PATH), or none. */
async function withManaged(modelPricing, fn) {
    const dir = mkdtempSync(join(tmpdir(), "cd-org-"));
    const keys = ["CLAUDE_CODE_MANAGED_SETTINGS_PATH", "CONTEXT_DOCTOR_NO_MANAGED_SETTINGS"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    if (modelPricing !== undefined) {
        const path = join(dir, "managed-settings.json");
        writeFileSync(path, JSON.stringify({ permissions: { deny: [] }, modelPricing }));
        process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = path;
        delete process.env.CONTEXT_DOCTOR_NO_MANAGED_SETTINGS;
    }
    resetOrgRates();
    try {
        return await fn();
    }
    finally {
        for (const k of keys) {
            if (saved[k] === undefined)
                delete process.env[k];
            else
                process.env[k] = saved[k];
        }
        resetOrgRates();
        rmSync(dir, { recursive: true, force: true });
    }
}
test("modelPricing as Claude Code keeps it: multiplier in (0, 10], rows with all four rates in [0, 10000], the rest ignored", () => {
    assert.equal(parseOrgRates(undefined), undefined);
    assert.equal(parseOrgRates({}), undefined, "nothing set: list prices");
    assert.equal(parseOrgRates({ multiplier: 1 }), undefined, "a multiplier of 1 changes nothing");
    for (const bad of [0, -1, 10.5, "0.8", null])
        assert.equal(parseOrgRates({ multiplier: bad }), undefined, `multiplier ${bad}`);
    assert.equal(parseOrgRates({ multiplier: 10 }).multiplier, 10, "a markup up to 10");
    const r = parseOrgRates({
        multiplier: 0.85,
        overrides: {
            "claude-sonnet-4-6": { input: 2.4, output: 12, cacheRead: 0.24, cacheWrite: 3 },
            "claude-opus-5-5": { input: 3, output: 15, cacheRead: 0.15 }, // cacheWrite missing
            "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 20_000 }, // over 10000
            "my-gateway-model": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
        },
    });
    assert.equal(r.multiplier, 0.85);
    assert.deepEqual([...r.exact.keys()], ["claude-sonnet-4-6", "my-gateway-model"]);
    assert.deepEqual([...r.models.keys()], ["claude-sonnet-4-6"], "only a Claude key covers its other spellings");
    assert.deepEqual(r.exact.get("claude-sonnet-4-6"), { inputPerM: 2.4, outputPerM: 12, cacheReadPerM: 0.24, cacheWritePerM: 3 });
});
test("a Claude model's spellings: dated, [1m], Bedrock (any region prefix), Vertex", () => {
    for (const id of ["claude-sonnet-4-6", "claude-sonnet-4-6-20260101", "claude-sonnet-4-6[1m]", "anthropic.claude-sonnet-4-6", "us.anthropic.claude-sonnet-4-6-v1:0", "global.anthropic.claude-sonnet-4-6-v1:0", "claude-sonnet-4-6@20260101", "CLAUDE-SONNET-4-6"]) {
        assert.equal(canonicalClaude(id), "claude-sonnet-4-6", id);
    }
    assert.equal(canonicalClaude("gpt-5.5"), undefined);
    assert.equal(canonicalClaude("my-gateway-model"), undefined);
});
test("managed files merge as Claude Code merges them: the base, then drop-ins in order, key by key; hidden drop-ins skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-org-d-"));
    try {
        const base = join(dir, "managed-settings.json");
        mkdirSync(join(dir, "managed-settings.d"));
        const a = join(dir, "managed-settings.d", "10-rates.json");
        const b = join(dir, "managed-settings.d", "20-discount.json");
        const hidden = join(dir, "managed-settings.d", ".30-draft.json");
        writeFileSync(base, JSON.stringify({ modelPricing: { multiplier: 0.9, overrides: { "claude-opus-5-5": { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 3.75 } } } }));
        writeFileSync(a, JSON.stringify({ modelPricing: { overrides: { "claude-opus-5-5": { output: 14 }, "claude-sonnet-5-5": { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 1.875 } } } }));
        writeFileSync(b, JSON.stringify({ model: "opus", modelPricing: { multiplier: 0.8 } }));
        writeFileSync(hidden, JSON.stringify({ modelPricing: { multiplier: 0.1 } }));
        const r = readOrgRatesFrom([base, a, b, hidden, join(dir, "missing.json")]);
        assert.equal(r.multiplier, 0.8, "the later file's single value");
        assert.equal(r.exact.get("claude-opus-5-5").outputPerM, 14, "a row merged key by key");
        assert.equal(r.exact.get("claude-opus-5-5").cacheWritePerM, 3.75);
        assert.ok(r.exact.has("claude-sonnet-5-5"));
        assert.deepEqual(r.sources, [base, a, b]);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
/** 20 uncached, 10k written at 1 hour, 300k read, 1.5k out. */
const U = { input_tokens: 20, cache_creation_input_tokens: 10_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10_000 }, cache_read_input_tokens: 300_000, output_tokens: 1_500 };
test("requestCost under a multiplier: every Claude figure scaled, modifiers and web searches too; other providers at list", async () => {
    const list = requestCost("claude-opus-5-5", { ...U, speed: "fast", inference_geo: "us", server_tool_use: { web_search_requests: 3 } }, AT);
    const gpt = requestCost("gpt-5.5", U, AT);
    await withManaged({ multiplier: 0.85 }, () => {
        const c = requestCost("claude-opus-5-5", { ...U, speed: "fast", inference_geo: "us", server_tool_use: { web_search_requests: 3 } }, AT);
        near(c.totalUsd, list.totalUsd * 0.85, "total");
        near(c.modifiers.fastUsd, list.modifiers.fastUsd * 0.85, "fast part");
        near(c.modifiers.geoUsd, list.modifiers.geoUsd * 0.85, "US-only part");
        near(c.modifiers.webSearchUsd, 0.03 * 0.85, "searches");
        assert.equal(c.org, true);
        assert.equal(requestCost("gpt-5.5", U, AT).totalUsd, gpt.totalUsd, "Codex is billed by OpenAI, not under Claude Code's setting");
        assert.equal(requestCost("gpt-5.5", U, AT).org, undefined);
        assert.equal(priceBasis(), "at your organization's rates");
    });
    assert.equal(priceBasis(), "at list prices");
});
test("requestCost under a row: charged as written (one write rate for both lifetimes, no fast, US-only or tier), then the multiplier", async () => {
    const row = { input: 6, output: 30, cacheRead: 0.15, cacheWrite: 7.5 };
    const byHand = (u) => (Number(u.input_tokens) * 6 + Number(u.cache_creation_input_tokens) * 7.5 + Number(u.cache_read_input_tokens) * 0.15 + Number(u.output_tokens) * 30) / 1e6;
    await withManaged({ multiplier: 0.9, overrides: { "claude-fable-5-2": row, "corp-sonnet": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 } } }, () => {
        for (const id of ["claude-fable-5-2", "claude-fable-5-2-20261101", "claude-fable-5-2[1m]", "us.anthropic.claude-fable-5-2-v1:0"]) {
            const c = requestCost(id, { ...U, speed: "fast", inference_geo: "us" }, AT);
            near(c.totalUsd, byHand(U) * 0.9, id);
            assert.deepEqual([c.modifiers.fastUsd, c.modifiers.geoUsd, c.modifiers.longUsd], [0, 0, 0], id);
            assert.equal(c.org, true);
            assert.equal(c.estimated, undefined, "a contracted rate is not an estimate");
        }
        // 5-minute writes at the same rate as 1-hour ones.
        const five = { ...U, cache_creation: { ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: 0 } };
        near(requestCost("claude-fable-5-2", five, AT).totalUsd, byHand(U) * 0.9, "5-minute writes");
        // A web search keeps its list fee, under the multiplier.
        near(requestCost("claude-fable-5-2", { ...U, server_tool_use: { web_search_requests: 1 } }, AT).totalUsd, (byHand(U) + 0.01) * 0.9, "a search");
        // A key that is no Claude model prices its exact id only, and one the price table does not know.
        near(requestCost("corp-sonnet", U, AT).totalUsd, (20 * 1 + 10_000 * 1 + 300_000 * 0.1 + 1_500 * 5) / 1e6 * 0.9, "gateway alias");
        assert.equal(requestCost("corp-sonnet-2", U, AT), undefined);
        // Another Claude model: its list price, under the multiplier.
        near(requestCost("claude-opus-5-5", U, AT).totalUsd, (20 * 4 + 10_000 * 8 + 300_000 * 0.2 + 1_500 * 20) / 1e6 * 0.9, "no row: list x multiplier");
        assert.match(orgRatesLine(), /^Claude requests priced at your organization's rates \(Claude Code's managed modelPricing: multiplier 0\.9; 2 rows for claude-fable-5-2, corp-sonnet; in managed-settings\.json\)/);
    });
    // Ignored where Claude Code ignores it: CONTEXT_DOCTOR_NO_MANAGED_SETTINGS (and, by construction, user settings).
    await withManaged({ multiplier: 0.5 }, () => {
        process.env.CONTEXT_DOCTOR_NO_MANAGED_SETTINGS = "1";
        assert.equal(orgRates(), undefined);
    });
});
// ---------------------------------------------------------------------------
// One session, every report
// ---------------------------------------------------------------------------
const SESSION = "f4b1e000-0000-4000-8000-000000005252";
const MIN = 60_000;
/** A session on Fable 5.2: a request, a fast-mode one (streamed as two rows), and a subagent's request at the 5-minute TTL. */
function writeSession(home, start) {
    const dir = join(home, ".claude", "projects", "-Users-me-k1");
    mkdirSync(join(dir, SESSION, "subagents"), { recursive: true });
    const row = (id, k, usage, at, side = false) => JSON.stringify({
        type: "assistant", uuid: `${id}-${k}`, sessionId: SESSION, cwd: "/Users/me/k1", timestamp: new Date(at).toISOString(), ...(side ? { isSidechain: true } : {}),
        message: { id, model: "claude-fable-5-2", role: "assistant", content: [{ type: "text", text: "ok" }], usage },
    });
    const main = { input_tokens: 20, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 10_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10_000 }, speed: "standard", inference_geo: "global" };
    const path = join(dir, `${SESSION}.jsonl`);
    writeFileSync(path, [
        JSON.stringify({ type: "user", uuid: "k1-u0", sessionId: SESSION, timestamp: new Date(start).toISOString(), message: { role: "user", content: "go" } }),
        row("msg_k1_std", 0, { ...main, output_tokens: 1_500 }, start + MIN),
        row("msg_k1_fast", 0, { ...main, output_tokens: 100, speed: "fast" }, start + 2 * MIN),
        row("msg_k1_fast", 1, { ...main, output_tokens: 800, speed: "fast" }, start + 2 * MIN + 1_000),
    ].join("\n") + "\n");
    const sub = join(dir, SESSION, "subagents", "agent-a52.jsonl");
    writeFileSync(sub, [
        JSON.stringify({ type: "user", uuid: "k1-s0", isSidechain: true, sessionId: SESSION, timestamp: new Date(start + 3 * MIN).toISOString(), message: { role: "user", content: "look around" } }),
        row("msg_k1_sub", 0, { input_tokens: 1_000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 8_000, cache_creation: { ephemeral_5m_input_tokens: 8_000, ephemeral_1h_input_tokens: 0 }, output_tokens: 700 }, start + 4 * MIN, true),
    ].join("\n") + "\n");
    writeFileSync(join(dir, SESSION, "subagents", "agent-a52.meta.json"), JSON.stringify({ agentType: "Explore", description: "look around", toolUseId: "toolu_k1" }));
    for (const f of [path, sub])
        utimesSync(f, (start + 5 * MIN) / 1000, (start + 5 * MIN) / 1000);
    return path;
}
/** By hand, from the price page (Fable 5.2: $8 / $40, writes $10 and $16, reads $0.20; fast $16 / $80, reads $0.40). */
const LIST = {
    std: (20 * 8 + 10_000 * 16 + 300_000 * 0.2 + 1_500 * 40) / 1e6,
    fast: (20 * 16 + 10_000 * 32 + 300_000 * 0.4 + 800 * 80) / 1e6,
    sub: (1_000 * 8 + 8_000 * 10 + 50_000 * 0.2 + 700 * 40) / 1e6,
};
/** The same under a row of $6 / $30 / $0.15 reads / $7.50 writes and a 0.9 multiplier: no fast surcharge. */
const ROW = { input: 6, output: 30, cacheRead: 0.15, cacheWrite: 7.5 };
const AT_ROW = {
    std: ((20 * 6 + 10_000 * 7.5 + 300_000 * 0.15 + 1_500 * 30) / 1e6) * 0.9,
    fast: ((20 * 6 + 10_000 * 7.5 + 300_000 * 0.15 + 800 * 30) / 1e6) * 0.9,
    sub: ((1_000 * 6 + 8_000 * 7.5 + 50_000 * 0.15 + 700 * 30) / 1e6) * 0.9,
};
for (const [name, modelPricing, expected] of [
    ["at list prices", undefined, LIST],
    ["under a multiplier of 0.85", { multiplier: 0.85 }, { std: LIST.std * 0.85, fast: LIST.fast * 0.85, sub: LIST.sub * 0.85 }],
    ["under a row for claude-fable-5-2 and a multiplier of 0.9", { multiplier: 0.9, overrides: { "claude-fable-5-2": ROW } }, AT_ROW],
]) {
    test(`a Fable 5.2 session ${name}: spend, the budget, the session price, subagents and their payback agree, by hand`, async () => {
        const home = mkdtempSync(join(tmpdir(), "cd-org-h-"));
        const savedCache = process.env.CONTEXT_DOCTOR_CACHE_DIR;
        process.env.CONTEXT_DOCTOR_CACHE_DIR = join(home, ".cache-cd");
        const real = Date.now;
        const now = Date.UTC(2026, 10, 11, 12);
        Date.now = () => now;
        clearScanMemo();
        try {
            await withSandboxHome(home, () => withManaged(modelPricing, () => {
                const path = writeSession(home, now - 3_600_000);
                const total = expected.std + expected.fast + expected.sub;
                const since = now - 7 * 86_400_000;
                const items = claudeSpend(since, now, [path]);
                assert.equal(items.length, 3);
                near(items.reduce((s, i) => s + i.usd, 0), total, "spend");
                near(periodSpend("week", now, home).usd, total, "budget");
                near(sessionPriceDue({ sessionId: SESSION, transcript: path }, now, { CONTEXT_DOCTOR_SESSION_PRICE: "0.01" }).usd, total, "session price");
                const subs = subagentReport(path);
                near(subs.totalCostUsd, expected.sub, "subagents");
                const pay = subagentPayback(7, [path]);
                assert.equal(pay.subagents.length, 1);
                near(pay.subagents[0].costUsd, expected.sub, "subagents' payback");
                const text = renderSpend(summarizeSpend(items, 7, since, now));
                const status = renderBudgetStatus({ usd: 100, period: "week", block: false, at: now }, periodSpend("week", now, home), false);
                if (modelPricing) {
                    assert.match(text, /^Last 7 days, at your organization's rates$/m);
                    assert.match(text, /^Claude requests priced at your organization's rates/m);
                    assert.match(status, /^Claude requests priced at your organization's rates/m);
                    assert.match(renderSubagents(subs), /^Claude requests priced at your organization's rates/m);
                }
                else {
                    assert.match(text, /^Last 7 days, as billed at list rates$/m);
                    assert.doesNotMatch(text + status, /organization/);
                }
            }));
        }
        finally {
            Date.now = real;
            if (savedCache === undefined)
                delete process.env.CONTEXT_DOCTOR_CACHE_DIR;
            else
                process.env.CONTEXT_DOCTOR_CACHE_DIR = savedCache;
            clearScanMemo();
            rmSync(home, { recursive: true, force: true });
        }
    });
}
test("the budget's ledger, priced at list, is priced again when the organization's rates appear", async () => {
    const home = mkdtempSync(join(tmpdir(), "cd-org-l-"));
    const real = Date.now;
    const now = Date.UTC(2026, 10, 11, 12);
    Date.now = () => now;
    try {
        await withSandboxHome(home, async () => {
            const path = writeSession(home, now - 3_600_000);
            assert.ok(path);
            near(periodSpend("week", now, home).usd, LIST.std + LIST.fast + LIST.sub, "at list");
            await withManaged({ multiplier: 0.5 }, () => near(periodSpend("week", now, home).usd, (LIST.std + LIST.fast + LIST.sub) * 0.5, "the same ledger under a multiplier"));
            near(periodSpend("week", now, home).usd, LIST.std + LIST.fast + LIST.sub, "and back");
        });
    }
    finally {
        Date.now = real;
        rmSync(home, { recursive: true, force: true });
    }
});
test("cache-misses' diagnosed misses at the rates the rest of its report prices with: the multiplier, a row's own write rate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-org-miss-"));
    const log = join(dir, "misses.jsonl");
    try {
        // 400k tokens re-written on the 1-hour cache by Opus 5.5 ($4 in, writes 2x, reads $0.20): $3.12 above a read at list.
        writeFileSync(log, JSON.stringify({ ts: AT, at: AT / 1000, s: "s1", m: "claude-opus-5-5", n: 1, tok: 400_000, ttl: "1h", causes: ["tools_changed"] }) + "\n");
        near((await withManaged(undefined, () => diagnosedMisses(0, log))).extraUsd, (400_000 * (8 - 0.2)) / 1e6, "list");
        near((await withManaged({ multiplier: 0.5 }, () => diagnosedMisses(0, log))).extraUsd, (0.5 * 400_000 * (8 - 0.2)) / 1e6, "multiplier");
        const row = { overrides: { "claude-opus-5-5": { input: 3, output: 15, cacheRead: 0.1, cacheWrite: 4 } } };
        near((await withManaged(row, () => diagnosedMisses(0, log))).extraUsd, (400_000 * (4 - 0.1)) / 1e6, "a row's one write rate");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
