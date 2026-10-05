/**
 * `savings` replays real transcripts through the shipped AutoClearer. Pinned:
 * a session with stale tool output and an idle gap past the cache TTL shows a
 * saving; one without either shows none; nothing is ever reported as saved
 * that made the session more expensive; the baseline is the billed usage.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateSavings, renderSavings, replaySession } from "../savings.js";
const file = (lines) => {
    const dir = mkdtempSync(join(tmpdir(), "cd-sav-"));
    const p = join(dir, "s.jsonl");
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"));
    return p;
};
const big = "const value = compute(input, options); // step\n".repeat(400);
/** A Read-heavy session: `n` tool calls, one per request; an idle `gapAfter` hours after request `gapAt`. */
function session(n, gapAt = -1, gapAfterHours = 2) {
    // Relative to now: the report counts only the last N days, and a fixed date
    // silently fell out of the window a month after it was written.
    const start = Date.now() - 3 * 86_400_000;
    const lines = [{ type: "user", message: { role: "user", content: "fix the build" }, timestamp: new Date(start).toISOString() }];
    let t = start, prompt = 60_000;
    for (let i = 0; i < n; i++) {
        t += (i === gapAt ? gapAfterHours * 3_600_000 : 30_000);
        lines.push({ type: "assistant", timestamp: new Date(t).toISOString(), message: { id: `msg_${i}`, model: "claude-opus-5", content: [{ type: "tool_use", id: `toolu_${i}`, name: "Read", input: { file_path: `/f${i}.ts` } }], usage: { input_tokens: 5, cache_read_input_tokens: prompt, cache_creation_input_tokens: 8000, output_tokens: 50 } } });
        lines.push({ type: "user", timestamp: new Date(t + 1000).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: big }] } });
        prompt += 8000;
    }
    return file(lines);
}
test("savings: stale tool output plus an idle gap past the TTL is cleared, and never costs more", () => {
    const s = replaySession(session(30, 20));
    assert.ok(s.savedPct > 0.05, `expected a real saving, got ${s.savedPct}`);
    assert.ok(s.savedUsd > 0 && s.savedUsd < s.billedUsd);
    assert.equal(s.requests, 30);
});
test("savings: without an idle gap nothing is cleared (warm cache is never paid for)", () => {
    const s = replaySession(session(30));
    // Only the first request is cold; the history then is too small to clear.
    assert.equal(s.savedUsd, 0);
});
test("savings: the baseline is the billed usage recorded in the transcript", () => {
    const s = replaySession(session(12));
    let billed = 0, prompt = 60_000;
    for (let i = 0; i < 12; i++) {
        billed += 5 + prompt * 0.1 + 8000 * 1.25;
        prompt += 8000;
    }
    assert.equal(Math.round(s.billedWeighted), Math.round(billed));
});
test("savings: short sessions are skipped, and the report renders either way", () => {
    assert.equal(replaySession(session(3)), undefined);
    const empty = estimateSavings(30, {}, []);
    assert.match(renderSavings(empty), /No Claude Code sessions/);
    const r = estimateSavings(30, {}, [session(30, 20), session(30)]);
    assert.equal(r.sessions.length, 2);
    assert.equal(r.worse, 0);
    const text = renderSavings(r);
    assert.match(text, /Input you were billed for/);
    assert.match(text, /2\. Autopilot/);
    assert.match(text, /autopilot on/);
    assert.doesNotMatch(renderSavings(r, true), /Turn it on/);
});
test("savings: the compact-window lever renders within 80 columns, set or not", () => {
    const r = estimateSavings(30, {}, [session(30, 20), session(30)]);
    const cw = { window: 400_000, savedUsd: 3360, compactionsPerWeek: 14.7, nowPerWeek: 4.9, isCurrent: false };
    const text = renderSavings(r, false, cw);
    assert.match(text, /3\. Compact earlier \(400k window\)/);
    assert.match(text, /Set it: +context-doctor compact-window 400k/);
    for (const line of text.split("\n"))
        assert.ok(line.length <= 80, `too wide: ${line}`);
    const set = renderSavings(r, false, { ...cw, isCurrent: true });
    assert.match(set, /as you have it set/);
    assert.doesNotMatch(set, /Set it:/);
    assert.doesNotMatch(renderSavings(r), /3\. Compact earlier/);
});
