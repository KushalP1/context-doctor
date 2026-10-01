/**
 * Cold resume: a return to a big session after the prompt cache expired.
 * Pinned: detection thresholds, the note's numbers, once-per-idle in the real
 * hook, the replay arithmetic (including the losing case), and the savings
 * report's honesty about which surfaces autopilot can reach.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { coldResumeEvents, detectColdResume, renderColdResume } from "../coldresume.js";
import { estimateSavings, renderSavings } from "../savings.js";
import { reachNote } from "../autopilot.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const HOUR = 3_600_000;
const T0 = Date.parse("2026-09-01T10:00:00Z");
/** A transcript whose requests carry the given prompt sizes and times; padded so the hook's size gate passes. */
function transcript(reqs, opts = {}) {
    const dir = mkdtempSync(join(tmpdir(), "cd-cold-"));
    const p = join(dir, "s.jsonl");
    const lines = [{ type: "user", entrypoint: opts.entrypoint, timestamp: new Date(reqs[0].at - 1000).toISOString(), message: { role: "user", content: "x".repeat(opts.pad ?? 0) } }];
    reqs.forEach((r, i) => {
        lines.push({ type: "assistant", entrypoint: opts.entrypoint, timestamp: new Date(r.at).toISOString(), message: { id: `m${i}`, model: "claude-opus-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 5, cache_read_input_tokens: r.prompt - 5, cache_creation_input_tokens: 0, output_tokens: 10 } } });
        lines.push({ type: "user", entrypoint: opts.entrypoint, timestamp: new Date(r.at + 1000).toISOString(), message: { role: "user", content: "next" } });
    });
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"));
    return p;
}
test("detect: big and idle past the TTL is a cold resume; small or recent is not", () => {
    const p = transcript([{ at: T0, prompt: 300_000 }]);
    const c = detectColdResume(p, T0 + 2 * HOUR);
    assert.equal(c.tokens, 300_000);
    assert.equal(c.lastReplyAt, T0);
    assert.ok(Math.abs(c.resumeUsd - 300_000 * 1.25 * 5 / 1e6) < 1e-9, "cache write at Opus list price");
    assert.ok(Math.abs(c.perMessageUsd - 300_000 * 0.5 / 1e6) < 1e-9, "cached re-read");
    assert.equal(detectColdResume(p, T0 + 30 * 60_000), undefined, "30 minutes: cache still warm");
    assert.equal(detectColdResume(transcript([{ at: T0, prompt: 100_000 }]), T0 + 2 * HOUR), undefined, "small: not worth it");
    const note = renderColdResume(c);
    assert.match(note, /idle for 2\.0 hours/);
    assert.match(note, /\/compact/);
    assert.match(note, /85% cheaper/);
});
test("hook: the note appears on the first prompt after idle, and only once", async () => {
    // Timestamps from 2026-09-01 are long past, so "now" is always idle; pad clears the size gate.
    const p = transcript([{ at: T0, prompt: 400_000 }], { pad: 300_000 });
    const dir = mkdtempSync(join(tmpdir(), "cd-coldhook-"));
    const run = () => new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [cliPath, "hook"], { env: { ...process.env, CONTEXT_DOCTOR_HOOK_STATE: join(dir, "state.json") } }, (err, out) => (err ? reject(err) : resolve(out)));
        child.stdin.end(JSON.stringify({ session_id: "cold-1", transcript_path: p }));
    });
    const first = await run();
    assert.match(first, /longer than the prompt cache lasts/);
    const second = await run();
    assert.doesNotMatch(second, /longer than the prompt cache lasts/);
});
test("replay: compacting at a cold resume pays off over many later messages and loses a little over few", () => {
    const long = [{ at: T0, prompt: 500_000 }, { at: T0 + 2 * HOUR, prompt: 500_000 }];
    for (let i = 1; i <= 30; i++)
        long.push({ at: T0 + 2 * HOUR + i * 60_000, prompt: 500_000 + i * 2000 });
    const [win] = coldResumeEvents(transcript(long));
    assert.equal(win.messagesAfter, 30);
    // 30 cached re-reads of the 455k removed, minus the compaction request, at $5/M.
    const expected = ((30 * 0.1 * 455_000) - (0.1 * 500_000 + 5 * 8000 + 1.25 * 45_000)) * 5 / 1e6;
    assert.ok(Math.abs(win.netUsd - expected) < 1e-9, `${win.netUsd} vs ${expected}`);
    const [lose] = coldResumeEvents(transcript([{ at: T0, prompt: 500_000 }, { at: T0 + 2 * HOUR, prompt: 500_000 }]));
    assert.ok(lose.netUsd < 0 && lose.netUsd > -1, "left right after: a small loss, not a big one");
});
test("savings: desktop sessions are reported as unreachable by autopilot; the window counts only its own requests", () => {
    const reqs = [];
    for (let i = 0; i < 40; i++)
        reqs.push({ at: Date.now() - 2 * 86_400_000 + i * 60_000, prompt: 200_000 + i * 1000 });
    const desk = transcript(reqs, { entrypoint: "claude-desktop" });
    const r = estimateSavings(30, {}, [desk]);
    assert.equal(r.unreachableSessions, 1);
    assert.equal(r.reachableUsd, 0);
    assert.match(renderSavings(r), /n\/a[\s\S]*desktop app/);
    const none = estimateSavings(1, {}, [desk]);
    assert.equal(none.sessions.length, 0, "all 40 requests are two days old: outside a 1-day window");
});
test("reachNote: warns when recent sessions ran in the desktop app, silent when none did", () => {
    const home = mkdtempSync(join(tmpdir(), "cd-reach-"));
    const proj = join(home, ".claude", "projects", "p");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "a.jsonl"), JSON.stringify({ type: "user", entrypoint: "claude-desktop" }));
    const saved = { home: process.env.HOME, profile: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
        assert.match(reachNote(7).join("\n"), /desktop app/);
        writeFileSync(join(proj, "a.jsonl"), JSON.stringify({ type: "user", entrypoint: "cli" }));
        assert.deepEqual(reachNote(7), []);
    }
    finally {
        if (saved.home === undefined)
            delete process.env.HOME;
        else
            process.env.HOME = saved.home;
        if (saved.profile === undefined)
            delete process.env.USERPROFILE;
        else
            process.env.USERPROFILE = saved.profile;
    }
});
test("detect: no cold-resume alarm after /compact, even when the pre-compaction reply was huge", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-coldcompact-"));
    const p = join(dir, "s.jsonl");
    const lines = [
        { type: "assistant", timestamp: new Date(T0).toISOString(), message: { id: "m0", model: "claude-opus-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 5, cache_read_input_tokens: 800_000, cache_creation_input_tokens: 0, output_tokens: 10 } } },
        { type: "system", subtype: "compact_boundary", timestamp: new Date(T0 + 60_000).toISOString() },
        { type: "user", isCompactSummary: true, timestamp: new Date(T0 + 61_000).toISOString(), message: { role: "user", content: "summary" } },
    ];
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"));
    assert.equal(detectColdResume(p, T0 + 3 * HOUR), undefined);
});
test("savings --share: totals only, never a project name or path", async () => {
    const { renderShare } = await import("../savings.js");
    const reqs = [{ at: Date.now() - 5 * HOUR, prompt: 500_000 }, { at: Date.now() - 3 * HOUR, prompt: 500_000 }];
    for (let i = 1; i <= 30; i++)
        reqs.push({ at: Date.now() - 3 * HOUR + i * 60_000, prompt: 500_000 + i * 1000 });
    const p = transcript(reqs, { entrypoint: "claude-desktop" });
    const r = estimateSavings(30, {}, [p]);
    const text = renderShare(r);
    assert.match(text, /My Claude Code input, last 30 days/);
    assert.match(text, /\/compact/);
    assert.match(text, /npx context-doctor savings/);
    assert.doesNotMatch(text, new RegExp(r.sessions[0].project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(text, /\/tmp|\/Users|\.jsonl/);
});
