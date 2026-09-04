/**
 * The accuracy command reports transcript coverage, not tokenizer drift.
 * These tests pin the arithmetic and the guard rails on a synthetic transcript,
 * so the numbers cannot quietly change meaning.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/** One Claude Code transcript line. */
function userLine(text) {
    return JSON.stringify({ type: "user", message: { role: "user", content: text } });
}
function assistantLine(text, input) {
    return JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: text, model: "claude-sonnet-5", usage: { input_tokens: input } },
    });
}
test("usage samples are recorded per assistant turn, positioned in the message array", async () => {
    const { parseSessionFile } = await import("../session.js");
    const dir = mkdtempSync(join(tmpdir(), "ctxdoc-acc-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(path, [userLine("hello"), assistantLine("hi", 1000), userLine("more"), assistantLine("ok", 3000)].join("\n") + "\n");
    const parsed = parseSessionFile(path);
    assert.deepEqual(parsed.usageSamples, [{ index: 1, input: 1000 }, { index: 3, input: 3000 }], "each sample sits at the index of the assistant message that reported it");
});
test("coverage is the visible share of billed growth, and impossible turns are dropped", async () => {
    const { measureAccuracy } = await import("../accuracy.js");
    const dir = mkdtempSync(join(tmpdir(), "ctxdoc-coverage-"));
    const path = join(dir, "a.jsonl");
    const body = "word ".repeat(400); // ~2000 chars ≈ 500 estimated tokens
    writeFileSync(path, [
        userLine("start"),
        assistantLine("first", 10_000),
        userLine(body),
        // Billed +2000 for ~500 visible tokens: coverage ≈ 0.25.
        assistantLine("second", 12_000),
        userLine(body),
        // Billed growth smaller than what is visible — the baseline moved, not a
        // real observation. Must be discarded rather than reported as >100%.
        assistantLine("third", 12_050),
    ].join("\n") + "\n");
    // Measured by path, so the test never has to fake a home directory — which
    // is how this suite broke on Windows, where os.homedir() ignores $HOME.
    const report = measureAccuracy(10, [path]);
    assert.equal(report.samples, 1, "the impossible turn is dropped, the real one kept");
    assert.ok(report.medianCoverage > 0 && report.medianCoverage < 1, `coverage in range, got ${report.medianCoverage}`);
    assert.ok(report.medianInvisiblePerTurn > 0, "invisible tokens are positive");
    assert.ok(report.medianBaseline && report.medianBaseline > 0, "the fixed baseline is reported");
});
