/**
 * Install and uninstall, end to end in a throwaway home: the server command an
 * npx install writes must start a package that exists, uninstall must leave
 * Claude Code able to reach the API and nothing of ours behind, and the
 * .backup next to a config must be the user's file, not our own earlier write.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "./sandbox.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
function run(home, args, extraEnv = {}, cli = cliPath) {
    return new Promise((resolve) => {
        execFile(process.execPath, [cli, ...args], { env: { ...sandboxEnv(home), ...extraEnv }, timeout: 30_000 }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, out: stdout, err: stderr }));
    });
}
/**
 * A PATH directory whose launchctl/systemctl/schtasks only record their
 * arguments. Removing the autopilot service addresses launchd and systemd by
 * label, and a test must never reach the developer's real ones.
 */
function serviceStubs() {
    const dir = mkdtempSync(join(tmpdir(), "ctxdoc-svcstub-"));
    const log = join(dir, "calls.log");
    for (const name of ["launchctl", "systemctl", "schtasks"]) {
        writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 0\n`);
        chmodSync(join(dir, name), 0o755);
    }
    return { dir, log };
}
test("an install run from the npx cache writes a server command whose package exists", async () => {
    // `npx -y context-doctor-mcp` asks npm for a package named
    // context-doctor-mcp, which does not exist (it is a bin inside
    // context-doctor): every app got a server that never started.
    const root = mkdtempSync(join(tmpdir(), "ctxdoc-npxmcp-"));
    const pkg = join(root, "_npx", "abc123", "node_modules", "context-doctor");
    mkdirSync(pkg, { recursive: true });
    cpSync(dirname(cliPath), join(pkg, "dist"), { recursive: true });
    cpSync(join(dirname(cliPath), "..", "skills"), join(pkg, "skills"), { recursive: true });
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-npxmcphome-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    const r = await run(home, ["install"], {}, join(pkg, "dist", "cli.js"));
    assert.equal(r.code, 0, r.err);
    const entry = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers["context-doctor"];
    assert.equal(entry.command, platform() === "win32" ? "cmd" : "npx");
    assert.ok(!entry.args.includes("context-doctor-mcp"), `no npm package is called context-doctor-mcp: ${JSON.stringify(entry)}`);
    assert.deepEqual(entry.args.slice(-3), ["-y", "context-doctor", "mcp"], "the package's own `mcp` subcommand");
    assert.match(readFileSync(join(home, ".codex", "config.toml"), "utf8"), /args = \[.*"context-doctor", "mcp"\]/);
});
test("doctor flags an existing context-doctor-mcp npx launcher instead of calling it wired", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-oldnpx-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { "context-doctor": { command: "npx", args: ["-y", "context-doctor-mcp"] } } }));
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "context-doctor": { command: "cmd", args: ["/c", "npx", "-y", "context-doctor-mcp"] } } }));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), `[mcp_servers.context-doctor]\ncommand = "npx"\nargs = ["-y", "context-doctor-mcp"]\n`);
    // No global install: npx has nothing to fall back to, and npm answers 404.
    const bare = mkdtempSync(join(tmpdir(), "ctxdoc-emptypath-"));
    const r = await run(home, ["doctor"], { PATH: bare });
    assert.equal(r.code, 1, "failed checks make the exit code 1");
    assert.match(r.out, /✗ Claude Code\s+.*context-doctor-mcp.*re-run: context-doctor install/);
    assert.match(r.out, /✗ Cursor\s+.*context-doctor-mcp/, "the Windows cmd /c form too");
    assert.match(r.out, /✗ Codex MCP\s+.*context-doctor-mcp/);
    assert.ok(!/✓ (Claude Code|Cursor)\s+MCP wired/.test(r.out), "a launcher that cannot start is not wired");
    // npx does fall back to a context-doctor-mcp command on PATH (a global
    // install): working, but only as long as that install exists. (Windows
    // spells the variable Path; overriding it from here is not reliable.)
    if (platform() === "win32")
        return;
    const global = mkdtempSync(join(tmpdir(), "ctxdoc-globalbin-"));
    writeFileSync(join(global, "context-doctor-mcp"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(global, "context-doctor-mcp"), 0o755);
    const g = await run(home, ["doctor"], { PATH: global });
    assert.match(g.out, /! Claude Code\s+.*only through your global install.*re-run: context-doctor install/);
});
test("uninstall switches autopilot off: Claude Code is no longer pointed at a dead port", { skip: platform() === "win32" && "schtasks resolves from System32, not a PATH stub" }, async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-uninstall-ap-"));
    const claude = join(home, ".claude");
    mkdirSync(join(claude, ".context-doctor-hook-state.d"), { recursive: true });
    writeFileSync(join(claude, ".context-doctor-hook-state.d", "0123456789abcdef.json"), JSON.stringify({ t: 0, b: 1 }));
    writeFileSync(join(claude, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787", MY_VAR: "kept" }, theme: "dark" }));
    writeFileSync(join(claude, ".context-doctor-autopilot.json"), JSON.stringify({ port: 8787, previousBaseUrl: null, node: process.execPath, cli: "/nowhere/cli.js" }));
    for (const f of [".context-doctor-autopilot-paused", ".context-doctor-autopilot-cleared.json", ".context-doctor-proxy.log", ".context-doctor-proxy-restart", ".context-doctor-calibration.json"]) {
        writeFileSync(join(claude, f), "{}");
    }
    // The service files this home's autopilot installed: `off` only asks the
    // service manager to remove a service whose file is in this home.
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(home, "Library", "LaunchAgents", "com.gai-ventures.context-doctor.proxy.plist"), "<plist/>");
    mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(join(home, ".config", "systemd", "user", "context-doctor-proxy.service"), "[Service]\n");
    const stubs = serviceStubs();
    const r = await run(home, ["uninstall"], { PATH: `${stubs.dir}${delimiter}${process.env.PATH ?? ""}` });
    assert.equal(r.code, 0, r.err);
    const settings = JSON.parse(readFileSync(join(claude, "settings.json"), "utf8"));
    assert.equal(settings.env?.ANTHROPIC_BASE_URL, undefined, "the proxy address must not outlive the package");
    assert.equal(settings.env?.MY_VAR, "kept", "other env settings are the user's");
    assert.equal(settings.theme, "dark");
    const left = readdirSync(claude).filter((f) => f.startsWith(".context-doctor") && !f.endsWith(".backup"));
    assert.deepEqual(left, [], "uninstall means gone");
    // The service was removed through the stubs, by the paths in this home.
    const calls = existsSync(stubs.log) ? readFileSync(stubs.log, "utf8") : "";
    if (platform() === "darwin")
        assert.match(calls, new RegExp(`launchctl bootout .*${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    if (platform() === "linux")
        assert.match(calls, /systemctl --user disable --now context-doctor-proxy\.service/);
});
test("uninstall restores the base URL autopilot replaced, and leaves service managers alone when autopilot was never on", { skip: platform() === "win32" && "schtasks resolves from System32, not a PATH stub" }, async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-uninstall-prev-"));
    const claude = join(home, ".claude");
    mkdirSync(claude, { recursive: true });
    writeFileSync(join(claude, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9911" } }));
    writeFileSync(join(claude, ".context-doctor-autopilot.json"), JSON.stringify({ port: 9911, previousBaseUrl: "https://gateway.example", node: process.execPath, cli: "/nowhere/cli.js" }));
    const stubs = serviceStubs();
    const path = `${stubs.dir}${delimiter}${process.env.PATH ?? ""}`;
    await run(home, ["uninstall"], { PATH: path });
    assert.equal(JSON.parse(readFileSync(join(claude, "settings.json"), "utf8")).env.ANTHROPIC_BASE_URL, "https://gateway.example");
    // A home that never had autopilot: no launchctl/systemctl call at all.
    const plain = mkdtempSync(join(tmpdir(), "ctxdoc-uninstall-plain-"));
    mkdirSync(join(plain, ".claude"), { recursive: true });
    const quiet = serviceStubs();
    await run(plain, ["install"], { PATH: `${quiet.dir}${delimiter}${process.env.PATH ?? ""}` });
    await run(plain, ["uninstall"], { PATH: `${quiet.dir}${delimiter}${process.env.PATH ?? ""}` });
    assert.ok(!existsSync(quiet.log), "no service manager is touched when autopilot is off");
});
test("uninstall with a damaged autopilot config still unroutes Claude Code from the proxy", { skip: platform() === "win32" && "schtasks resolves from System32, not a PATH stub" }, async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-uninstall-broken-"));
    const claude = join(home, ".claude");
    mkdirSync(claude, { recursive: true });
    writeFileSync(join(claude, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" } }));
    writeFileSync(join(claude, ".context-doctor-autopilot.json"), '{"port": 8787, "previousBa');
    const stubs = serviceStubs();
    const r = await run(home, ["uninstall"], { PATH: `${stubs.dir}${delimiter}${process.env.PATH ?? ""}` });
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(readFileSync(join(claude, "settings.json"), "utf8")).env?.ANTHROPIC_BASE_URL, undefined);
    assert.ok(!existsSync(join(claude, ".context-doctor-autopilot.json")));
});
test("the .backup an install leaves is the user's original settings, not our own first write", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-backup-"));
    const claude = join(home, ".claude");
    mkdirSync(claude, { recursive: true });
    const original = JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "my-stop-hook" }] }] } });
    writeFileSync(join(claude, "settings.json"), original);
    // One run writes settings.json four times: prompt, compaction and session-start hooks, status line.
    const r = await run(home, ["install", "--statusline"]);
    assert.equal(r.code, 0, r.err);
    const backup = join(claude, "settings.json.context-doctor.backup");
    assert.equal(readFileSync(backup, "utf8"), original, "the backup must hold none of our own entries");
    const hooks = JSON.parse(readFileSync(join(claude, "settings.json"), "utf8")).hooks;
    assert.ok(hooks.UserPromptSubmit && hooks.PreCompact && hooks.SessionStart, "install did its work");
});
test("install, doctor and uninstall leave no trace in any app's config", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-roundtrip-"));
    for (const d of [".claude", ".cursor", ".codex", ".gemini"])
        mkdirSync(join(home, d), { recursive: true });
    writeFileSync(join(home, ".gemini", "settings.json"), "{}");
    writeFileSync(join(home, ".codex", "config.toml"), `model = "gpt-5.6-sol"\n`);
    assert.equal((await run(home, ["install", "--statusline"])).code, 0);
    assert.equal((await run(home, ["doctor"])).code, 0);
    // The hook runs once so its state directory exists, as on any real machine.
    await new Promise((resolve) => {
        const child = execFile(process.execPath, [cliPath, "hook"], { env: sandboxEnv(home) }, () => resolve());
        const t = join(home, "t.jsonl");
        writeFileSync(t, JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(300_000) } }) + "\n");
        child.stdin?.end(JSON.stringify({ session_id: "s", transcript_path: t }));
    });
    assert.ok(existsSync(join(home, ".claude", ".context-doctor-hook-state.d")), "fixture: the hook wrote its state");
    assert.equal((await run(home, ["uninstall"])).code, 0);
    for (const f of [".claude.json", ".claude/settings.json", ".cursor/mcp.json", ".cursor/hooks.json", ".codex/config.toml", ".codex/hooks.json", ".gemini/settings.json"]) {
        const p = join(home, f);
        if (existsSync(p))
            assert.ok(!/context-doctor|cli\.js/.test(readFileSync(p, "utf8")), `${f} still mentions us`);
    }
    const ours = readdirSync(join(home, ".claude")).filter((f) => f.startsWith(".context-doctor") && !f.endsWith(".backup"));
    assert.deepEqual(ours, [], "no state, ledger or autopilot files left in ~/.claude");
    assert.ok(!existsSync(join(home, ".claude", "skills", "context-doctor")));
    assert.ok(!existsSync(join(home, ".codex", "skills", "context-doctor")));
});
