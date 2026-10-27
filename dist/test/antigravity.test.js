/**
 * N4: Antigravity (app, IDE, CLI). install adds the MCP server to
 * ~/.gemini/config/mcp_config.json, which Antigravity creates EMPTY, and the
 * skill to its skills folder; doctor checks both; uninstall leaves the file
 * empty again and removes only what install made. All in a throwaway home.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "./sandbox.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
function run(home, args) {
    return new Promise((resolve) => {
        execFile(process.execPath, [cliPath, ...args], { env: sandboxEnv(home), timeout: 30_000 }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, out: stdout, err: stderr }));
    });
}
/** A home as Antigravity 2.12 leaves it: an empty shared MCP file, the app's folder linking to it. */
function antigravityHome() {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-agy-"));
    const config = join(home, ".gemini", "config");
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "mcp_config.json"), "");
    mkdirSync(join(home, ".gemini", "antigravity"), { recursive: true });
    if (platform() !== "win32")
        symlinkSync(join(config, "mcp_config.json"), join(home, ".gemini", "antigravity", "mcp_config.json"));
    return home;
}
test("install wires Antigravity's empty mcp_config.json and its skill; uninstall leaves it as it was", async () => {
    const home = antigravityHome();
    const mcpPath = join(home, ".gemini", "config", "mcp_config.json");
    const r = await run(home, ["install"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /✓ Antigravity: MCP server added/);
    assert.match(r.out, /✓ Antigravity skill installed/);
    const entry = JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers["context-doctor"];
    assert.ok(entry.command && Array.isArray(entry.args), JSON.stringify(entry));
    const skill = join(home, ".gemini", "config", "skills", "context-doctor", "SKILL.md");
    assert.match(readFileSync(skill, "utf8"), /^---\nname: context-doctor\ndescription: /);
    if (platform() !== "win32") {
        // The app reads the same file through its link.
        assert.ok(JSON.parse(readFileSync(join(home, ".gemini", "antigravity", "mcp_config.json"), "utf8")).mcpServers["context-doctor"]);
    }
    const d = await run(home, ["doctor"]);
    assert.match(d.out, /✓ Antigravity MCP/);
    assert.match(d.out, /✓ Antigravity skill\s+in ~[\\/]\.gemini[\\/]config[\\/]skills[\\/]context-doctor/);
    const u = await run(home, ["uninstall"]);
    assert.equal(u.code, 0, u.out + u.err);
    assert.equal(readFileSync(mcpPath, "utf8"), "", "an empty file before install is an empty file after");
    assert.ok(!existsSync(join(home, ".gemini", "config", "skills")), "the skills folder install made is gone");
    assert.ok(!existsSync(join(home, ".gemini", ".context-doctor-created.json")));
    assert.ok(existsSync(join(home, ".gemini", "antigravity")));
});
test("the user's own servers and skills folder are kept", async () => {
    const home = antigravityHome();
    const mcpPath = join(home, ".gemini", "config", "mcp_config.json");
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { mine: { command: "my-server", disabledTools: ["x"] } } }));
    mkdirSync(join(home, ".gemini", "config", "skills", "my-skill"), { recursive: true });
    assert.equal((await run(home, ["install"])).code, 0);
    assert.equal(JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers.mine.command, "my-server");
    assert.equal((await run(home, ["uninstall"])).code, 0);
    const after = JSON.parse(readFileSync(mcpPath, "utf8"));
    assert.deepEqual(after, { mcpServers: { mine: { command: "my-server", disabledTools: ["x"] } } });
    assert.ok(existsSync(join(home, ".gemini", "config", "skills", "my-skill")));
    assert.ok(!existsSync(join(home, ".gemini", "config", "skills", "context-doctor")));
});
test("Gemini CLI's ~/.gemini alone is not Antigravity", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-agy-gemini-"));
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "settings.json"), "{}");
    await run(home, ["install"]);
    assert.ok(!existsSync(join(home, ".gemini", "config")));
    assert.match((await run(home, ["doctor"])).out, /– Antigravity\s+not detected/);
});
test("an install from before the shared folder: the app's own file and legacy skills folder", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-agy-legacy-"));
    const legacy = join(home, ".gemini", "antigravity", "mcp_config.json");
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, "{}");
    assert.equal((await run(home, ["install"])).code, 0);
    assert.ok(JSON.parse(readFileSync(legacy, "utf8")).mcpServers["context-doctor"]);
    assert.ok(existsSync(join(home, ".gemini", "antigravity", "skills", "context-doctor", "SKILL.md")));
    assert.ok(!existsSync(join(home, ".gemini", "config")), "no shared folder made for it");
    assert.equal((await run(home, ["uninstall"])).code, 0);
    assert.ok(!existsSync(join(home, ".gemini", "antigravity", "skills")));
});
test("doctor warns when Antigravity has the server switched off", async () => {
    const home = antigravityHome();
    assert.equal((await run(home, ["install"])).code, 0);
    const mcpPath = join(home, ".gemini", "config", "mcp_config.json");
    const config = JSON.parse(readFileSync(mcpPath, "utf8"));
    config.mcpServers["context-doctor"].disabled = true;
    writeFileSync(mcpPath, JSON.stringify(config));
    assert.match((await run(home, ["doctor"])).out, /! Antigravity MCP\s+"disabled": true/);
});
// -- QA (2026-10-27) -------------------------------------------------------
test("install twice, then uninstall: the user's empty config stays, and so does the app's link to it", async () => {
    const home = antigravityHome();
    const mcpPath = join(home, ".gemini", "config", "mcp_config.json");
    assert.equal((await run(home, ["install"])).code, 0);
    assert.equal((await run(home, ["install"])).code, 0);
    assert.equal(readFileSync(mcpPath + ".context-doctor.backup", "utf8"), "", "the second install keeps the first backup, the user's file");
    assert.equal((await run(home, ["uninstall"])).code, 0);
    assert.ok(existsSync(mcpPath), "not deleted");
    assert.equal(readFileSync(mcpPath, "utf8"), "");
    if (platform() !== "win32")
        assert.ok(existsSync(join(home, ".gemini", "antigravity", "mcp_config.json")), "the app's link still resolves");
});
test("install twice over a `{}` config of the user's: uninstall leaves `{}` with its formatting", async () => {
    const home = antigravityHome();
    const mcpPath = join(home, ".gemini", "config", "mcp_config.json");
    writeFileSync(mcpPath, "{}\n");
    assert.equal((await run(home, ["install"])).code, 0);
    assert.equal((await run(home, ["install"])).code, 0);
    assert.equal((await run(home, ["uninstall"])).code, 0);
    assert.equal(readFileSync(mcpPath, "utf8"), "{}\n");
});
test("uninstall keeps a config's indentation and trailing newline", async () => {
    const home = antigravityHome();
    const mcpPath = join(home, ".gemini", "config", "mcp_config.json");
    const mine = JSON.stringify({ mcpServers: { mine: { command: "my-server" } } }, null, 4) + "\n";
    writeFileSync(mcpPath, mine);
    assert.equal((await run(home, ["install"])).code, 0);
    assert.match(readFileSync(mcpPath, "utf8"), /^\{\n {4}"mcpServers"[\s\S]*\}\n$/, "install writes it the same way");
    assert.equal((await run(home, ["uninstall"])).code, 0);
    assert.equal(readFileSync(mcpPath, "utf8"), mine);
});
test("a CLI-only Antigravity: the config folder install made goes with uninstall", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-agy-cli-"));
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    assert.equal((await run(home, ["install"])).code, 0);
    assert.ok(JSON.parse(readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8")).mcpServers["context-doctor"], "the CLI reads the shared file");
    assert.ok(existsSync(join(home, ".gemini", "antigravity-cli", "skills", "context-doctor", "SKILL.md")));
    assert.equal((await run(home, ["uninstall"])).code, 0);
    assert.ok(!existsSync(join(home, ".gemini", "config")), "no empty ~/.gemini/config left behind");
    assert.ok(!existsSync(join(home, ".gemini", "antigravity-cli", "skills")));
    assert.ok(existsSync(join(home, ".gemini", "antigravity-cli")));
});
