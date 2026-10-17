/**
 * savings, compact-window and overhead read the same transcripts for the
 * same --days. They used to disagree with no explanation: savings said 37
 * sessions under an 85-step progress bar, overhead said 80, and savings'
 * billed $3,458 sat next to compact-window's "as now" $3,173 (the replay's
 * own model of the bill). Now savings and compact-window count the same
 * sessions and show the same billed baseline, and every count says what it
 * counts. The progress lines that explain the wait go to a terminal only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateCompactWindows, renderCompactWindows } from "../compactwindow.js";
import { compactionQuality } from "../compactquality.js";
import { mcpUsage } from "../mcpschema.js";
import { measureBaselines, renderOverhead, overheadReport } from "../overhead.js";
import { estimateSavings, renderSavings } from "../savings.js";
import { subagentPayback } from "../subagentpay.js";
import { sandboxEnv } from "./sandbox.js";
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
/** A Claude Code transcript of `n` requests a minute apart, growing, with 1-hour writes. */
function transcript(dir, name, n, model = "claude-opus-5") {
    const p = join(dir, `${name}.jsonl`);
    const start = Date.now() - 2 * 86_400_000;
    const rows = [{ type: "user", uuid: `${name}-u0`, timestamp: new Date(start - 1000).toISOString(), message: { role: "user", content: "go" } }];
    for (let i = 0; i < n; i++) {
        const prompt = 60_000 + i * 20_000;
        rows.push({
            type: "assistant",
            uuid: `${name}-a${i}`,
            timestamp: new Date(start + i * 60_000).toISOString(),
            message: {
                id: `${name}-m${i}`,
                model,
                content: [{ type: "text", text: "ok" }],
                usage: {
                    input_tokens: 5,
                    cache_read_input_tokens: i === 0 ? 0 : prompt - 20_005,
                    cache_creation_input_tokens: i === 0 ? prompt - 5 : 20_000,
                    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: i === 0 ? prompt - 5 : 20_000 },
                    output_tokens: 50,
                },
            },
        });
    }
    writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return p;
}
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "ctxdoc-consistency-"));
    return [
        transcript(dir, "long", 40),
        transcript(dir, "medium", 12),
        transcript(dir, "short", 3), // fewer than 10 requests: not replayed by savings or compact-window
        transcript(dir, "unpriced", 11, "some-unknown-model"), // counted, at $0, by both
    ];
}
const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
test("savings and compact-window count the same sessions and show the same billed baseline", () => {
    const paths = fixture();
    const s = estimateSavings(30, {}, paths);
    const cw = estimateCompactWindows([200_000, 400_000], 30, paths);
    assert.equal(s.sessions.length, 3);
    assert.equal(cw.sessions, s.sessions.length, "same sessions: 10+ requests of their own in the period");
    assert.equal(s.transcripts, 4);
    assert.equal(cw.transcripts, 4);
    assert.ok(s.billedUsd > 0);
    for (const e of cw.estimates) {
        assert.ok(close(e.baselineUsd, s.billedUsd), `"as now" ${e.baselineUsd} vs billed ${s.billedUsd}`);
        assert.ok(close(e.withWindowUsd + e.savedUsd, e.baselineUsd));
        assert.ok(e.replayBaselineUsd > 0, "the replay's own baseline is still reported");
    }
    // Both screens say what they count, in the same words.
    const label = "3 sessions with 10+ requests (of 4 transcripts)";
    assert.ok(renderSavings(s).includes(label), renderSavings(s));
    assert.ok(renderCompactWindows(cw).includes(label), renderCompactWindows(cw));
});
test("overhead says it counts sessions of any length, out of the same transcripts", () => {
    const paths = fixture();
    const b = measureBaselines(30, paths).find((x) => x.agent === "Claude Code");
    assert.equal(b.transcripts, 4);
    assert.equal(b.sessions, 4, "every transcript with a measurable first request, short ones included");
    const text = renderOverhead(overheadReport({ paths, cwd: dirname(paths[0]), home: dirname(paths[0]) }));
    assert.match(text, /4 sessions \(any length\)/);
});
test("the long readers report progress per transcript, ending at the total", () => {
    const paths = fixture();
    const seen = {};
    const rec = (k) => (done, total) => { (seen[k] ??= []).push([done, total]); };
    estimateSavings(30, {}, paths, rec("savings"));
    estimateCompactWindows([400_000], 30, paths, 0, rec("cw"));
    compactionQuality(60, paths, rec("compactions"));
    subagentPayback(30, paths, rec("subagents"));
    measureBaselines(30, paths, rec("overhead"));
    mcpUsage(30, paths, rec("mcp"));
    for (const [k, calls] of Object.entries(seen)) {
        assert.ok(calls.length >= paths.length, `${k}: ${JSON.stringify(calls)}`);
        assert.ok(calls.every(([, total]) => total === paths.length), k);
    }
    assert.deepEqual(seen.savings.at(-1), [4, 4], "savings ends at n/n");
    assert.deepEqual(seen.cw.at(-1), [4, 4]);
    assert.equal(Object.keys(seen).length, 6);
});
test("no progress text when stderr is not a terminal", () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-consistency-home-"));
    const project = join(home, ".claude", "projects", "-w-app");
    mkdirSync(project, { recursive: true });
    transcript(project, "s1", 12);
    for (const args of [["subagents"], ["compact-window"], ["overhead"], ["savings"]]) {
        const r = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: sandboxEnv(home), cwd: home, timeout: 60_000 });
        assert.equal(r.status, 0, `${args}: ${r.stderr}`);
        assert.ok(!/transcripts\x1b|\r/.test(r.stderr), `${args} wrote progress to a pipe: ${JSON.stringify(r.stderr)}`);
    }
});
