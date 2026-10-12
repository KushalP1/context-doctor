/**
 * The status line's number must be the CURRENT context. Claude Code's
 * context_window.current_usage is null right after /compact and in a new
 * session, while total_input_tokens still holds an older figure (a running
 * total in some versions), which is exactly when a stale large number
 * misleads the most.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderStatusLine, tailUsage } from "../statusline.js";
test("a running session total is never shown as the context size", () => {
    const line = renderStatusLine({ context_window: { total_input_tokens: 187_000, context_window_size: 200_000, current_usage: null } });
    assert.equal(line, null, `nothing trustworthy to show, got: ${line}`);
    const withCost = renderStatusLine({ context_window: { total_input_tokens: 187_000, context_window_size: 200_000, current_usage: null }, cost: { total_cost_usd: 1.25 } });
    assert.ok(withCost && !withCost.includes("ctx"), `no context part, got: ${withCost}`);
    assert.match(withCost ?? "", /\$1\.25/);
});
test("current_usage, when present, is the context size", () => {
    const line = renderStatusLine({
        context_window: { total_input_tokens: 2_000_000, context_window_size: 200_000, current_usage: { input_tokens: 1_000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 9_000 } },
    });
    assert.match(line ?? "", /ctx 50k\/200k .* 25%/);
    assert.match(line ?? "", /cache 80%/);
});
test("after /compact the transcript tail's old usage is not the context either", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxdoc-slcompact-"));
    const path = join(dir, "t.jsonl");
    writeFileSync(path, [
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "ok", model: "claude-opus-5", usage: { input_tokens: 10, cache_read_input_tokens: 180_000 } } }),
        JSON.stringify({ type: "system", subtype: "compact_boundary", content: "Conversation compacted", compactMetadata: { trigger: "manual", preTokens: 180_010 } }),
        JSON.stringify({ type: "user", isCompactSummary: true, message: { role: "user", content: "This session is being continued…" } }),
    ].join("\n") + "\n");
    assert.equal(tailUsage(path), undefined);
    assert.equal(renderStatusLine({ transcript_path: path, model: { id: "claude-opus-5" }, context_window: { current_usage: null } }), null);
});
