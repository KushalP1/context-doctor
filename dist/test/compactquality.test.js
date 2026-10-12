/** compactions: re-reads, errors and corrections around each compaction. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactionQuality, renderCompactionQuality } from "../compactquality.js";
test("a file read before the compaction and again after counts as forgotten; errors and corrections are rates", () => {
    const rows = [];
    let n = 0;
    const req = (reads, error = false) => {
        const id = `m${n++}`;
        rows.push({ type: "assistant", message: { id, usage: { input_tokens: 1 }, content: reads.map((p, i) => ({ type: "tool_use", id: `${id}-${i}`, name: "Read", input: { file_path: p } })) } });
        reads.forEach((_, i) => rows.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `${id}-${i}`, content: "x".repeat(400), is_error: error && i === 0 }] } }));
    };
    for (let i = 0; i < 10; i++)
        req([`/w/f${i}.ts`]);
    rows.push({ type: "system", subtype: "compact_boundary" });
    rows.push({ type: "user", message: { role: "user", content: "no, that's wrong" } });
    for (let i = 0; i < 10; i++)
        req([`/w/f${i}.ts`]);
    const p = join(mkdtempSync(join(tmpdir(), "cd-cq-")), "s.jsonl");
    writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const q = compactionQuality(30, [p]);
    assert.equal(q.compactions, 1);
    assert.equal(q.before.rereads, 0);
    assert.equal(q.after.rereads, 10);
    assert.equal(q.after.corrections, 1);
    assert.ok(q.extraRereadTokensPerCompaction > 0);
    assert.match(renderCompactionQuality(q, 30), /Compacting forgets files/);
});
