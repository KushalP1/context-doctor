/**
 * A bare `context-doctor` with nothing to measure (or piped) printed the
 * full 150-line reference. It now prints where to begin; --help prints the
 * reference, grouped by what the commands are for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "./sandbox.js";
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const home = mkdtempSync(join(tmpdir(), "ctxdoc-start-"));
const env = { ...sandboxEnv(home), PATH: dirname(process.execPath) };
delete env.npm_command;
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env });
test("bare, with no history and no terminal: a short Start here screen, not the full help", () => {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^context-doctor: see where your Claude Code tokens go/);
    assert.match(r.stdout, /\/plugin install context-doctor@context-doctor/);
    assert.match(r.stdout, /\/context-doctor:savings/);
    for (const cmd of ["install", "savings", "doctor"])
        assert.match(r.stdout, new RegExp(`context-doctor ${cmd} `));
    assert.match(r.stdout, /github\.com\/KushalP1\/context-doctor#readme/);
    assert.match(r.stdout, /All commands: context-doctor --help/);
    assert.ok(r.stdout.split("\n").length <= 20, "short");
    assert.ok(!/--upstream-anthropic|Options:/.test(r.stdout), "not the reference");
});
test("--help is grouped: Start here, Measure, Fix automatically, Fix on request, Integrations, Internal", () => {
    const h = run("--help").stdout;
    const headers = ["Start here:", "Measure:", "Fix automatically:", "Fix on request:", "Integrations:", "Internal"];
    let at = -1;
    for (const header of headers) {
        const i = h.indexOf(`\n${header}`);
        assert.ok(i > at, `${header} in order`);
        at = i;
    }
    const internal = h.slice(h.indexOf("\nInternal"), h.indexOf("\nProject config"));
    for (const cmd of ["hook", "statusline", "mcp"])
        assert.match(internal, new RegExp(`context-doctor ${cmd}\\b`));
    const start = h.slice(h.indexOf("\nStart here:"), h.indexOf("\nMeasure:"));
    for (const cmd of ["install", "savings", "doctor"])
        assert.match(start, new RegExp(`context-doctor ${cmd}\\b`));
    assert.ok(!/\nUsage:\n/.test(h), "the groups replace the one Usage list");
});
