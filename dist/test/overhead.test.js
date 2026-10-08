/** overhead: the memory files each agent loads, and the measured fixed cost of a session's first request. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMemoryFiles, measureBaseline, overheadFindings, renderOverhead } from "../overhead.js";
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
    const rel = files.map((f) => `${f.agent}:${f.path.replace(home, "~")}:${f.via}`);
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
    const text = renderOverhead({ cwd: proj, baseline: b, files: findMemoryFiles(proj, home), findings: [], mcp: { configs: [], usage: { calls: new Map(), sessions: 0, toolSearchSessions: 0 } } }, home);
    assert.match(text, /median ~30k tokens/);
});
