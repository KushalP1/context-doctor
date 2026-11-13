/**
 * install and uninstall edit ~/.claude/settings.json under the same lock as
 * `fix`, `cache-ttl`, `compact-window` and autopilot, and write it through a
 * temporary file: run beside one of them, neither loses the other's change,
 * and no reader sees half a file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxEnv } from "./sandbox.js";
const mod = (m) => JSON.stringify(new URL(`../${m}.js`, import.meta.url).href);
test("install, uninstall, cache-ttl, compact-window and fix at the same moment: every change kept", async () => {
    const h = mkdtempSync(join(tmpdir(), "cd-install-lock-"));
    mkdirSync(join(h, ".claude"));
    const file = join(h, ".claude", "settings.json");
    writeFileSync(file, '{\n  "a": 1\n}\n');
    const script = join(h, "one.mjs");
    writeFileSync(script, [
        `const [what, go] = process.argv.slice(2);`,
        `const home = process.env.HOME;`,
        `const { runInstall, runUninstall } = await import(${mod("install")});`,
        `const { setCacheTtl } = await import(${mod("cachettl")});`,
        `const { setCompactWindow } = await import(${mod("compactwindow")});`,
        `const { applyFix } = await import(${mod("fix")});`,
        `console.log = () => {};`,
        `while (Date.now() < Number(go)) {}`,
        `if (what === "install") { const r = runInstall({ statusLine: true }); if (r.failures.length) process.exit(1); }`,
        // Writers that keep writing while install runs (each ends on the value asserted below).
        `if (what === "ttl") for (let i = 0; i < 20; i++) setCacheTtl("main", i % 2 ? "1h" : "5m", home);`,
        `if (what === "ttl-sub") setCacheTtl("subagents", "5m", home);`,
        `if (what === "window") for (let i = 0; i < 20; i++) setCompactWindow(i % 2 ? 400000 : 300000, home);`,
        `if (what === "fix") { const r = await applyFix({ id: "tool-search", title: "", basis: "", quality: "", change: "", state: "available", value: "auto" }, { home }); if (!r.ok) process.exit(1); }`,
        `if (what === "uninstall") await runUninstall();`,
    ].join("\n"));
    const env = { ...sandboxEnv(h), CONTEXT_DOCTOR_NO_MANAGED_SETTINGS: "1", CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS: "2.1.285", PATH: "" };
    // Each job's exit code, with its stderr when it failed (a Windows runner's EPERM was invisible otherwise).
    const race = async (jobs) => {
        const go = Date.now() + 1500;
        return Promise.all(jobs.map((what) => new Promise((res) => {
            const child = spawn(process.execPath, [script, what, String(go)], { env, stdio: ["ignore", "ignore", "pipe"] });
            let err = "";
            child.stderr.on("data", (d) => { err += d; });
            child.on("close", (c) => res(c === 0 ? "0" : `${what}: exit ${c}: ${err.slice(0, 400)}`));
        })));
    };
    const codes = await race(["install", "ttl", "ttl-sub", "window", "fix", "install", "ttl", "window", "fix"]);
    assert.deepEqual(codes, codes.map(() => "0"));
    let s = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual([s.a, s.promptCacheTtl, s.subagentPromptCacheTtl, s.autoCompactWindow, s.env?.ENABLE_TOOL_SEARCH], [1, "1h", "5m", 400000, "auto"]);
    for (const event of ["UserPromptSubmit", "PreCompact", "SessionStart", "PreToolUse", "PreModelSwitch"]) {
        assert.equal(s.hooks?.[event]?.length, 1, `${event}: install's hook, once`);
    }
    assert.match(s.statusLine?.command ?? "", /statusline/);
    // Uninstall racing more writers: our entries go, theirs stay.
    assert.deepEqual(await race(["uninstall", "ttl", "window", "fix"]), ["0", "0", "0", "0"]);
    s = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual([s.a, s.promptCacheTtl, s.subagentPromptCacheTtl, s.autoCompactWindow, s.env?.ENABLE_TOOL_SEARCH, s.hooks, s.statusLine], [1, "1h", "5m", 400000, "auto", undefined, undefined]);
    assert.ok(!existsSync(join(h, ".claude", ".context-doctor-fixes.lock")), "no lock left");
    assert.deepEqual(readdirSync(join(h, ".claude")).filter((f) => f.endsWith(".tmp")), [], "no temporary file left");
});
