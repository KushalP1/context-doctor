/**
 * The plugin as Anthropic's directory gets it (scripts/build-directory-plugin.mjs,
 * ROADMAP E5): a folder with only what the plugin runs, the listing fields and
 * engines["claude-code"] in its plugin.json (never in the repository's own: Claude
 * Code before 2.1.76 refuses a manifest with keys it does not know), within the
 * directory's file limits, and working from a folder with no node_modules. The
 * --no-mod build is the fallback for a directory that refuses a hooks module.
 * `claude plugin validate --profile directory --strict` on both builds runs in
 * verify-local and the weekly canary workflow, where a Claude Code is installed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(root, "scripts", "build-directory-plugin.mjs");
function build(args) {
    return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", timeout: 120_000 });
}
function files(dir, base = dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name), base) : [relative(base, join(dir, e.name)).split("\\").join("/")]));
}
/**
 * The server's tools/list reply. Settles only once the server has exited:
 * its working folder is the build, and Windows refuses to remove a folder
 * a process still has as its own (EBUSY, Node 20).
 */
function mcpAnswers(bundle, cwd) {
    const child = spawn(process.execPath, [bundle], { stdio: ["pipe", "pipe", "ignore"], cwd });
    const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
    const exited = new Promise((res) => child.once("close", () => res()));
    return new Promise((resolve, reject) => {
        let out = "";
        let ended = false;
        const end = (settle) => { if (ended)
            return; ended = true; clearTimeout(t); child.kill(); void exited.then(settle); };
        const t = setTimeout(() => end(() => reject(new Error(`no tools/list reply: ${out.slice(0, 200)}`))), 15_000);
        child.stdout.on("data", (d) => { out += d; if (out.includes(`"id":2`))
            end(() => resolve(out)); });
        send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    });
}
test("the directory build: listing fields and engines, only what the plugin runs, within the directory's limits, runs with no node_modules", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "cd-directory-")), "plugin");
    try {
        const r = build(["--out", out]);
        assert.equal(r.status, 0, r.stderr + r.stdout);
        const manifest = JSON.parse(readFileSync(join(out, ".claude-plugin", "plugin.json"), "utf8"));
        const own = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
        assert.deepEqual(manifest.engines, { "claude-code": ">=2.1.76" });
        for (const k of ["documentationUrl", "supportUrl", "privacyPolicyUrl"])
            assert.match(manifest[k], /^https:\/\/github\.com\/KushalP1\/context-doctor/, k);
        assert.ok(existsSync(join(root, "docs", "privacy.md")), "the privacy policy the listing links to");
        // Everything else is the repository's manifest, unchanged.
        const { engines: _e, icon: _i, documentationUrl: _d, supportUrl: _s, privacyPolicyUrl: _p, ...rest } = manifest;
        assert.deepEqual(rest, own);
        assert.equal(own.engines, undefined, "the repository's own plugin.json carries no engines: 2.1.62-2.1.75 would refuse the whole plugin");
        // The icon: a square PNG of 512 to 2048 px, under 2 MB (ICON_INVALID otherwise).
        const icon = readFileSync(join(out, manifest.icon));
        assert.equal(icon.subarray(1, 4).toString(), "PNG");
        const w = icon.readUInt32BE(16), h = icon.readUInt32BE(20);
        assert.ok(w === h && w >= 512 && w <= 2048 && icon.length < 2 * 1024 * 1024, `icon ${w}x${h}, ${icon.length} bytes`);
        const all = files(out);
        assert.ok(all.length <= 512, `${all.length} files: over 512 is held for a reviewer`);
        for (const f of all)
            assert.ok(statSync(join(out, f)).size < 5 * 1024 * 1024, `${f}: 5 MiB or more stops the portal's validation`);
        const big = all.filter((f) => !f.endsWith(".png") && statSync(join(out, f)).size > 256 * 1024);
        assert.deepEqual(big, ["dist/mcp.bundle.js"], "only the MCP server's bundle is over 256 KiB");
        for (const f of [".claude-plugin/marketplace.json", "package-lock.json", "dist/mcpclient.js", "dist/test", "dist/index.d.ts", "src", "python", "docs"])
            assert.ok(!all.some((a) => a === f || a.startsWith(f + "/")), `${f} is not in the build`);
        const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
        assert.equal(pkg.type, "module");
        assert.equal(pkg.dependencies, undefined, "nothing for Claude Code to install");
        assert.equal(pkg.devDependencies, undefined);
        // The README is the listing's description: at least 40 words outside code blocks, saying what it runs and sends.
        const readme = readFileSync(join(out, "README.md"), "utf8");
        assert.ok(readme.replace(/```[\s\S]*?```/g, "").split(/\s+/).filter(Boolean).length >= 40);
        assert.match(readme, /What it runs, reads, writes and sends/);
        assert.match(readme, /no telemetry/i);
        // Every path a hook, the MCP server and the mod name is in the build.
        const sub = (s) => s.replace("${CLAUDE_PLUGIN_ROOT}", out).replace(/^node "?|"? hook$/g, "");
        for (const ev of Object.values(manifest.hooks))
            for (const g of ev)
                for (const h of g.hooks)
                    assert.ok(existsSync(sub(h.command)), h.command);
        assert.ok(existsSync(sub(manifest.mcpServers["context-doctor"].args[0])));
        const hooks = JSON.parse(readFileSync(join(out, "hooks", "hooks.json"), "utf8"));
        assert.deepEqual(hooks.modules, ["../dist/mod/register.js"]);
        assert.ok(existsSync(join(out, "hooks", hooks.modules[0])));
        assert.ok(hooks.hooks.PreModelSwitch);
        for (const s of readdirSync(join(out, manifest.skills)))
            assert.ok(existsSync(join(out, manifest.skills, s, "SKILL.md")), s);
        // It runs from a folder with no node_modules above it: the CLI, and the MCP server readable (not minified).
        const v = spawnSync(process.execPath, [join(out, "dist", "cli.js"), "--version"], { cwd: out, encoding: "utf8" });
        assert.equal(v.stdout.trim(), own.version, v.stderr);
        const bundle = readFileSync(join(out, "dist", "mcp.bundle.js"), "utf8");
        assert.ok(bundle.split("\n").length > 5000, "the MCP server's bundle is not minified, so the security scan can read it");
        assert.ok(bundle.startsWith("#!/usr/bin/env node\n") && !bundle.split("\n").slice(1).some((l) => l.startsWith("#!")), "one shebang, on the first line");
        for (const b of ["mcp.bundle.js", "mcp.js"])
            assert.match(await mcpAnswers(join(out, "dist", b), out), /profile_context/, b);
    }
    finally {
        rmSync(dirname(out), { recursive: true, force: true, maxRetries: 10 });
    }
});
test("the --no-mod build: no hooks module, the rest unchanged", () => {
    const out = join(mkdtempSync(join(tmpdir(), "cd-directory-")), "plugin");
    try {
        const r = build(["--out", out, "--no-mod"]);
        assert.equal(r.status, 0, r.stderr + r.stdout);
        const hooks = JSON.parse(readFileSync(join(out, "hooks", "hooks.json"), "utf8"));
        assert.equal(hooks.modules, undefined);
        assert.ok(hooks.hooks.PreModelSwitch, "the model-switch hook stays");
        assert.doesNotMatch(hooks.description, /mod/);
        assert.ok(!existsSync(join(out, "dist", "mod")));
        assert.ok(existsSync(join(out, "dist", "cli.js")) && existsSync(join(out, "dist", "mcp.bundle.js")));
    }
    finally {
        rmSync(dirname(out), { recursive: true, force: true, maxRetries: 10 });
    }
});
test("the build replaces only an earlier build of itself, and keeps a git checkout's .git", () => {
    const tmp = mkdtempSync(join(tmpdir(), "cd-directory-"));
    try {
        const foreign = join(tmp, "foreign");
        mkdirSync(foreign);
        writeFileSync(join(foreign, "keep.txt"), "mine");
        const r = build(["--out", foreign]);
        assert.equal(r.status, 2);
        assert.match(r.stderr, /refusing to replace it/);
        assert.equal(readFileSync(join(foreign, "keep.txt"), "utf8"), "mine");
        const out = join(tmp, "plugin");
        assert.equal(build(["--out", out]).status, 0);
        mkdirSync(join(out, ".git"));
        writeFileSync(join(out, ".git", "HEAD"), "ref: refs/heads/directory\n");
        writeFileSync(join(out, "stale.txt"), "from an earlier build");
        assert.equal(build(["--out", out, "--no-mod"]).status, 0);
        assert.ok(!existsSync(join(out, "stale.txt")));
        assert.equal(readFileSync(join(out, ".git", "HEAD"), "utf8"), "ref: refs/heads/directory\n");
        assert.ok(!existsSync(join(out, "dist", "mod")));
    }
    finally {
        rmSync(tmp, { recursive: true, force: true, maxRetries: 10 });
    }
});
