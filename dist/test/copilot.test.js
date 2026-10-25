/**
 * GitHub Copilot: install wires the MCP server into ~/.copilot/mcp-config.json
 * and a sessionStart hook into a hook file of our own; a second install
 * changes nothing; uninstall takes out only ours (and the folders install
 * made, once empty). The hook answers a session start in both harnesses'
 * shapes and stays silent otherwise; doctor reports what it finds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv, withSandboxHome } from "./sandbox.js";
import { copilotSessionStartOutput, isOurCopilotEntry, vsCodeUserDirs } from "../copilot.js";
import { SERVER_INSTRUCTIONS } from "../rules.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
/** A PATH with node and nothing else, so a `copilot` installed on this machine is not detected. */
function env(home, extra = {}) {
    const e = sandboxEnv(home);
    for (const k of Object.keys(e))
        if (/^path$/i.test(k))
            delete e[k]; // Windows spells it Path
    return { ...e, PATH: dirname(process.execPath), ...extra };
}
function run(home, args, stdin, extra = {}) {
    return new Promise((resolve) => {
        const child = execFile(process.execPath, [cliPath, ...args], { env: env(home, extra) }, (err, out, errOut) => resolve({ code: err ? (err.code ?? 1) : 0, out, err: errOut }));
        if (stdin !== undefined)
            child.stdin.end(stdin);
    });
}
test("install wires Copilot's MCP server and session-start hook once, and uninstall removes only ours", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-copilot-"));
    const cp = join(home, ".copilot");
    mkdirSync(cp, { recursive: true });
    const mcpPath = join(cp, "mcp-config.json");
    const theirs = { mcpServers: { playwright: { type: "local", command: "npx", args: ["@playwright/mcp@latest"], env: {}, tools: ["*"] } } };
    writeFileSync(mcpPath, JSON.stringify(theirs, null, 2));
    const hookPath = join(cp, "hooks", "context-doctor.json");
    const first = await run(home, ["install"]);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /GitHub Copilot: MCP server added/);
    assert.match(first.out, /GitHub Copilot session-start hook installed/);
    const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
    assert.deepEqual(mcp.mcpServers.playwright, theirs.mcpServers.playwright, "their server untouched");
    const ours = mcp.mcpServers["context-doctor"];
    assert.equal(ours.type, "local");
    assert.deepEqual(ours.tools, ["*"]);
    assert.equal(ours.command, "node");
    assert.match(ours.args[0], /mcp\.js$/);
    const hooks = JSON.parse(readFileSync(hookPath, "utf8"));
    assert.equal(hooks.version, 1);
    assert.deepEqual(Object.keys(hooks.hooks), ["sessionStart"]);
    assert.equal(hooks.hooks.sessionStart.length, 1);
    assert.equal(hooks.hooks.sessionStart[0].type, "command");
    assert.equal(hooks.hooks.sessionStart[0].timeoutSec, 10);
    assert.match(hooks.hooks.sessionStart[0].command, /cli\.js" hook copilot$/);
    // Idempotent: the second run leaves both files byte for byte, and our own hook file is never backed up.
    const before = [readFileSync(mcpPath, "utf8"), readFileSync(hookPath, "utf8")];
    assert.equal((await run(home, ["install"])).code, 0);
    assert.deepEqual([readFileSync(mcpPath, "utf8"), readFileSync(hookPath, "utf8")], before);
    assert.deepEqual(readdirSync(join(cp, "hooks")), ["context-doctor.json"]);
    const doctor = await run(home, ["doctor"]);
    assert.match(doctor.out, /✓ Copilot MCP\s+MCP wired/);
    assert.match(doctor.out, /✓ Copilot hook\s+sessionStart in ~[\\/]\.copilot[\\/]hooks[\\/]context-doctor\.json/);
    const un = await run(home, ["uninstall"]);
    assert.equal(un.code, 0, un.err);
    assert.match(un.out, /GitHub Copilot: MCP server removed/);
    assert.match(un.out, /GitHub Copilot session-start hook removed/);
    assert.deepEqual(JSON.parse(readFileSync(mcpPath, "utf8")), theirs, "their config as it was");
    assert.equal(existsSync(join(cp, "hooks")), false, "the hooks folder install made is gone once empty");
    assert.equal(existsSync(cp), true, "~/.copilot stays: it holds their config");
});
test("VS Code alone counts as Copilot; uninstall leaves no ~/.copilot behind", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-vscode-"));
    const userDir = await withSandboxHome(home, () => vsCodeUserDirs()[0]);
    mkdirSync(userDir, { recursive: true });
    assert.equal((await run(home, ["install"])).code, 0);
    assert.ok(existsSync(join(home, ".copilot", "mcp-config.json")));
    assert.ok(existsSync(join(home, ".copilot", "hooks", "context-doctor.json")));
    await run(home, ["uninstall"]);
    assert.equal(existsSync(join(home, ".copilot")), false, "everything install created is gone");
    assert.ok(existsSync(userDir), "VS Code's own folder is not ours");
});
test("no Copilot, no VS Code: install creates nothing for Copilot and doctor says so", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-nocopilot-"));
    mkdirSync(join(home, ".cursor"), { recursive: true });
    await run(home, ["install"]);
    assert.equal(existsSync(join(home, ".copilot")), false);
    assert.match((await run(home, ["doctor"])).out, /– GitHub Copilot\s+not detected/);
});
test("a user's own entry in our hook file survives install and uninstall", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-copilot-theirs-"));
    const hookPath = join(home, ".copilot", "hooks", "context-doctor.json");
    mkdirSync(dirname(hookPath), { recursive: true });
    writeFileSync(hookPath, JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: "command", command: "./mine.sh" }] } }));
    await run(home, ["install"]);
    const installed = JSON.parse(readFileSync(hookPath, "utf8"));
    assert.equal(installed.hooks.sessionStart.length, 2);
    assert.equal(installed.hooks.sessionStart[0].command, "./mine.sh");
    await run(home, ["uninstall"]);
    assert.deepEqual(JSON.parse(readFileSync(hookPath, "utf8")).hooks.sessionStart, [{ type: "command", command: "./mine.sh" }]);
});
test("doctor fails a Copilot hook whose command is gone, or when Copilot's hooks are switched off", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-copilot-doctor-"));
    mkdirSync(join(home, ".copilot"), { recursive: true });
    await run(home, ["install"]);
    const hookPath = join(home, ".copilot", "hooks", "context-doctor.json");
    const config = JSON.parse(readFileSync(hookPath, "utf8"));
    const good = config.hooks.sessionStart[0].command;
    config.hooks.sessionStart[0].command = `node "${join(home, "gone", "cli.js")}" hook copilot`;
    writeFileSync(hookPath, JSON.stringify(config));
    const missing = await run(home, ["doctor"]);
    assert.match(missing.out, /✗ Copilot hook\s+registered, but .*gone[\\/]cli\.js no longer exists/);
    assert.equal(missing.code, 1);
    config.hooks.sessionStart[0].command = good;
    writeFileSync(hookPath, JSON.stringify(config));
    writeFileSync(join(home, ".copilot", "settings.json"), JSON.stringify({ disableAllHooks: true }));
    assert.match((await run(home, ["doctor"])).out, /✗ Copilot hook\s+registered, but disableAllHooks is true in ~[\\/]\.copilot[\\/]settings\.json/);
    writeFileSync(join(home, ".copilot", "settings.json"), "{}");
    writeFileSync(hookPath, "{ not json");
    assert.match((await run(home, ["doctor"])).out, /✗ Copilot hook\s+.*is not valid JSON/);
});
test("COPILOT_HOME moves Copilot's files, as Copilot's docs say", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-copilot-home-"));
    const custom = join(home, "custom-copilot");
    mkdirSync(custom, { recursive: true });
    assert.equal((await run(home, ["install"], undefined, { COPILOT_HOME: custom })).code, 0);
    assert.ok(existsSync(join(custom, "mcp-config.json")));
    assert.ok(existsSync(join(custom, "hooks", "context-doctor.json")));
    assert.equal(existsSync(join(home, ".copilot")), false);
});
test("the Copilot hook adds the standing rules at a new session's start, in both harnesses' shapes", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-copilot-hook-"));
    // Copilot harness, camelCase event key: no event name in the input.
    const camel = await run(home, ["hook", "copilot"], JSON.stringify({ sessionId: "s1", timestamp: 1761400000000, cwd: home, source: "new" }));
    const out = JSON.parse(camel.out);
    assert.match(out.additionalContext, /^<context-doctor>\nContext hygiene rules/);
    assert.ok(out.additionalContext.includes(SERVER_INSTRUCTIONS));
    assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
    assert.equal(out.hookSpecificOutput.additionalContext, out.additionalContext);
    // VS Code's Local harness: snake_case with the event name, plus a transcript path it never needs.
    const local = await run(home, ["hook", "copilot"], JSON.stringify({ hook_event_name: "SessionStart", session_id: "s2", timestamp: "2026-10-25T10:00:00.000Z", source: "new", transcript_path: join(home, "t.jsonl") }));
    assert.equal(JSON.parse(local.out).hookSpecificOutput.additionalContext, out.additionalContext);
    // A resumed session already holds them; other events get nothing.
    assert.equal((await run(home, ["hook", "copilot"], JSON.stringify({ sessionId: "s1", source: "resume" }))).out, "");
    assert.equal((await run(home, ["hook", "copilot"], JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s2" }))).out, "");
    // No ~/.claude: the hook does not create one (install would then see Claude Code).
    assert.equal(existsSync(join(home, ".claude")), false);
    // With one, doctor's evidence goes to the ledger.
    mkdirSync(join(home, ".claude"));
    await run(home, ["hook", "copilot"], JSON.stringify({ sessionId: "s3", source: "startup" }));
    assert.match(readFileSync(join(home, ".claude", ".context-doctor-ledger.jsonl"), "utf8"), /"ev":"session_rules","app":"copilot"/);
});
test("`hook` refuses an unknown app name", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-copilot-arg-"));
    const r = await run(home, ["hook", "copilto"], "{}");
    assert.equal(r.code, 1);
    assert.match(r.err, /hook takes no argument, or `copilot`/);
});
test("copilot helpers: which entries are ours, and what the hook says", () => {
    assert.equal(isOurCopilotEntry({ command: 'node "/x/dist/cli.js" hook copilot' }), true);
    assert.equal(isOurCopilotEntry({ command: '"C:\\\\npm\\\\context-doctor.cmd" hook copilot', powershell: '& "C:\\\\npm\\\\context-doctor.cmd" hook copilot' }), true);
    assert.equal(isOurCopilotEntry({ bash: "npx -y context-doctor hook copilot" }), true);
    assert.equal(isOurCopilotEntry({ command: 'node "/x/dist/cli.js" hook' }), false, "the Claude Code hook is not the Copilot one");
    assert.equal(isOurCopilotEntry({ command: "./audit.sh" }), false);
    assert.equal(copilotSessionStartOutput(null) !== undefined, true, "an empty input is a camelCase session start");
    assert.equal(copilotSessionStartOutput({ hook_event_name: "sessionStart" }) !== undefined, true);
    assert.equal(copilotSessionStartOutput({ hook_event_name: "agentStop" }), undefined);
});
