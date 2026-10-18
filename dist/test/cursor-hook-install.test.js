/**
 * Cursor's native hooks: install writes postToolUse, postToolUseFailure and
 * sessionStart entries to ~/.cursor/hooks.json (the Cursor events whose
 * additional_context reaches the model), repairs rather than duplicates
 * them, keeps the user's own hooks, and uninstall removes only ours. The
 * hook answers each of them with additional_context, and doctor says what
 * the installed Cursor version does with it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "./sandbox.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
test("install adds Cursor's postToolUse hook once, keeps theirs, and uninstall removes only ours", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-cursorhome-"));
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const hooksPath = join(home, ".cursor", "hooks.json");
    writeFileSync(hooksPath, JSON.stringify({ version: 1, hooks: { postToolUse: [{ command: "./their-formatter.sh" }], afterFileEdit: [{ command: "./fmt.sh" }] } }));
    const run = (cmd) => new Promise((resolve, reject) => {
        execFile(process.execPath, [cliPath, cmd], { env: sandboxEnv(home) }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
    });
    assert.match(await run("install"), /Cursor hooks installed/);
    await run("install"); // idempotent
    const config = JSON.parse(readFileSync(hooksPath, "utf8"));
    assert.equal(config.version, 1);
    const commands = config.hooks.postToolUse.map((h) => h.command);
    assert.equal(commands.length, 2, "theirs plus exactly one of ours");
    assert.equal(commands[0], "./their-formatter.sh");
    assert.match(commands[1], /cli\.js" hook$/);
    assert.deepEqual(config.hooks.afterFileEdit, [{ command: "./fmt.sh" }], "other events untouched");
    for (const event of ["postToolUseFailure", "sessionStart"]) {
        assert.equal(config.hooks[event].length, 1, `the ${event} fallback, once`);
        assert.match(config.hooks[event][0].command, /cli\.js" hook$/);
    }
    await run("uninstall");
    const left = JSON.parse(readFileSync(hooksPath, "utf8"));
    assert.deepEqual(left.hooks.postToolUse, [{ command: "./their-formatter.sh" }]);
    assert.deepEqual(left.hooks.afterFileEdit, [{ command: "./fmt.sh" }]);
    assert.equal(left.hooks.postToolUseFailure, undefined);
    assert.equal(left.hooks.sessionStart, undefined);
});
test("install creates ~/.cursor/hooks.json when Cursor has none", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-cursorhome-"));
    mkdirSync(join(home, ".cursor"), { recursive: true });
    await new Promise((resolve, reject) => execFile(process.execPath, [cliPath, "install"], { env: sandboxEnv(home) }, (err) => (err ? reject(err) : resolve(undefined))));
    const config = JSON.parse(readFileSync(join(home, ".cursor", "hooks.json"), "utf8"));
    assert.equal(config.version, 1);
    assert.equal(config.hooks.postToolUse.length, 1);
    assert.equal(config.hooks.postToolUse[0].timeout, 10);
});
test("the hook answers postToolUseFailure and sessionStart like postToolUse, and records the Cursor version", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-cursorev-"));
    const t = join(home, "agent.jsonl");
    // A heavy Cursor agent transcript (tool calls recorded, output not).
    writeFileSync(t, Array.from({ length: 40 }, (_, i) => JSON.stringify({ role: i % 2 ? "assistant" : "user", message: { content: [{ type: "text", text: `turn ${i} ` + "word ".repeat(4000) }] } })).join("\n") + "\n");
    const run = (event, sid) => new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [cliPath, "hook"], { env: { ...sandboxEnv(home), CONTEXT_DOCTOR_HOOK_STATE: join(home, "state.json"), CONTEXT_DOCTOR_WARN_TOKENS: "5000" } }, (err, out) => (err ? reject(err) : resolve(out)));
        child.stdin.end(JSON.stringify({ hook_event_name: event, conversation_id: sid, transcript_path: t, cursor_version: "3.18.25", tool_name: "Shell" }));
    });
    for (const event of ["postToolUseFailure", "sessionStart"]) {
        const out = await run(event, `c-${event}`);
        assert.match(JSON.parse(out).additional_context, /^<context-doctor>/, event);
    }
    assert.equal((await run("beforeSubmitPrompt", "c-x")).trim(), "", "Cursor's run of the Claude Code hook stays silent");
    const ledger = readFileSync(join(home, ".context-doctor-ledger.jsonl"), "utf8");
    assert.match(ledger, /"cv":"3\.18\.25"/);
});
