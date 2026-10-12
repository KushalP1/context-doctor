/** PreCompact: the summary is told what this session cannot lose, from the transcript since the last compaction. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compactFacts, compactInstructions } from "../precompact.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const use = (id, name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id, content, is_error = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } });
function transcript() {
    const rows = [
        use("e0", "Edit", { file_path: "/w/old.ts" }),
        { type: "system", subtype: "compact_boundary" },
        { type: "user", message: { role: "user", content: "Always use pnpm here, never npm." } },
        use("e1", "Edit", { file_path: "/w/src/a.ts" }),
        use("e2", "Write", { file_path: "/w/src/b.ts" }),
        use("e3", "Edit", { file_path: "/w/src/a.ts" }),
        use("t1", "TodoWrite", { todos: [{ content: "wire the parser", status: "completed" }, { content: "fix the date bug", status: "in_progress" }, { content: "add tests", status: "pending" }] }),
        use("b1", "Bash", { command: "pnpm test" }), result("b1", "FAIL src/a.test.ts\nError: expected 2 got 3", true),
        use("b2", "Bash", { command: "pnpm build" }), result("b2", "error TS2304", true),
        use("b3", "Bash", { command: "pnpm build" }), result("b3", "ok"),
        use("b4", "Bash", { command: "grep -r foo ." }), result("b4", "", true),
    ];
    const p = join(mkdtempSync(join(tmpdir(), "cd-pre-")), "s.jsonl");
    writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return p;
}
test("facts since the last compaction: edited files (latest first), open todos, directives, still-failing checks", () => {
    const f = compactFacts(transcript());
    assert.deepEqual(f.edited, ["/w/src/a.ts", "/w/src/b.ts"], "the pre-compaction edit belongs to the earlier summary");
    assert.deepEqual(f.todos, ["[in progress] fix the date bug", "add tests"]);
    assert.deepEqual(f.directives, ["Always use pnpm here, never npm."]);
    assert.equal(f.failing.length, 1, "the build passed later; a grep that found nothing is not a failing check");
    assert.match(f.failing[0], /^pnpm test → .*expected 2 got 3/);
    const text = compactInstructions(f);
    assert.match(text, /Files changed in this session/);
    assert.ok(text.length <= 2400);
});
test("the hook prints the instructions as plain text on PreCompact, and nothing for an empty session", async () => {
    const run = (path) => new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [cliPath, "hook"], { env: { ...process.env, CONTEXT_DOCTOR_HOOK_STATE: join(mkdtempSync(join(tmpdir(), "cd-st-")), "s.json") } }, (err, out) => (err ? reject(err) : resolve(out)));
        child.stdin?.end(JSON.stringify({ session_id: "s", transcript_path: path, hook_event_name: "PreCompact", trigger: "auto", custom_instructions: null }));
    });
    const out = await run(transcript());
    assert.match(out, /^context-doctor, from this session's transcript/);
    assert.ok(!out.trim().startsWith("{"), "plain text, which Claude Code adds to the compaction instructions");
    const empty = join(mkdtempSync(join(tmpdir(), "cd-pre-")), "e.jsonl");
    writeFileSync(empty, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
    assert.equal(await run(empty), "");
});
