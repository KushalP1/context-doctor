/**
 * `session` with no file profiles the session it runs in. It used to take
 * the newest transcript on the machine, so the plugin's checkup, run inside
 * one project, reported whichever other project had written last.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeProjectDir, pickCurrentSession } from "../session.js";
import { sandboxEnv, withSandboxHome } from "./sandbox.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
function transcript(path, title, ageSeconds) {
    mkdirSync(dirname(path), { recursive: true });
    const lines = [
        { type: "user", message: { role: "user", content: title }, timestamp: "2026-10-01T10:00:00Z" },
        { type: "assistant", message: { id: "m1", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "ok" }] }, timestamp: "2026-10-01T10:00:01Z" },
    ];
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const t = Date.now() / 1000 - ageSeconds;
    utimesSync(path, t, t);
}
function fixture() {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-pick-"));
    // process.cwd() in the child is the real path (/private/var/... on macOS).
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ctxdoc-pick-cwd-")));
    const here = claudeProjectDir(cwd, home);
    transcript(join(here, "aaaa-current.jsonl"), "current session prompt", 600);
    transcript(join(here, "bbbb-newer.jsonl"), "newer session in this folder", 300);
    transcript(join(home, ".claude", "projects", "-elsewhere", "cccc.jsonl"), "another project's session", 10);
    return { home, cwd, here };
}
function session(home, cwd, env, args = []) {
    const e = { ...sandboxEnv(home), ...env };
    if (!("CLAUDE_CODE_SESSION_ID" in env))
        delete e.CLAUDE_CODE_SESSION_ID;
    return new Promise((resolve) => {
        execFile(process.execPath, [cliPath, "session", ...args], { env: e, cwd, timeout: 30_000 }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, out: stdout, err: stderr }));
    });
}
test("CLAUDE_CODE_SESSION_ID picks that session's transcript, and says so", async () => {
    const { home, cwd, here } = fixture();
    const r = await session(home, cwd, { CLAUDE_CODE_SESSION_ID: "aaaa-current" });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /current session prompt/);
    assert.ok(r.out.includes(join(here, "aaaa-current.jsonl")));
    assert.match(r.out, /Picked:\s+the current Claude Code session \(CLAUDE_CODE_SESSION_ID aaaa-current\)/);
    const j = await session(home, cwd, { CLAUDE_CODE_SESSION_ID: "aaaa-current" }, ["--json"]);
    assert.match(JSON.parse(j.out).session.picked, /current Claude Code session/);
});
test("without it: the newest transcript of this folder's project, not the machine's newest", async () => {
    const { home, cwd } = fixture();
    const r = await session(home, cwd, {});
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /newer session in this folder/);
    assert.match(r.out, /Picked:\s+the newest Claude Code session in this folder's project/);
    // An id that has no transcript (yet) falls through to the folder.
    const r2 = await session(home, cwd, { CLAUDE_CODE_SESSION_ID: "no-such-session" });
    assert.match(r2.out, /newer session in this folder/);
});
test("a folder with no project falls back to the newest session on the machine", async () => {
    const { home } = fixture();
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "ctxdoc-pick-none-")));
    const r = await session(home, elsewhere, {});
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /another project's session/);
    assert.match(r.out, /Picked:\s+the newest session on this machine/);
    // A file named explicitly is never second-guessed.
    const named = await session(home, elsewhere, {}, [join(claudeProjectDir(elsewhere, home), "..", "-elsewhere", "cccc.jsonl")]);
    assert.ok(!/Picked:/.test(named.out));
});
test("pickCurrentSession returns undefined on a machine with no sessions", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-pick-empty-"));
    assert.equal(await withSandboxHome(home, () => pickCurrentSession({}, home, home)), undefined);
});
