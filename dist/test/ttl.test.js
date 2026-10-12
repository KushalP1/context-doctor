/**
 * Cache writes priced by TTL: 1.25x input at 5 minutes, 2x at 1 hour, as the
 * usage records them. Simulated writes (a cold re-read, a fresh context)
 * use the session's own mix. Claude Haiku 4.5 throughout: its price did not
 * change, so these isolate the TTL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaySession } from "../savings.js";
import { sessionCost } from "../tasks.js";
import { subagentReport } from "../subagents.js";
import { subagentPayback } from "../subagentpay.js";
import { estimateCompactWindows } from "../compactwindow.js";
import { measureBaseline } from "../overhead.js";
const MODEL = "claude-haiku-4-5"; // $1 in, $5 out, $0.10 cache read
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const iso = (ms) => new Date(ms).toISOString();
const close = (a, b) => Math.abs(a - b) < 1e-12;
function write(rows, name = "s.jsonl") {
    const p = join(mkdtempSync(join(tmpdir(), "cd-ttl-")), name);
    writeFileSync(p, jsonl(rows));
    return p;
}
/** Usage whose writes were all at one TTL. */
function usage(input, read, write, ttl = "1h", output = 0) {
    return {
        input_tokens: input,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: write,
        output_tokens: output,
        cache_creation: { ephemeral_5m_input_tokens: ttl === "5m" ? write : 0, ephemeral_1h_input_tokens: ttl === "1h" ? write : 0 },
    };
}
const assistant = (n, at, u, extra = {}) => ({
    type: "assistant",
    uuid: `a${n}`,
    timestamp: iso(at),
    ...extra,
    message: { id: `msg_${n}`, model: MODEL, role: "assistant", content: [{ type: "text", text: "ok" }], usage: u },
});
test("savings: the billed baseline weighs 1-hour writes at 2x", () => {
    const t0 = Date.now() - 6 * 3_600_000;
    const rows = [{ type: "user", uuid: "u", timestamp: iso(t0), message: { role: "user", content: "go" } }];
    let expected = 0;
    for (let i = 0; i < 12; i++) {
        const prompt = 60_000 + i * 8_000;
        rows.push(assistant(i, t0 + (i + 1) * 30_000, usage(5, prompt, 8_000)));
        expected += 5 + prompt * 0.1 + 8_000 * 2;
    }
    const s = replaySession(write(rows));
    assert.equal(Math.round(s.billedWeighted), Math.round(expected));
});
test("tasks: a 1-hour write costs 2x input", () => {
    const s = sessionCost(write([assistant(0, Date.now() - 60_000, usage(0, 0, 10_000))]));
    assert.ok(close(s.usd, (10_000 * 2 * 1) / 1e6), `${s.usd}`);
});
test("subagents: the bill follows the TTL split the usage records", () => {
    const d = mkdtempSync(join(tmpdir(), "cd-ttl-subs-"));
    const t = Date.now() - 3_600_000;
    writeFileSync(join(d, "sess.jsonl"), jsonl([{ type: "user", uuid: "p", timestamp: iso(t), message: { role: "user", content: "go" } }]));
    mkdirSync(join(d, "sess", "subagents"), { recursive: true });
    writeFileSync(join(d, "sess", "subagents", "agent-a.jsonl"), jsonl([
        { type: "user", uuid: "s", isSidechain: true, timestamp: iso(t), message: { role: "user", content: "look" } },
        assistant(1, t + 1000, usage(0, 0, 4_000, "5m"), { isSidechain: true }),
        assistant(2, t + 2000, usage(0, 4_000, 6_000, "1h"), { isSidechain: true }),
    ]));
    const r = subagentReport(join(d, "sess.jsonl"));
    const cost = (4_000 * 1.25 + 6_000 * 2 + 4_000 * 0.1) / 1e6;
    assert.ok(close(r.totalCostUsd, cost), `${r.totalCostUsd} vs ${cost}`);
});
test("subagent payback: the subagent's bill by its TTLs; what the parent avoids at the parent's own write price", () => {
    const d = mkdtempSync(join(tmpdir(), "cd-ttl-pay-"));
    const base = Date.now() - 2 * 86_400_000;
    const at = (min) => base + min * 60_000;
    const parent = join(d, "s1.jsonl");
    writeFileSync(parent, jsonl([
        { type: "assistant", uuid: "p1", timestamp: iso(at(0)), message: { id: "p1", model: MODEL, usage: usage(0, 100_000, 1_000, "1h"), content: [{ type: "tool_use", id: "toolu_X", name: "Task", input: {} }] } },
        { type: "user", uuid: "p1r", timestamp: iso(at(30)), message: { content: [{ type: "tool_result", tool_use_id: "toolu_X", content: "short summary" }] } },
        ...[31, 32, 33, 34, 35].map((m, i) => ({ type: "assistant", uuid: `p${i + 2}`, timestamp: iso(at(m)), message: { id: `p${i + 2}`, model: MODEL, usage: usage(0, 100_100, 0), content: [] } })),
    ]));
    const sub = join(d, "s1", "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "agent-abc.meta.json"), JSON.stringify({ agentType: "Explore", description: "Find the config", toolUseId: "toolu_X" }));
    writeFileSync(join(sub, "agent-abc.jsonl"), jsonl([
        { type: "user", isSidechain: true, timestamp: iso(at(1)), message: { content: "Find the config" } },
        ...[0, 1, 2, 3].map((i) => ({ type: "assistant", isSidechain: true, timestamp: iso(at(2 + i)), message: { id: `s${i}`, model: MODEL, usage: i === 0 ? usage(0, 0, 10_000, "1h") : usage(0, 10_000, 0) } })),
        { type: "user", isSidechain: true, timestamp: iso(at(3)), message: { content: [{ type: "tool_result", tool_use_id: "r1", content: "config line\n".repeat(4000) }] } },
    ]));
    const a = subagentPayback(30, [parent]).subagents[0];
    assert.ok(close(a.costUsd, (10_000 * 2 + 30_000 * 0.1) / 1e6), `${a.costUsd}`);
    // The parent wrote at the 1-hour TTL: carried reads cost it 2x once, then a cache read per later request.
    const avoided = ((a.readTokens - a.returnedTokens) * (2 * 1 + 5 * 0.1)) / 1e6;
    assert.ok(close(a.avoidedUsd, avoided), `${a.avoidedUsd} vs ${avoided}`);
});
test("compact-window: a cold re-write is charged at the session's own write mix", () => {
    const t0 = Date.now() - 86_400_000;
    // Ten requests a minute apart at a steady 100k: one cold write, nine warm reads, all writes at 1 hour.
    const rows = Array.from({ length: 10 }, (_, i) => assistant(i, t0 + i * 60_000, i === 0 ? usage(0, 0, 100_000) : usage(0, 99_000, 1_000)));
    const est = estimateCompactWindows([1_000_000], 30, [write(rows)]).estimates[0];
    const expected = (2 * 100_000 * 1 + 9 * 100_000 * 0.1) / 1e6;
    assert.ok(close(est.baselineUsd, expected), `${est.baselineUsd} vs ${expected}`);
});
test("overhead: a cold start re-writes the overhead at the recorded TTL mix", () => {
    const t0 = Date.now() - 3 * 3_600_000;
    const rows = [
        { type: "user", uuid: "u", timestamp: iso(t0), message: { role: "user", content: "hi" } },
        assistant(0, t0, usage(10, 28_990, 1_000)),
        assistant(1, t0 + 60_000, usage(10, 29_990, 1_000)),
        assistant(2, t0 + 2 * 3_600_000, usage(10, 30_990, 1_000)), // after an idle hour: a cold start
    ];
    const b = measureBaseline(30, [write(rows)]);
    assert.equal(b.coldStarts, 2);
    // One warm read at $0.10/M and two cold writes at 2 x $1/M, per 1k tokens, over a 30-day month.
    const expected = (1000 * (0.1 + 2 * 2 * 1)) / 1e6;
    assert.ok(close(b.usdPerKPerMonth, expected), `${b.usdPerKPerMonth} vs ${expected}`);
});
