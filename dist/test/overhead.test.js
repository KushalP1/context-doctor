/** overhead: the memory files each agent loads, and the measured fixed cost of a session's first request. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMemoryFiles, measureBaseline, measureBaselines, overheadFindings, renderOverhead } from "../overhead.js";
function fixture() {
    const home = mkdtempSync(join(tmpdir(), "cd-overhead-"));
    const proj = join(home, "work", "app");
    mkdirSync(join(home, ".claude", "rules"), { recursive: true });
    mkdirSync(join(proj, ".cursor", "rules"), { recursive: true });
    mkdirSync(join(proj, "docs"), { recursive: true });
    const shared = "Always run the full test suite before committing, and never push when it fails. ".repeat(3);
    writeFileSync(join(home, ".claude", "CLAUDE.md"), `# Me\n\n${shared}\n`);
    writeFileSync(join(home, ".claude", "rules", "style.md"), "Use tabs.\n");
    writeFileSync(join(proj, "CLAUDE.md"), `# App\n\nSee @docs/arch.md for the architecture. Mail me@example.com.\n\n${shared}\n\n\`@not/an/import.md\`\n`);
    writeFileSync(join(proj, "docs", "arch.md"), "Architecture notes. ".repeat(2000));
    writeFileSync(join(proj, "AGENTS.md"), "Codex rules.\n");
    writeFileSync(join(proj, ".cursor", "rules", "always.mdc"), "---\nalwaysApply: true\n---\nCursor rule.\n");
    writeFileSync(join(proj, ".cursor", "rules", "sometimes.mdc"), "---\nalwaysApply: false\n---\nOnly on request.\n");
    return { home, proj };
}
test("finds each agent's memory files, follows @imports, and skips rules that are not always applied", () => {
    const { home, proj } = fixture();
    const files = findMemoryFiles(proj, home);
    // Compared with forward slashes, so the same assertions hold on Windows.
    const rel = files.map((f) => `${f.agent}:${f.path.replace(home, "~").replace(/\\/g, "/")}:${f.via}`);
    assert.ok(rel.includes("Claude Code:~/.claude/CLAUDE.md:user"));
    assert.ok(rel.includes("Claude Code:~/.claude/rules/style.md:rules"));
    assert.ok(rel.includes("Claude Code:~/work/app/CLAUDE.md:project"));
    assert.ok(rel.includes("Claude Code:~/work/app/docs/arch.md:import"));
    assert.ok(rel.includes("Codex:~/work/app/AGENTS.md:project"));
    assert.ok(rel.some((r) => r.includes("always.mdc")));
    assert.ok(!rel.some((r) => r.includes("sometimes.mdc")), "rules applied on request do not ride on every request");
    assert.ok(!rel.some((r) => r.includes("not/an/import")), "an @path inside a code span is not an import");
});
test("findings name the big import and the paragraph loaded twice", () => {
    const { home, proj } = fixture();
    const findings = overheadFindings(findMemoryFiles(proj, home));
    assert.ok(findings.some((f) => f.severity === "warn" && f.message.includes("arch.md")));
    assert.ok(findings.some((f) => /appear in more than one loaded file/.test(f.message)));
});
test("baseline: first request minus the first message, priced from requests and cold starts", () => {
    const { home, proj } = fixture();
    const t0 = Date.now() - 3 * 3_600_000;
    const row = (id, at, prompt) => JSON.stringify({ type: "assistant", timestamp: new Date(at).toISOString(), message: { id, model: "claude-sonnet-5", usage: { input_tokens: 10, cache_read_input_tokens: prompt - 10 } } });
    const lines = [
        JSON.stringify({ type: "user", timestamp: new Date(t0).toISOString(), message: { role: "user", content: "hi" } }),
        row("a", t0, 30_000),
        row("b", t0 + 60_000, 31_000),
        row("c", t0 + 2 * 3_600_000, 32_000), // after an idle hour: a cold start
    ];
    const path = join(home, "s.jsonl");
    writeFileSync(path, lines.join("\n") + "\n");
    const b = measureBaseline(30, [path]);
    assert.equal(b.sessions, 1);
    assert.ok(b.median >= 29_990 && b.median < 30_000);
    assert.equal(b.requests, 3);
    assert.equal(b.coldStarts, 2);
    // Sonnet: 1 warm read at $0.30/M + 2 cold writes at 1.25 x $3/M, per 1k tokens, scaled to a month.
    const expected = ((1000 * (1 * 0.3 + 2 * 1.25 * 3)) / 1e6) * (30 / 30);
    assert.ok(Math.abs(b.usdPerKPerMonth - expected) < 1e-9);
    const text = renderOverhead({ cwd: proj, baseline: b, files: findMemoryFiles(proj, home), findings: [], baselines: [b], mcp: { configs: [], usage: { calls: new Map(), sessions: 0, toolSearchSessions: 0 } } }, home);
    assert.match(text, /median ~30k tokens/);
});
test("baselines per agent: Codex rollouts and Gemini CLI chats, OpenAI/Google priced with no cache-write premium", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-overhead-agents-"));
    const t0 = Date.now() - 3 * 3_600_000;
    const iso = (ms) => new Date(ms).toISOString();
    // Codex: AGENTS.md arrives as a user message and is overhead, not the prompt.
    mkdirSync(join(dir, ".codex", "sessions"), { recursive: true });
    const codex = join(dir, ".codex", "sessions", "rollout-x.jsonl");
    const line = (type, payload, at) => JSON.stringify({ timestamp: iso(at), type, payload });
    writeFileSync(codex, [
        line("turn_context", { model: "gpt-5.5" }, t0),
        line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<user_instructions>" + "rule ".repeat(2000) + "</user_instructions>" }] }, t0),
        line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "fix it" }] }, t0),
        line("event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 18_000, cached_input_tokens: 0 } } }, t0 + 1000),
        line("event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 19_000, cached_input_tokens: 17_000 } } }, t0 + 60_000),
    ].join("\n") + "\n");
    // Gemini CLI chat.
    const gem = join(dir, "session-g.jsonl");
    writeFileSync(gem, [
        { sessionId: "g", projectHash: "p", startTime: iso(t0) },
        { id: "u1", type: "user", timestamp: iso(t0), content: "hello" },
        { id: "g1", type: "gemini", timestamp: iso(t0 + 1000), content: "hi", model: "gemini-3-pro", tokens: { input: 12_000 } },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const bs = measureBaselines(30, [codex, gem]);
    const c = bs.find((b) => b.agent === "Codex");
    const g = bs.find((b) => b.agent === "Gemini CLI");
    assert.ok(c.median > 17_900 && c.median <= 18_000, "only the real prompt is subtracted, not AGENTS.md");
    assert.equal(c.requests, 2);
    assert.equal(c.coldStarts, 1);
    // gpt-5: 1 warm read at $0.125/M + 1 cold write at 1.0 x $1.25/M (no premium), per 1k tokens.
    assert.ok(Math.abs(c.usdPerKPerMonth - (1000 * (0.125 + 1.25)) / 1e6) < 1e-9);
    assert.ok(g.median > 11_990 && g.median <= 12_000);
    assert.equal(g.model, "gemini-3-pro");
});
