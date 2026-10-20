/**
 * The PreModelSwitch warning: what a switch costs, shown and never blocking;
 * installed only where no older Claude Code would skip the whole settings
 * file over it; carried by the plugin in a hooks file of its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeCodeInstalls, compareVersions, modelSwitchMessage, modelSwitchReadiness } from "../modelswitch.js";
import { sandboxEnv } from "./sandbox.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
function transcript(dir, contextTokens) {
    const p = join(dir, "t.jsonl");
    writeFileSync(p, JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-sonnet-5", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, cache_read_input_tokens: contextTokens - 10, cache_creation_input_tokens: 0 } } }) + "\n");
    return p;
}
test("the message prices the re-write on the new model and the read it replaces", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-pms-"));
    const t = transcript(dir, 400_000);
    const msg = modelSwitchMessage({ transcript_path: t, from_model: "claude-sonnet-5", to_model: "claude-opus-5-5[1m]", prompt_cache_warm: true, cache_ttl: "5m", context_tokens: 1 });
    // 400k at Opus 5.5's $4/M x 1.25 = $2.00; staying reads it at Sonnet 5's $0.20/M = $0.08.
    assert.match(msg, /switching to claude-opus-5-5\[1m\] re-writes this session's ~400k-token context into its cache: about \$2\.00 once at the 5-minute cache-write rate, where the next request on claude-sonnet-5 would read it for \$0\.080/);
    const hour = modelSwitchMessage({ transcript_path: t, from_model: "claude-sonnet-5", to_model: "claude-opus-5-5", cache_ttl: "1h" });
    assert.match(hour, /about \$3\.20 once at the 1-hour/);
    // Claude Code's own estimate stands in before any reply.
    assert.match(modelSwitchMessage({ to_model: "claude-opus-5-5", from_model: "claude-sonnet-5", context_tokens: 100_000 }), /~100k-token/);
});
test("nothing to say: cold cache, no real switch, small context; unknown price says tokens only", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-pms-quiet-"));
    const t = transcript(dir, 400_000);
    assert.equal(modelSwitchMessage({ transcript_path: t, from_model: "claude-sonnet-5", to_model: "claude-opus-5-5", prompt_cache_warm: false }), undefined);
    assert.equal(modelSwitchMessage({ transcript_path: t, from_model: "claude-opus-5-5", to_model: "claude-opus-5-5[1m]" }), undefined);
    assert.equal(modelSwitchMessage({ from_model: "a", to_model: "claude-opus-5-5", context_tokens: 5_000 }), undefined);
    assert.equal(modelSwitchMessage({ to_model: 42, context_tokens: 500_000 }), undefined);
    assert.match(modelSwitchMessage({ transcript_path: t, from_model: "claude-sonnet-5", to_model: "my-gateway-model" }), /no known price for my-gateway-model/);
});
test("the hook answers PreModelSwitch with a systemMessage only, and exits 0", async () => {
    const home = mkdtempSync(join(tmpdir(), "cd-pms-hook-"));
    const t = transcript(home, 300_000);
    const input = { session_id: "s1", transcript_path: t, cwd: home, hook_event_name: "PreModelSwitch", from_model: "claude-sonnet-5", to_model: "claude-opus-5-5", requested_model: "opus", source: "command", context_tokens: 300_000, prompt_cache_warm: true, cache_ttl: "5m", estimated_cache_write_usd: 1.5, pricing: "catalog" };
    const run = (payload) => new Promise((resolve) => {
        const child = execFile(process.execPath, [cliPath, "hook"], { env: sandboxEnv(home) }, (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout, stderr }));
        child.stdin.end(JSON.stringify(payload));
    });
    const r = await run(input);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(out), ["systemMessage"], "informs only: no decision, no permissionDecision");
    assert.match(out.systemMessage, /about \$1\.50 once/);
    const cold = await run({ ...input, prompt_cache_warm: false });
    assert.equal(cold.code, 0);
    assert.equal(cold.stdout, "");
});
test("versions compare numerically; the desktop app counts as its newest Claude Code", () => {
    assert.equal(compareVersions("2.1.62", "2.1.251"), -1);
    assert.equal(compareVersions("2.1.299", "2.1.251"), 1);
    assert.equal(compareVersions("2.2.0", "2.1.999"), 1);
    assert.equal(compareVersions("2.1.251", "2.1.251"), 0);
    const home = mkdtempSync(join(tmpdir(), "cd-pms-ver-"));
    for (const v of ["2.1.240", "2.1.299", "2.1.295"])
        mkdirSync(join(home, "Library", "Application Support", "Claude", "claude-code", v), { recursive: true });
    const app = claudeCodeInstalls({ home, pathEnv: "", runVersion: false }).filter((i) => i.source === "desktop app");
    assert.deepEqual(app.map((i) => i.version), ["2.1.299"]);
    const r = modelSwitchReadiness([{ path: "/x/claude", version: "2.1.62", source: "cli" }, ...app]);
    assert.equal(r.ok, false);
    assert.deepEqual(r.old.map((i) => i.version), ["2.1.62"]);
    assert.equal(modelSwitchReadiness(app).ok, true);
    assert.equal(modelSwitchReadiness([]).ok, false, "nothing found: do not guess");
});
test("a CLI's version is read from its install path, or from --version", { skip: process.platform === "win32" && "shell stubs" }, () => {
    const home = mkdtempSync(join(tmpdir(), "cd-pms-cli-"));
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '2.1.62 (Claude Code)'\n");
    chmodSync(join(bin, "claude"), 0o755);
    const found = claudeCodeInstalls({ home, pathEnv: bin }).filter((i) => i.path.startsWith(home));
    assert.deepEqual(found.map((i) => [i.version, i.source]), [["2.1.62", "cli"]]);
    const versioned = join(home, "Caskroom", "claude-code", "2.1.299");
    mkdirSync(versioned, { recursive: true });
    writeFileSync(join(versioned, "claude"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(versioned, "claude"), 0o755);
    const byPath = claudeCodeInstalls({ home, pathEnv: versioned, runVersion: false }).filter((i) => i.path.startsWith(home));
    assert.deepEqual(byPath.map((i) => i.version), ["2.1.299"]);
});
function runCli(home, args, extra = {}) {
    return new Promise((resolve) => {
        execFile(process.execPath, [cliPath, ...args], { env: { ...sandboxEnv(home), ...extra }, timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, out: stdout, err: stderr }));
    });
}
test("install writes PreModelSwitch only when no older Claude Code is around; uninstall and doctor know it", async () => {
    const home = mkdtempSync(join(tmpdir(), "cd-pms-install-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    const settings = () => JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    const ours = () => JSON.stringify(settings().hooks?.PreModelSwitch ?? []).includes("hook");
    const ok = await runCli(home, ["install"], { CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS: "2.1.299" });
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /model-switch warning installed/);
    assert.ok(ours());
    // An older Claude Code appears: install takes our entry out again, and says why.
    const old = await runCli(home, ["install"], { CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS: "2.1.299,2.1.62" });
    assert.equal(old.code, 0, old.err);
    assert.match(old.out, /model-switch warning skipped: Claude Code 2\.1\.62 .*predates PreModelSwitch \(2\.1\.251\)/);
    assert.equal(settings().hooks?.PreModelSwitch, undefined);
    assert.ok(settings().hooks?.UserPromptSubmit, "the other hooks stay");
    // doctor fails a PreModelSwitch entry next to an older Claude Code.
    const s = settings();
    s.hooks.PreModelSwitch = [{ hooks: [{ type: "command", command: "context-doctor hook" }] }];
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(s));
    const doc = await runCli(home, ["doctor"], { CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS: "2.1.62" });
    assert.match(doc.out, /Model-switch warning[^\n]*2\.1\.62[^\n]*skips the whole file/);
    const un = await runCli(home, ["uninstall"], { CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS: "2.1.299" });
    assert.equal(un.code, 0, un.err);
    assert.equal(existsSync(join(home, ".claude", "settings.json")) ? settings().hooks?.PreModelSwitch : undefined, undefined);
});
test("the plugin carries PreModelSwitch in hooks/hooks.json alone, never in plugin.json", () => {
    const manifest = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(manifest.hooks.PreModelSwitch, undefined, "inline, an older Claude Code would drop every plugin hook");
    const file = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8"));
    assert.deepEqual(Object.keys(file.hooks), ["PreModelSwitch"]);
    assert.match(file.hooks.PreModelSwitch[0].hooks[0].command, /dist\/cli\.js" hook$/);
});
