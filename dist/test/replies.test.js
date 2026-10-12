/**
 * Counting API replies, not transcript rows. Claude Code writes one reply as
 * several rows carrying the same usage, writes "<synthetic>" placeholder
 * rows that are not requests, and a forked session starts as a verbatim copy
 * of its parent's transcript in a new file. Each reply must be counted and
 * priced once, at its own model's price.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeCacheUsage } from "../cache.js";
import { subagentReport } from "../subagents.js";
import { estimateSavings, replaySession } from "../savings.js";
import { costPerTask, sessionCost } from "../tasks.js";
import { estimateCompactWindows } from "../compactwindow.js";
import { measureBaselines } from "../overhead.js";
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const iso = (ms) => new Date(ms).toISOString();
const dir = () => mkdtempSync(join(tmpdir(), "cd-replies-"));
function write(d, name, rows) {
    const p = join(d, name);
    writeFileSync(p, jsonl(rows));
    return p;
}
/** One API reply written the way Claude Code writes it: one row per content block, same id, same usage. */
function reply(id, blocks, usage, at, model = "claude-opus-5-5", extra = {}) {
    return Array.from({ length: blocks }, (_, i) => ({
        type: "assistant",
        uuid: `${id}-row${i}`,
        timestamp: iso(at),
        ...extra,
        message: { id, model, role: "assistant", content: [{ type: "text", text: `block ${i}` }], usage },
    }));
}
const synthetic = (at) => ({
    type: "assistant",
    uuid: `syn-${at}`,
    timestamp: iso(at),
    message: { id: `syn-${at}`, model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "No response requested." }], usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
});
test("cache: one request per API reply, not per row; <synthetic> is not a request; 1-hour writes at 2x", () => {
    const t = Date.now() - 3_600_000;
    const a = { input_tokens: 10, cache_creation_input_tokens: 20_000, cache_read_input_tokens: 0, output_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20_000 } };
    const b = { input_tokens: 5, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 20_000, output_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 0 } };
    const p = write(dir(), "s.jsonl", [...reply("msg_A", 3, a, t), ...reply("msg_B", 2, b, t + 1000), synthetic(t + 2000)]);
    const u = analyzeCacheUsage(p);
    assert.equal(u.requests, 2, "five rows and a placeholder are two requests");
    assert.equal(u.cacheWriteTokens, 21_000);
    assert.equal(u.cacheWrite1hTokens, 20_000);
    assert.equal(u.cacheReadTokens, 20_000);
    assert.equal(u.model, "claude-opus-5-5", "the <synthetic> row is not the model");
    // Opus 5.5 ($4 in, $0.20 read): 15 uncached + 20k written at 2x + 1k at 1.25x + 20k read.
    const paid = (15 * 4 + 20_000 * 2 * 4 + 1_000 * 1.25 * 4 + 20_000 * 0.2) / 1e6;
    assert.ok(Math.abs(u.paidUsd - paid) < 1e-12, `${u.paidUsd} vs ${paid}`);
});
test("subagents: a reply written as three rows is one call, billed once", () => {
    const d = dir();
    const t = Date.now() - 3_600_000;
    const parent = write(d, "sess.jsonl", [{ type: "user", uuid: "p0", timestamp: iso(t), message: { role: "user", content: "go" } }]);
    const subs = join(d, "sess", "subagents");
    mkdirSync(subs, { recursive: true });
    const usage = { input_tokens: 100, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 0, output_tokens: 200, cache_creation: { ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: 0 } };
    writeFileSync(join(subs, "agent-x.jsonl"), jsonl([
        { type: "user", isSidechain: true, uuid: "s0", timestamp: iso(t), message: { role: "user", content: "audit the API" } },
        ...reply("msg_S1", 3, usage, t + 1000, "claude-haiku-4-5", { isSidechain: true }),
    ]));
    const r = subagentReport(parent);
    assert.equal(r.agents[0].calls, 1);
    assert.equal(r.agents[0].inputBilledTokens, 10_100);
    // Haiku 4.5 ($1 in, $5 out): 100 in + 10k written at 1.25x + 200 out.
    const cost = (100 + 10_000 * 1.25 + 200 * 5) / 1e6;
    assert.ok(Math.abs(r.totalCostUsd - cost) < 1e-12, `${r.totalCostUsd} vs ${cost}`);
});
test("a reply's output is its final count: its early rows are written mid-stream", () => {
    const d = dir();
    const t = Date.now() - 3_600_000;
    const u = (output_tokens) => ({ input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens });
    const rows = (extra = {}) => [10, 10, 300].map((out, i) => ({ type: "assistant", uuid: `r${i}`, timestamp: iso(t), ...extra, message: { id: "msg_X", model: "claude-haiku-4-5", role: "assistant", content: [{ type: "text", text: `b${i}` }], usage: u(out) } }));
    // Haiku 4.5: 100 input at $1/M, 300 output at $5/M.
    const cost = (100 + 300 * 5) / 1e6;
    const s = sessionCost(write(d, "main.jsonl", rows()));
    assert.equal(s.requests, 1);
    assert.ok(Math.abs(s.usd - cost) < 1e-12, `${s.usd} vs ${cost}`);
    writeFileSync(join(d, "main.jsonl"), jsonl([{ type: "user", uuid: "p", timestamp: iso(t), message: { role: "user", content: "go" } }]));
    mkdirSync(join(d, "main", "subagents"), { recursive: true });
    writeFileSync(join(d, "main", "subagents", "agent-z.jsonl"), jsonl(rows({ isSidechain: true })));
    const r = subagentReport(join(d, "main.jsonl"));
    assert.equal(r.agents[0].outputTokens, 300);
    assert.ok(Math.abs(r.totalCostUsd - cost) < 1e-12, `${r.totalCostUsd} vs ${cost}`);
});
test("savings: each request at its own model, and a session that opens with a <synthetic> row is still priced", () => {
    const t0 = Date.now() - 6 * 3_600_000;
    const usage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 100_000, output_tokens: 10 };
    const rows = [{ type: "user", uuid: "u0", timestamp: iso(t0), message: { role: "user", content: "hi" } }, synthetic(t0 + 500)];
    for (let i = 0; i < 12; i++)
        rows.push(...reply(`msg_${i}`, 1, usage, t0 + (i + 1) * 60_000, i < 6 ? "claude-opus-5-5" : "claude-fable-5-1"));
    const s = replaySession(write(dir(), "s.jsonl", rows));
    assert.equal(s.requests, 12);
    assert.equal(s.model, "claude-opus-5-5");
    // Six requests reading 100k at Opus 5.5's $0.20/M, six at Fable 5.1's $0.25/M.
    const billed = (6 * 100_000 * 0.2 + 6 * 100_000 * 0.25) / 1e6;
    assert.ok(Math.abs(s.billedUsd - billed) < 1e-12, `${s.billedUsd} vs ${billed}`);
});
/** A parent session and a fork of it: the parent's rows copied verbatim, then the fork's own turns. */
function forkedPair() {
    const d = dir();
    const t0 = Date.now() - 6 * 3_600_000;
    const usage = (prompt) => ({ input_tokens: 5, cache_read_input_tokens: prompt, cache_creation_input_tokens: 2_000, output_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2_000 } });
    const turns = (tag, from, n, start) => {
        const rows = [];
        for (let i = 0; i < n; i++) {
            const k = from + i, at = start + i * 60_000, tool = `toolu_${tag}${k}`;
            const command = k === 0 ? "git add -A && git commit -m first" : "ls";
            rows.push({ type: "assistant", uuid: `${tag}-a${k}`, cwd: "/w/app", timestamp: iso(at), message: { id: `msg_${tag}${k}`, model: "claude-opus-5-5", role: "assistant", content: [{ type: "tool_use", id: tool, name: "Bash", input: { command } }], usage: usage(60_000 + k * 2_000) } });
            rows.push({ type: "user", uuid: `${tag}-u${k}`, cwd: "/w/app", timestamp: iso(at + 1000), message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool, content: "ok" }] } });
        }
        return rows;
    };
    const parentRows = [{ type: "user", uuid: "start", cwd: "/w/app", timestamp: iso(t0), message: { role: "user", content: "ship it" } }, ...turns("p", 0, 12, t0)];
    const parent = write(d, "parent.jsonl", parentRows);
    const fork = write(d, "fork.jsonl", [...parentRows, ...turns("f", 12, 12, t0 + 3_000_000)]);
    return { parent, fork };
}
test("a forked session's copy of its parent's history is counted once by savings, tasks, compact-window and overhead", () => {
    const { parent, fork } = forkedPair();
    const close = (a, b) => Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b));
    // The fork alone holds every request; the pair must add up to exactly that.
    const savPair = estimateSavings(30, {}, [parent, fork]);
    const savFork = estimateSavings(30, {}, [fork]);
    assert.equal(savPair.sessions.reduce((n, s) => n + s.requests, 0), 24, "12 in the parent + 12 of the fork's own");
    assert.ok(close(savPair.billedUsd, savFork.billedUsd), `${savPair.billedUsd} vs ${savFork.billedUsd}`);
    const tasksPair = costPerTask(30, [parent, fork]);
    assert.equal(tasksPair.commits, 1, "the parent's commit, copied into the fork, is one commit");
    assert.ok(close(tasksPair.usd, costPerTask(30, [fork]).usd));
    assert.equal(costPerTask(30, [fork, parent]).commits, 1, "whichever file comes first");
    const cwPair = estimateCompactWindows([1_000_000], 30, [parent, fork]).estimates[0];
    const cwFork = estimateCompactWindows([1_000_000], 30, [fork]).estimates[0];
    assert.ok(close(cwPair.baselineUsd, cwFork.baselineUsd), `${cwPair.baselineUsd} vs ${cwFork.baselineUsd}`);
    const claude = measureBaselines(30, [parent, fork]).find((b) => b.agent === "Claude Code");
    assert.equal(claude.requests, 24);
    assert.equal(claude.sessions, 1, "the fork's first request is its parent's, not a second session start");
});
