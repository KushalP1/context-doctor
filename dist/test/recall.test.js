/**
 * recall: the session's own transcript, compacted turns and cleared output
 * included, searched with pack's ranker; secrets masked; never another
 * project's session unless named.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { currentTranscript, findSession, recall, renderRecall, transcriptEntries } from "../recall.js";
import { claudeProjectDir } from "../session.js";
import { clearedNote } from "../autoclear.js";
import { compactInstructions } from "../precompact.js";
import { sandboxEnv } from "./sandbox.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const mcpPath = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp.js");
const fake = (...parts) => parts.join("");
const at = (min) => new Date(Date.parse("2026-10-26T09:00:00Z") + min * 60_000).toISOString();
/** A Claude Code session: a failing test run, a compaction, then more work. */
function session() {
    const filler = Array.from({ length: 40 }, (_, i) => `line ${i} of the build log, nothing to see`).join("\n");
    return [
        JSON.stringify({ type: "user", timestamp: at(0), message: { role: "user", content: "fix the flaky payment test" } }),
        JSON.stringify({ type: "assistant", timestamp: at(1), message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test -- payments" } }] } }),
        JSON.stringify({ type: "user", timestamp: at(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: `${filler}\nFAIL payments.test.ts: expected refund 4200 but got 4199 (rounding in applyDiscount)\n${filler}` }] } }),
        JSON.stringify({ type: "user", timestamp: at(3), message: { role: "user", content: `deploy with ${fake("ANTHROPIC_API_KEY=", "sk-ant-api03-", "Zx9".repeat(20))} please` } }),
        JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: at(4) }),
        JSON.stringify({ type: "user", isCompactSummary: true, timestamp: at(4), message: { role: "user", content: "Summary: working on payments; refund rounding" } }),
        JSON.stringify({ type: "assistant", isSidechain: true, timestamp: at(5), message: { role: "assistant", content: [{ type: "text", text: "a subagent's own words: rounding" }] } }),
        JSON.stringify({ type: "assistant", timestamp: at(6), message: { role: "assistant", content: [{ type: "text", text: "Now updating the changelog." }] } }),
    ];
}
function write(dir, name, rows) {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, name);
    writeFileSync(p, rows.join("\n") + "\n");
    return p;
}
test("entries: tool calls and output named, the compaction summary and subagent rows left out, positions counted", () => {
    const p = write(mkdtempSync(join(tmpdir(), "cd-recall-e-")), "s.jsonl", session());
    const e = transcriptEntries(p);
    assert.deepEqual(e.map((x) => x.kind), ["user", "tool call", "tool output (Bash)", "user", "assistant"]);
    assert.deepEqual(e.map((x) => x.compactedBy), [1, 1, 1, 1, 0]);
    assert.equal(e[1].text, "Bash: npm test -- payments");
});
test("a detail from before the compaction comes back first, with its time and position; secrets masked", () => {
    const p = write(mkdtempSync(join(tmpdir(), "cd-recall-r-")), "s.jsonl", session());
    const r = recall(p, "refund rounding applyDiscount failure", { budget: 400 });
    assert.equal(r.compactions, 1);
    assert.ok(r.hits.length >= 1);
    assert.equal(r.hits[0].n, 3);
    assert.equal(r.hits[0].where, "before compaction 1 of 1");
    assert.match(r.hits[0].text, /expected refund 4200 but got 4199/);
    assert.ok(r.hits[0].tokens <= 400);
    const text = renderRecall(r);
    assert.match(text, /entry 3 of 5 · 2026-10-26 09:02 UTC · tool output \(Bash\) · before compaction 1 of 1/);
    assert.ok(!text.includes("a subagent's own words"));
    const key = recall(p, "deploy api key", { budget: 400 });
    const all = key.hits.map((h) => h.text).join("\n");
    assert.match(all, /deploy with/);
    assert.ok(!all.includes(fake("sk-ant-", "api03")), all);
    assert.ok(key.masked >= 1);
    assert.match(renderRecall(recall(p, "kubernetes helm chart")), /Nothing in it matches/);
});
test("Codex rollouts are searched the same way", () => {
    const rows = [
        JSON.stringify({ timestamp: at(0), type: "session_meta", payload: { cwd: "/w" } }),
        JSON.stringify({ timestamp: at(1), type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "c1", arguments: JSON.stringify({ cmd: "cargo build" }) } }),
        JSON.stringify({ timestamp: at(2), type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "error[E0382]: borrow of moved value: `config`" } }),
        JSON.stringify({ timestamp: at(3), type: "compacted", payload: { message: "" } }),
        JSON.stringify({ timestamp: at(4), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "continuing" }] } }),
    ];
    const p = write(mkdtempSync(join(tmpdir(), "cd-recall-cx-")), "rollout-x.jsonl", rows);
    const r = recall(p, "borrow moved value config");
    assert.equal(r.hits[0].kind, "tool output (exec_command)");
    assert.equal(r.hits[0].where, "before compaction 1 of 1");
});
test("the session: CLAUDE_CODE_SESSION_ID, else this folder's newest; never another project's", () => {
    const home = mkdtempSync(join(tmpdir(), "cd-recall-home-"));
    const cwd = join(home, "work", "app");
    const mine = write(claudeProjectDir(cwd, home), "aaa.jsonl", session());
    const other = write(claudeProjectDir(join(home, "work", "other"), home), "bbb.jsonl", session());
    assert.equal(currentTranscript({}, cwd, home)?.path, mine);
    assert.equal(currentTranscript({ CLAUDE_CODE_SESSION_ID: "bbb" }, cwd, home)?.path, other, "the id names the session, wherever it is");
    assert.equal(currentTranscript({}, join(home, "elsewhere"), home), undefined, "no transcript for this folder: none, not the newest on the machine");
    assert.equal(findSession("bbb", home), other);
    assert.equal(findSession("../bbb", home), undefined);
});
test("CLI: recall --session prints excerpts; with no session for this folder it says so and exits 1", () => {
    const home = mkdtempSync(join(tmpdir(), "cd-recall-cli-"));
    const p = write(join(home, "t"), "s.jsonl", session());
    const r = spawnSync(process.execPath, [cliPath, "recall", "refund", "rounding", "--session", p, "--max-tokens", "300"], { env: sandboxEnv(home), cwd: home, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /RECALL from session/);
    assert.match(r.stdout, /expected refund 4200/);
    const none = spawnSync(process.execPath, [cliPath, "recall", "refund"], { env: { ...sandboxEnv(home), CLAUDE_CODE_SESSION_ID: "" }, cwd: home, encoding: "utf8" });
    assert.equal(none.status, 1);
    assert.match(none.stderr, /No transcript for this folder/);
});
test("MCP: recall over stdio searches the session CLAUDE_CODE_SESSION_ID names", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const home = mkdtempSync(join(tmpdir(), "cd-recall-mcp-"));
    write(claudeProjectDir(join(home, "proj"), home), "sess-1.jsonl", session());
    const client = new Client({ name: "recall", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpPath], env: { ...sandboxEnv(home), CLAUDE_CODE_SESSION_ID: "sess-1" } }));
    try {
        const res = await client.callTool({ name: "recall", arguments: { query: "applyDiscount rounding", max_tokens: 300 } });
        const text = res.content.map((c) => c.text ?? "").join("\n");
        assert.match(text, /this Claude Code session \(sess-1\)/);
        assert.match(text, /expected refund 4200/);
    }
    finally {
        await client.close();
    }
});
test("the cleared note points at recall only for clients that keep a transcript; PreCompact names it and keeps that line under the cap", () => {
    assert.match(clearedNote(5000, true), /recall/);
    assert.ok(!/recall/.test(clearedNote(5000)));
    const long = compactInstructions({ edited: Array.from({ length: 25 }, (_, i) => `/very/long/path/to/some/file/number/${i}/${"x".repeat(80)}.ts`), todos: Array.from({ length: 15 }, (_, i) => `task ${i} ${"y".repeat(60)}`), directives: [], failing: [] });
    assert.ok(long.length <= 2400, String(long.length));
    assert.match(long, /recall tool \(or `npx context-doctor recall/);
});
