/**
 * Programs run by bare name (git, pdftotext, unzip, sqlite3…) run from the
 * temp folder, never from the folder being read.
 *
 * On Windows a bare name is found in the child's working folder before PATH:
 * `pack .` in a cloned repository, the MCP server's pack_context (its
 * working folder is the project its client opened) and `ci` in a pull
 * request's checkout ran a git.exe committed there. That lookup cannot be
 * staged on macOS or Linux, so these tests check what prevents it on every
 * OS: the working folder each program is started in, recorded by a stand-in
 * on PATH. (A stand-in cannot be a script on Windows, which spawns only
 * executables by bare name: skipped there.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "./sandbox.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const skip = platform() === "win32" && "a stand-in on PATH must be an executable on Windows";
/** A folder of stand-ins that log their working folder, then run the real program (git) or print text. */
function standIns() {
    const bin = mkdtempSync(join(tmpdir(), "cd-toolcwd-bin-"));
    const log = join(bin, "cwd.log");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const write = (name, body) => {
        writeFileSync(join(bin, name), `#!/bin/sh\npwd -P >> "${log}"\n${body}\n`);
        chmodSync(join(bin, name), 0o755);
    };
    write("git", `exec "${realGit}" "$@"`);
    write("pdftotext", 'echo "text of the document"');
    return { bin, log };
}
function run(cwd, bin, args) {
    const home = mkdtempSync(join(tmpdir(), "cd-toolcwd-home-"));
    const env = { ...sandboxEnv(home), PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
    const r = spawnSync(process.execPath, [cliPath, ...args], { cwd, env, encoding: "utf8", timeout: 60_000 });
    return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}
function project() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "cd-toolcwd-proj-")));
    const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    writeFileSync(join(dir, "CLAUDE.md"), "# Project\n\nRun the tests before you push.\n");
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "guide.pdf"), "%PDF-1.4 stand-in\n");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
    return dir;
}
const cwds = (log) => readFileSync(log, "utf8").split("\n").filter(Boolean);
test("pack runs git and the PDF converter from the temp folder, not from the folder it reads", { skip }, () => {
    const dir = project();
    const { bin, log } = standIns();
    const r = run(dir, bin, ["pack", ".", "-q", "document"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /text of the document/, "the stand-in converter was used");
    const seen = cwds(log);
    assert.ok(seen.length >= 2, `git and pdftotext both ran: ${seen.join(", ")}`);
    assert.deepEqual(seen.filter((c) => c.startsWith(dir)), [], `run inside the project: ${seen.join(", ")}`);
});
test("ci runs git from the temp folder, with the repository named by -C", { skip }, () => {
    const dir = project();
    const { bin, log } = standIns();
    const r = run(dir, bin, ["ci", "--json"]);
    assert.equal(r.code, 0, r.out);
    assert.ok(JSON.parse(r.out).headTotal > 0, "the repository's CLAUDE.md was still found and measured");
    const seen = cwds(log);
    assert.ok(seen.length > 0);
    assert.deepEqual(seen.filter((c) => c.startsWith(dir)), [], `run inside the repository: ${seen.join(", ")}`);
});
