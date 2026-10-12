/**
 * When the every-prompt hook speaks: after a compaction the next warning must
 * be measured from the compacted size, and a low threshold must not be hidden
 * behind the stat-only fast path, whose byte count cannot see the system
 * prompt and tools the API figure includes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
function hook(statePath, transcript, sessionId, warnTokens) {
    return new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [cliPath, "hook"], { env: { ...process.env, CONTEXT_DOCTOR_HOOK_STATE: statePath, CONTEXT_DOCTOR_WARN_TOKENS: warnTokens } }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
        child.stdin?.end(JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: dirname(transcript) }));
    });
}
const user = (chars, ch = "x") => JSON.stringify({ type: "user", message: { role: "user", content: ch.repeat(chars) } });
const reply = (inputTokens) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: "ok", model: "claude-sonnet-5", usage: { input_tokens: inputTokens } } });
test("after a compaction the warning fires again once the context regrows past the threshold", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxdoc-regrow-"));
    const state = join(dir, "state.json");
    const t = join(dir, "t.jsonl");
    writeFileSync(t, [user(400_000), reply(300_000)].join("\n") + "\n");
    assert.match(await hook(state, t, "cmp", "80000"), /additionalContext/, "first crossing warns");
    // Compacted to 100k: no warning (the user just acted on one), but the bar
    // for the next one is now measured from here.
    appendFileSync(t, [user(250_000, "y"), reply(100_000)].join("\n") + "\n");
    assert.equal(await hook(state, t, "cmp", "80000"), "");
    // Regrown to 200k: twice the compacted size and far past the threshold. It
    // used to need 1.4x the PRE-compaction peak (420k) before warning again.
    appendFileSync(t, [user(400_000, "z"), reply(200_000)].join("\n") + "\n");
    assert.match(await hook(state, t, "cmp", "80000"), /context is at ~200k/);
});
test("a low threshold is not hidden by the fast path: the API figure includes what the transcript lacks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxdoc-front-"));
    const state = join(dir, "state.json");
    // ~90 KB of transcript, but the API reports 70k: system prompt, tool
    // schemas and memory files are in the request, not in the transcript.
    const t = join(dir, "t.jsonl");
    writeFileSync(t, [user(90_000), reply(70_000)].join("\n") + "\n");
    assert.match(await hook(state, t, "front", "60000"), /context is at ~70k/);
});
test("a lean session still exits on a single stat: no state is read or written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxdoc-leanstat-"));
    const state = join(dir, "state.json");
    const t = join(dir, "t.jsonl");
    writeFileSync(t, [user(2_000), reply(30_000)].join("\n") + "\n");
    for (const threshold of ["80000", "60000"]) {
        assert.equal(await hook(state, t, "lean", threshold), "");
    }
    assert.ok(!existsSync(join(dir, "state.d")) || readdirSync(join(dir, "state.d")).length === 0, "the fast path never got as far as the state file");
});
