/**
 * `savings --sample`: a demonstration report. The sessions are synthetic,
 * written to a temp folder here and deleted right after; the report is the
 * real replay pipeline (replaySession, estimateSavings) run over them, so
 * every dollar is the product's own arithmetic on generated data. Nothing is
 * measured on the user's machine and no usage is invented for them: the
 * output says SAMPLE and says the data is generated. It is never substituted
 * for the real report: with no history, `savings` says so and offers the flag.
 *
 * Deterministic apart from the anchor time: contents come from a seeded
 * generator, timestamps are relative to `now` so the sessions always fall
 * inside the report's 30-day window.
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const MIN = 60_000;
const DAY = 86_400_000;
function rng(seed) {
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** A Read result, big enough to matter once it goes stale. */
const BIG_READ = "const value = compute(input, options); // step\n".repeat(400);
function sessionRows(s) {
    const r = rng(s.seed);
    const rows = [];
    let t = s.start;
    const iso = (ms) => new Date(ms).toISOString();
    rows.push(JSON.stringify({ type: "user", cwd: "/work/app", sessionId: s.id, version: "2.1.300", entrypoint: "cli", uuid: `${s.id}-q0`, timestamp: iso(t), message: { role: "user", content: "Work through the backlog in src/, and run the tests as you go." } }));
    const PROMPTS = ["Fix the failing test", "Now the next ticket", "That broke the build, revert it", "Add the retry and run the suite again", "Looks right, continue"];
    const breakAt = new Map((s.breaks ?? []).map((b) => [b.at, b.hours]));
    let prompt = s.promptStart;
    for (let i = 0; i < s.requests; i++) {
        const brk = breakAt.get(i);
        t += brk !== undefined ? brk * 60 * MIN : 30_000 + Math.floor(r() * 60_000);
        // Each request starts with what the person typed, as real transcripts do;
        // the return after a long break always does.
        if (i > 0 && (brk !== undefined || r() < 0.5)) {
            rows.push(JSON.stringify({ type: "user", cwd: "/work/app", sessionId: s.id, version: "2.1.300", entrypoint: "cli", uuid: `${s.id}-u${i}`, timestamp: iso(t - 2_000), message: { role: "user", content: PROMPTS[Math.floor(r() * PROMPTS.length)] } }));
        }
        const usage = {
            input_tokens: 5 + Math.floor(r() * 20),
            cache_read_input_tokens: prompt,
            cache_creation_input_tokens: s.promptStep,
            output_tokens: 100 + Math.floor(r() * 400),
            cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: s.promptStep },
            service_tier: "standard",
        };
        const toolId = `toolu_${s.id}_${i}`;
        rows.push(JSON.stringify({
            type: "assistant", cwd: "/work/app", sessionId: s.id, version: "2.1.300", entrypoint: "cli", uuid: `${s.id}-a${i}`, timestamp: iso(t),
            message: { id: `msg_${s.id}_${i}`, type: "message", role: "assistant", model: s.model, content: [{ type: "tool_use", id: toolId, name: "Read", input: { file_path: `/work/app/src/file${i % 7}.ts` } }], usage },
        }));
        rows.push(JSON.stringify({
            type: "user", cwd: "/work/app", sessionId: s.id, version: "2.1.300", entrypoint: "cli", uuid: `${s.id}-r${i}`, timestamp: iso(t + 1_000),
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: BIG_READ }] },
        }));
        prompt += s.promptStep;
    }
    return { rows, end: t + 2_000 };
}
/** Two synthetic sessions: one with a cold return past the prompt cache, one without. */
export function writeSampleHistory(now = Date.now()) {
    const dir = mkdtempSync(join(tmpdir(), "context-doctor-sample-"));
    const specs = [
        // A big session, come back to twice after the cache expired: both levers show.
        { id: "sample-a", start: now - 6 * DAY, requests: 40, seed: 42, model: "claude-opus-5-5", promptStart: 200_000, promptStep: 15_000, breaks: [{ at: 12, hours: 3 }, { at: 26, hours: 26 }] },
        // A smaller session without a cold return: not every session has one.
        { id: "sample-b", start: now - 2 * DAY, requests: 14, seed: 7, model: "claude-opus-5-5", promptStart: 60_000, promptStep: 8_000 },
    ];
    const paths = [];
    for (const s of specs) {
        const { rows, end } = sessionRows(s);
        const p = join(dir, `${s.id}.jsonl`);
        writeFileSync(p, rows.join("\n") + "\n");
        utimesSync(p, end / 1000, end / 1000);
        paths.push(p);
    }
    return { paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
