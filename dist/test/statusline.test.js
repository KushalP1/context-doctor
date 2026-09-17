/**
 * The status line must be fast, truthful, and silent on failure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { renderStatusLine, tailUsage } from "../statusline.js";
import { sandboxEnv } from "./sandbox.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
test("uses the payload's context window when present, the transcript tail when not", () => {
    const fromPayload = renderStatusLine({
        model: { id: "claude-sonnet-5" },
        context_window: { total_input_tokens: 150_000, context_window_size: 1_000_000 },
        cost: { total_cost_usd: 0.5 },
    });
    assert.match(fromPayload ?? "", /ctx 150k\/1\.0M .* 15%/);
    assert.match(fromPayload ?? "", /\$0\.500/);
    assert.ok(!fromPayload?.includes("⚠"), "15% is not a warning");
    // Transcript whose last assistant turn reports 800k of a 1M window, mostly cached.
    const dir = mkdtempSync(join(tmpdir(), "ctxdoc-sl-"));
    const path = join(dir, "t.jsonl");
    const filler = JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(50_000) } });
    writeFileSync(path, [
        filler, filler, filler,
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "ok", model: "claude-opus-5", usage: { input_tokens: 20_000, cache_read_input_tokens: 780_000 } } }),
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"partial line with no usage\"}}",
    ].join("\n") + "\n");
    const tail = tailUsage(path);
    assert.equal(tail?.tokens, 800_000);
    assert.ok(Math.abs((tail?.cacheShare ?? 0) - 0.975) < 0.001);
    const fromTail = renderStatusLine({ transcript_path: path, model: { id: "claude-opus-5" } });
    assert.match(fromTail ?? "", /ctx 800k\/1\.0M .* 80% ⚠/, "80% of the window earns the warning mark");
    assert.match(fromTail ?? "", /cache 98%/);
});
test("nothing trustworthy means nothing printed, never an error", async () => {
    assert.equal(renderStatusLine({}), null);
    assert.equal(renderStatusLine({ transcript_path: "/definitely/not/here.jsonl" }), null);
    for (const stdin of ["not json", "", "{}"]) {
        const { out, code } = await new Promise((resolve) => {
            const child = execFile(process.execPath, [cliPath, "statusline"], (err, stdout) => resolve({ out: stdout, code: err ? err.code ?? 1 : 0 }));
            child.stdin?.end(stdin);
        });
        assert.equal(out, "", `stdin ${JSON.stringify(stdin)} must print nothing`);
        assert.equal(code, 0, "a status line command must never fail the shell");
    }
});
test("install --statusline wires it, never overwrites someone else's, and uninstall removes only ours", async () => {
    const run = (home, ...args) => new Promise((resolve, reject) => {
        execFile(process.execPath, [cliPath, ...args], { env: sandboxEnv(home) }, (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(stdout));
    });
    const settingsOf = (home) => JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    // Fresh machine: installed.
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-slhome-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    assert.match(await run(home, "install", "--statusline"), /status line installed/);
    assert.match(settingsOf(home).statusLine.command, /statusline$/);
    // Plain install without the flag leaves it as is; a second --statusline is idempotent.
    await run(home, "install");
    assert.match(settingsOf(home).statusLine.command, /statusline$/);
    assert.match(await run(home, "install", "--statusline"), /already installed/);
    // Uninstall removes ours.
    await run(home, "uninstall");
    assert.equal(settingsOf(home).statusLine, undefined);
    // A machine with its own status line: left alone, and said so.
    const theirs = mkdtempSync(join(tmpdir(), "ctxdoc-slforeign-"));
    mkdirSync(join(theirs, ".claude"), { recursive: true });
    writeFileSync(join(theirs, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "my-fancy-prompt.sh" } }));
    assert.match(await run(theirs, "install", "--statusline"), /left alone: you already have your own/);
    assert.equal(settingsOf(theirs).statusLine.command, "my-fancy-prompt.sh");
    await run(theirs, "uninstall");
    assert.equal(settingsOf(theirs).statusLine.command, "my-fancy-prompt.sh", "uninstall never touches a status line that is not ours");
});
