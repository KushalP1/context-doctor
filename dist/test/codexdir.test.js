/**
 * CODEX_HOME: Codex keeps its home there when it is set, so every report
 * that reads Codex (spend, budget, limits, sessions) follows it, while a
 * caller's own throwaway home keeps its own `.codex`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codexDir } from "../codexdir.js";
import { frozenClock } from "./history-fixture.js";
import { cleanEnv } from "./golden-run.js";
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
test("codexDir: CODEX_HOME when set, ~/.codex otherwise, and a caller's own home keeps its own", () => {
    assert.equal(codexDir(undefined, {}), join(homedir(), ".codex"));
    assert.equal(codexDir(undefined, { CODEX_HOME: "  " }), join(homedir(), ".codex"));
    assert.equal(codexDir(undefined, { CODEX_HOME: "/elsewhere/codex" }), resolve("/elsewhere/codex"));
    assert.equal(codexDir(homedir(), { CODEX_HOME: "/elsewhere/codex" }), resolve("/elsewhere/codex"));
    const other = join(tmpdir(), "someone-else");
    assert.equal(codexDir(other, { CODEX_HOME: "/elsewhere/codex" }), join(other, ".codex"));
});
test("spend and budget read Codex's rollouts and hooks from CODEX_HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "cd-codexhome-"));
    const codex = mkdtempSync(join(tmpdir(), "cd-codexhome-codex-"));
    const cache = mkdtempSync(join(tmpdir(), "cd-codexhome-cache-"));
    try {
        const dir = join(codex, "sessions", "2026", "10", "14");
        mkdirSync(dir, { recursive: true });
        const at = (t) => new Date(t).toISOString();
        writeFileSync(join(dir, "rollout-a.jsonl"), [
            { timestamp: at(NOW - 7_200_000), type: "turn_context", payload: { cwd: "/work/app", model: "gpt-5.5" } },
            { timestamp: at(NOW - 7_200_000), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 80_000 }, last_token_usage: { input_tokens: 80_000, cached_input_tokens: 0, output_tokens: 0 } } } },
        ].map((r) => JSON.stringify(r)).join("\n") + "\n");
        writeFileSync(join(codex, "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "context-doctor hook" }] }] } }));
        const env = cleanEnv(home, { CONTEXT_DOCTOR_CACHE_DIR: cache, CODEX_HOME: codex });
        const run = (args) => spawnSync(process.execPath, [...frozenClock(NOW), cli, ...args], { env, encoding: "utf8", timeout: 60_000 });
        const spend = run(["spend", "--json", "--days", "1"]);
        assert.equal(spend.status, 0, spend.stderr);
        const codexTool = JSON.parse(spend.stdout).tools.find((t) => t.tool === "codex");
        assert.ok(codexTool, "Codex read from CODEX_HOME");
        // gpt-5.5 at $1.25 / 1M: 80k uncached is $0.10.
        assert.ok(Math.abs(codexTool.usd - 0.1) < 1e-9, `${codexTool.usd}`);
        const budget = run(["budget", "1/day"]);
        assert.equal(budget.status, 0, budget.stderr);
        assert.match(budget.stdout, /Today: \$0\.10 so far/);
        assert.match(budget.stdout, /The every-prompt hook says so/, "Codex's hook found in CODEX_HOME");
    }
    finally {
        for (const d of [home, codex, cache])
            rmSync(d, { recursive: true, force: true });
    }
});
