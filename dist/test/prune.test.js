/**
 * overhead prune: per project, the configured MCP servers and installed
 * skills its sessions never used, switched off in the project's own
 * settings.local.json, reversibly; never the app's, a plugin's or ours.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { applyPrune, canonical, localSettingsPath, planPrune, projectUsage, undoPrune } from "../prune.js";
import { claudeProjectDir } from "../session.js";
import { sandboxEnv } from "./sandbox.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
/** A machine: user servers, a project with its own .mcp.json and skills, and sessions that used some of them. */
function machine(sessions = 3) {
    const home = mkdtempSync(join(tmpdir(), "cd-prune-"));
    const cwd = join(home, "work", "app");
    mkdirSync(join(cwd, ".claude", "skills", "release-notes"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "skills", "release-notes", "SKILL.md"), "---\nname: release-notes\ndescription: Write release notes from the git log\n---\nbody");
    for (const s of ["pdf-tools", "sql-helper", "context-doctor"]) {
        mkdirSync(join(home, ".claude", "skills", s), { recursive: true });
        writeFileSync(join(home, ".claude", "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: The ${s} skill does a thing\n---\n`);
    }
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { github: { command: "gh-mcp" }, "my.db": { command: "db" }, "context-doctor": { command: "npx" } } }));
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { figma: { command: "figma" } } }));
    const paths = [];
    const now = new Date().toISOString();
    for (let i = 0; i < sessions; i++) {
        const rows = [
            JSON.stringify({ type: "user", cwd, timestamp: now, message: { role: "user", content: "<command-name>/sql-helper</command-name>" } }),
            JSON.stringify({ type: "assistant", cwd, timestamp: now, message: { role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "mcp__github__list_prs", input: {} }] } }),
            JSON.stringify({ type: "assistant", cwd, timestamp: now, message: { role: "assistant", content: [{ type: "tool_use", id: `u${i}`, name: "mcp__claude_ai_Gmail__search", input: {} }] } }),
        ];
        const dir = claudeProjectDir(cwd, home);
        mkdirSync(dir, { recursive: true });
        const p = join(dir, `s${i}.jsonl`);
        writeFileSync(p, rows.join("\n") + "\n");
        paths.push(p);
    }
    // A subagent of the first session used a skill.
    const sub = join(paths[0].replace(/\.jsonl$/, ""), "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "agent-a.jsonl"), JSON.stringify({ type: "assistant", isSidechain: true, cwd, timestamp: now, message: { role: "assistant", content: [{ type: "tool_use", id: "k", name: "Skill", input: { skill: "pdf-tools" } }] } }) + "\n");
    return { home, cwd, paths };
}
test("the plan: what each project used, what it did not, and how each would be switched off; never ours or the app's", () => {
    const { home, cwd, paths } = machine();
    const usage = projectUsage(30, paths);
    const use = usage.get(canonical(cwd));
    assert.equal(use.sessions, 3);
    assert.equal(use.mcpCalls.get("github"), 3);
    assert.equal(use.skillUses.get("pdf-tools"), 1, "a subagent's use counts");
    const plan = planPrune(30, { home, usage, cwds: [cwd] }).plans[0];
    assert.equal(plan.thin, false);
    assert.deepEqual(plan.used.map((u) => u.name).sort(), ["github", "pdf-tools", "sql-helper"]);
    assert.deepEqual(plan.unused.map((u) => `${u.name}:${u.entry}`).sort(), ["figma:disabledMcpjsonServers", "my.db:deniedMcpServers", "release-notes:skillOverrides"]);
    assert.ok(!JSON.stringify(plan).includes("context-doctor"), "our own server and skill are left alone");
    assert.ok(!JSON.stringify(plan).includes("Gmail"), "an app-provided connector is never proposed");
    assert.ok(plan.unused.find((u) => u.name === "release-notes").tokens > 5);
    const thin = planPrune(30, { home, usage: projectUsage(30, paths.slice(0, 2)), cwds: [cwd] }).plans[0];
    assert.equal(thin.thin, true);
});
test("--write switches them off in settings.local.json, keeps the original and the user's own choices; --undo takes out exactly ours", () => {
    const { home, cwd, paths } = machine();
    const file = localSettingsPath(cwd);
    const original = { disabledMcpjsonServers: "legacy", skillOverrides: { "release-notes": "on" }, deniedMcpServers: [{ serverName: "theirs" }], permissions: { allow: ["Bash(ls)"] } };
    writeFileSync(file, JSON.stringify(original));
    const prev = process.env.CONTEXT_DOCTOR_HOOK_STATE;
    process.env.CONTEXT_DOCTOR_HOOK_STATE = join(home, ".claude", ".context-doctor-hook-state.json");
    try {
        const plan = planPrune(30, { home, usage: projectUsage(30, paths), cwds: [cwd] }).plans[0];
        const r = applyPrune(plan);
        assert.deepEqual(r.added, { disabledMcpjsonServers: ["figma"], deniedMcpServers: ["my.db"], skillOverrides: [] }, "release-notes was set to \"on\" by the user: it stays");
        assert.equal(readFileSync(file + ".context-doctor.backup", "utf8"), JSON.stringify(original));
        const after = JSON.parse(readFileSync(file, "utf8"));
        assert.deepEqual(after.disabledMcpjsonServers, ["legacy", "figma"], "always an array");
        assert.deepEqual(after.deniedMcpServers, [{ serverName: "theirs" }, { serverName: "my.db" }]);
        assert.deepEqual(after.permissions, original.permissions);
        const again = planPrune(30, { home, usage: projectUsage(30, paths), cwds: [cwd] }).plans[0];
        assert.deepEqual(again.alreadyOff.sort(), ["figma", "my.db"]);
        assert.deepEqual(again.used.map((u) => u.name).sort(), ["github", "pdf-tools", "sql-helper"]);
        const undo = undoPrune(cwd);
        assert.deepEqual(undo.removed.sort(), ["figma", "my.db"]);
        const restored = JSON.parse(readFileSync(file, "utf8"));
        assert.deepEqual(restored.disabledMcpjsonServers, ["legacy"]);
        assert.deepEqual(restored.deniedMcpServers, [{ serverName: "theirs" }]);
        assert.equal(undoPrune(cwd), undefined, "nothing left to undo");
    }
    finally {
        if (prev === undefined)
            delete process.env.CONTEXT_DOCTOR_HOOK_STATE;
        else
            process.env.CONTEXT_DOCTOR_HOOK_STATE = prev;
    }
});
test("CLI: plan, --write in the project's folder, --undo", () => {
    const { home, cwd } = machine();
    const run = (args) => spawnSync(process.execPath, [cliPath, "overhead", "prune", ...args], { env: sandboxEnv(home), cwd, encoding: "utf8" });
    const plan = run([]);
    assert.equal(plan.status, 0, plan.stderr);
    assert.match(plan.stdout, /\(this folder\): 3 sessions/);
    assert.match(plan.stdout, /unused {2}server figma \(\.mcp\.json\): disabledMcpjsonServers/);
    assert.equal(existsSync(localSettingsPath(cwd)), false, "the plan writes nothing");
    const w = run(["--write"]);
    assert.match(w.stdout, /Written: 3 entries/);
    assert.equal(JSON.parse(readFileSync(localSettingsPath(cwd), "utf8")).skillOverrides["release-notes"], "off");
    const u = run(["--undo"]);
    assert.match(u.stdout, /Removed 3 entries/);
    assert.deepEqual(JSON.parse(readFileSync(localSettingsPath(cwd), "utf8")), {});
});
