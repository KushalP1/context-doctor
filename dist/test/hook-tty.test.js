/**
 * `hook` and `statusline` read JSON that Claude Code pipes in. Typed in a
 * terminal they waited for stdin forever; they now say what they are for
 * and exit 0. The terminal is a real pseudo-terminal (Python's pty), where
 * one is available.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "./sandbox.js";
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const home = mkdtempSync(join(tmpdir(), "ctxdoc-tty-"));
const hasPty = platform() !== "win32" && spawnSync("python3", ["-c", "import pty"], { stdio: "ignore", timeout: 10_000 }).status === 0;
/** Run the CLI with its stdin (and stdout) on a pseudo-terminal. */
function inTerminal(...args) {
    return spawnSync("python3", ["-c", "import os, pty, sys; status = pty.spawn(sys.argv[1:]); sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else status >> 8)", process.execPath, cli, ...args], { encoding: "utf8", input: "", timeout: 15_000, env: sandboxEnv(home) });
}
for (const cmd of ["hook", "statusline"]) {
    test(`${cmd} in a terminal explains itself and exits 0 instead of waiting`, { skip: !hasPty && "needs python3's pty module" }, () => {
        const r = inTerminal(cmd);
        assert.equal(r.error, undefined, "it must not hang until the timeout");
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, new RegExp(`${cmd} is called by Claude Code with JSON on stdin`));
    });
}
test("with JSON piped in, as Claude Code runs them, nothing changes", () => {
    const r = spawnSync(process.execPath, [cli, "statusline"], { input: JSON.stringify({ model: { id: "claude-sonnet-5" } }), encoding: "utf8", timeout: 15_000, env: sandboxEnv(home) });
    assert.equal(r.status, 0);
    assert.ok(!/called by Claude Code/.test(r.stdout));
    const h = spawnSync(process.execPath, [cli, "hook"], { input: "{}", encoding: "utf8", timeout: 15_000, env: sandboxEnv(home) });
    assert.equal(h.status, 0);
    assert.ok(!/called by Claude Code/.test(h.stdout));
});
