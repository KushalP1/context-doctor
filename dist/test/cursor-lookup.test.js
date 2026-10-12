/**
 * `context-doctor cursor`: the chat profiled is the one named, and a machine
 * with no SQLite at all is told so.
 *
 * Builds a Cursor database in a sandboxed home, where this platform looks for
 * it. Skipped when this runtime has no node:sqlite to build it with.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "./sandbox.js";
const require = createRequire(import.meta.url);
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
let DatabaseSync;
try {
    ({ DatabaseSync } = require("node:sqlite"));
}
catch {
    DatabaseSync = undefined;
}
const skip = DatabaseSync ? false : "no node:sqlite on this runtime";
/** A home whose Cursor history holds 25 chats; chatN has N+2 messages, so chat0 is the smallest. */
function cursorHome() {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-cursorid-"));
    const storage = platform() === "darwin"
        ? join(home, "Library", "Application Support", "Cursor", "User", "globalStorage")
        : platform() === "win32"
            ? join(home, "AppData", "Roaming", "Cursor", "User", "globalStorage")
            : join(home, ".config", "Cursor", "User", "globalStorage");
    mkdirSync(storage, { recursive: true });
    const db = new DatabaseSync(join(storage, "state.vscdb"));
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    const insert = db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)");
    for (let i = 0; i < 25; i++) {
        const headers = Array.from({ length: i + 2 }, (_, j) => ({ bubbleId: `b${j}`, type: j % 2 ? 2 : 1 }));
        insert.run(`composerData:chat${i}`, JSON.stringify({ name: `Chat ${i}`, fullConversationHeadersOnly: headers }));
        for (let j = 0; j < i + 2; j++)
            insert.run(`bubbleId:chat${i}:b${j}`, JSON.stringify({ type: j % 2 ? 2 : 1, text: `message ${j} of chat ${i}` }));
    }
    db.close();
    return home;
}
function run(argv, env) {
    return new Promise((resolve) => {
        execFile(process.execPath, argv, { env, timeout: 30_000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
    });
}
test("cursor <id> profiles that chat even outside the 20 largest, and an unknown id fails", { skip }, async () => {
    const home = cursorHome();
    const small = await run([cliPath, "cursor", "chat0"], sandboxEnv(home));
    assert.equal(small.code, 0, small.stderr);
    assert.match(small.stdout, /Id:\s+chat0\b/, "the smallest chat, not the biggest one");
    const missing = await run([cliPath, "cursor", "no-such-id"], sandboxEnv(home));
    assert.equal(missing.code, 1, "a wrong id must not profile some other chat with exit 0");
    assert.match(missing.stderr, /No Cursor chat with id "no-such-id"/);
    assert.doesNotMatch(missing.stdout, /Cursor chat:/);
});
/** Whether `--no-experimental-sqlite` takes node:sqlite away on this runtime (22.13+). */
function canDisableNodeSqlite() {
    const probe = spawnSync(process.execPath, ["--no-experimental-sqlite", "-e", "require('node:sqlite')"], { encoding: "utf8" });
    return probe.status !== 0 && /No such built-in module/.test(probe.stderr);
}
test("with no SQLite backend at all, cursor says so instead of 'No Cursor chats found'", { skip: skip || (!canDisableNodeSqlite() && "cannot switch node:sqlite off here") }, async () => {
    const home = cursorHome();
    // No node:sqlite (flag) and no sqlite3 on PATH: the Node 20 situation.
    const env = sandboxEnv(home);
    for (const key of Object.keys(env))
        if (/^path$/i.test(key))
            delete env[key];
    env.PATH = mkdtempSync(join(tmpdir(), "ctxdoc-nobin-"));
    const r = await run(["--no-experimental-sqlite", cliPath, "cursor", "--list"], env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /needs SQLite/, "the real cause, so the user knows what to install");
    assert.doesNotMatch(r.stderr, /No Cursor chats found/, "the chats exist; SQLite does not");
});
