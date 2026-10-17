/**
 * uninstall takes out what install put in, and says what it did: files
 * install created are deleted once they hold nothing (not left as
 * {"mcpServers":{}}), containers it added go, the user's own content and
 * the backups of their originals stay (and are listed), and a machine with
 * nothing installed is told so instead of a bare "Done.".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "./sandbox.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
function run(home, args) {
    return new Promise((resolve) => {
        execFile(process.execPath, [cliPath, ...args], { env: sandboxEnv(home), timeout: 30_000 }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, out: stdout, err: stderr }));
    });
}
const json = (p) => JSON.parse(readFileSync(p, "utf8"));
function apps() {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-unin-"));
    for (const d of [".claude", ".cursor", ".codex"])
        mkdirSync(join(home, d), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }));
    return home;
}
test("nothing installed: says so, not a bare Done.", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-unin-none-"));
    const r = await run(home, ["uninstall"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), "Nothing of context-doctor's was installed.");
});
test("files install created are deleted once empty; the user's file loses only what install added", async () => {
    const home = apps();
    assert.equal((await run(home, ["install", "--statusline"])).code, 0);
    const r = await run(home, ["uninstall"]);
    assert.equal(r.code, 0, r.err);
    for (const f of [".claude.json", ".cursor/mcp.json", ".cursor/hooks.json", ".codex/config.toml", ".codex/hooks.json"]) {
        assert.ok(!existsSync(join(home, f)), `${f}: install created it and it holds nothing now`);
    }
    assert.match(r.out.replace(/\\/g, "/"), /Deleted files install had created, now empty: .*~\/\.cursor\/mcp\.json/);
    assert.deepEqual(json(join(home, ".claude", "settings.json")), { theme: "dark" }, "no hooks: {} left behind");
    // The backup of the original is kept, untouched, and named.
    const backup = join(home, ".claude", "settings.json.context-doctor.backup");
    assert.deepEqual(json(backup), { theme: "dark" });
    assert.match(r.out.replace(/\\/g, "/"), /Backups install made of your configs.*kept:\n {2}~\/\.claude\/settings\.json\.context-doctor\.backup/);
    assert.match(r.out, /Done\./);
    assert.ok(!existsSync(join(home, ".claude", "skills", "context-doctor")));
});
test("install run twice: the second backup holds our own write, and the file is still recognised as ours", async () => {
    const home = apps();
    await run(home, ["install"]);
    await run(home, ["install"]);
    assert.ok(existsSync(join(home, ".cursor", "mcp.json.context-doctor.backup")), "fixture: the second run backed up our own file");
    await run(home, ["uninstall"]);
    assert.ok(!existsSync(join(home, ".cursor", "mcp.json")));
});
test("a config that existed before install keeps its shape, empty containers included", async () => {
    const home = apps();
    writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: {} }));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ numStartups: 3 }));
    await run(home, ["install"]);
    const r = await run(home, ["uninstall"]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(json(join(home, ".cursor", "mcp.json")), { mcpServers: {} }, "the user's own (empty) file stays");
    assert.deepEqual(json(join(home, ".claude.json")), { numStartups: 3 }, "mcpServers was ours to remove");
});
test("only the SKILL.md install copied is removed from the skill folder", async () => {
    const home = apps();
    await run(home, ["install"]);
    const mine = join(home, ".claude", "skills", "context-doctor", "notes.md");
    writeFileSync(mine, "my notes");
    await run(home, ["uninstall"]);
    assert.ok(!existsSync(join(home, ".claude", "skills", "context-doctor", "SKILL.md")));
    assert.ok(existsSync(mine), "a file the user put there is theirs");
});
