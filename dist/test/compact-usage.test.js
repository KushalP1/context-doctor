/**
 * After a compaction, the API's last usage figure describes the context the
 * compaction replaced. Until the next reply reports the new size, the live
 * context has no reported figure, and the every-prompt hook falls back to its
 * estimate instead of quoting the pre-compaction size.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSessionFile } from "../session.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const T0 = Date.parse("2026-10-01T10:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
/** A session that reached 800k tokens, then was compacted; `after` adds a reply following the compaction. */
function compacted(after, summary = "summary of the work so far") {
    const rows = [
        { type: "user", uuid: "u0", timestamp: iso(T0), message: { role: "user", content: "start" } },
        { type: "assistant", uuid: "a0", timestamp: iso(T0 + 1000), message: { id: "m0", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 5, cache_read_input_tokens: 800_000, cache_creation_input_tokens: 0, output_tokens: 10 } } },
        { type: "system", subtype: "compact_boundary", uuid: "b0", timestamp: iso(T0 + 60_000), compactMetadata: { trigger: "manual", preTokens: 800_005 } },
        { type: "user", uuid: "s0", isCompactSummary: true, timestamp: iso(T0 + 61_000), message: { role: "user", content: summary } },
    ];
    if (after !== undefined) {
        rows.push({ type: "assistant", uuid: "a1", timestamp: iso(T0 + 120_000), message: { id: "m1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "back" }], usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: after - 5, output_tokens: 10 } } });
    }
    const p = join(mkdtempSync(join(tmpdir(), "cd-compact-usage-")), "s.jsonl");
    writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return p;
}
test("a compaction with no reply since leaves no reported size; the next reply sets it", () => {
    assert.equal(parseSessionFile(compacted()).reportedInputTokens, undefined, "800k described the context before the compaction");
    assert.equal(parseSessionFile(compacted(52_000)).reportedInputTokens, 52_000);
});
test("hook: right after a compaction the warning is not driven by the pre-compaction size", async () => {
    // ~110 KB of summary clears the hook's size gate, yet is far under 80k tokens.
    const p = compacted(undefined, "The parser was refactored and the tests updated. ".repeat(2_200));
    const dir = mkdtempSync(join(tmpdir(), "cd-compact-hook-"));
    const out = await new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [cliPath, "hook"], { env: { ...process.env, CONTEXT_DOCTOR_HOOK_STATE: join(dir, "state.json") } }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
        child.stdin.end(JSON.stringify({ session_id: "compacted-1", transcript_path: p }));
    });
    assert.doesNotMatch(out, /800k/);
    assert.equal(out.trim(), "", "the live context is the summary, under the 80k threshold");
});
