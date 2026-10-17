/**
 * Arguments are parsed strictly: a mistyped option used to be taken as a
 * positional (or silently ignored) and the command ran with defaults, a
 * mistyped --strategy ran nothing, and `<command> --help` printed all 200
 * lines of help.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandHelp, documentedCommands, levenshtein, suggest } from "../clihelp.js";
import { sandboxEnv } from "./sandbox.js";
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const home = mkdtempSync(join(tmpdir(), "ctxdoc-args-"));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: sandboxEnv(home), cwd: home });
test("levenshtein and suggest", () => {
    assert.equal(levenshtein("kitten", "sitting"), 3);
    assert.equal(levenshtein("", "abc"), 3);
    assert.equal(suggest("--dayz", ["--days", "--json"]), "--days");
    assert.equal(suggest("--strat", ["--strategy", "--json"]), "--strategy", "a prefix counts");
    assert.equal(suggest("--completely-different", ["--days", "--json"]), undefined);
});
test("an unknown option is an error naming it, with a suggestion", () => {
    const r = run("savings", "--dayz", "7");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown option --dayz\. Did you mean --days\?/);
    const r2 = run("--jsn");
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /Unknown option --jsn\. Did you mean --json\?/);
});
test("an option that needs a value gets none, or gets another option: error", () => {
    let r = run("analyze", "x.json", "--model");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--model needs a value; got nothing/);
    r = run("analyze", "x.json", "--model", "--json");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--model needs a value; got the option --json/);
    r = run("savings", "--days", "--json");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--days needs a value; got the option --json/);
    r = run("savings", "--json=yes");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--json takes no value/);
});
test("--flag=value is accepted, so a value may start with a dash", () => {
    const doc = join(home, "doc.md");
    writeFileSync(doc, "# Rotate\n\nRotate keys with keyctl.\n");
    const r = run("pack", doc, "--query=-rotate keys", "--max-tokens=500");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^PACKED/);
});
test("--strategy is checked against the optimizer's strategies", () => {
    const r = run("optimize", "x.json", "--strategy", "dedup");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--strategy "dedup" is not a strategy\. Did you mean dedupe\?/);
    assert.match(r.stderr, /Available: .*trim-tool-results/);
});
test("unknown commands get a suggestion; help and version are commands", () => {
    const r = run("sesion");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown command "sesion"\. Did you mean session\?/);
    const v = run("version");
    assert.equal(v.status, 0);
    assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+/);
    const h = run("help");
    assert.equal(h.status, 0);
    assert.match(h.stdout, /context-doctor savings/);
    assert.match(h.stdout, /context-doctor analyze/);
});
test("<command> --help prints that command's help, not everything", () => {
    const r = run("savings", "--help");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Usage:\n {2}context-doctor savings/);
    assert.match(r.stdout, /--days <n>/, "its options");
    assert.ok(!/context-doctor analyze/.test(r.stdout), "not other commands");
    assert.equal(run("help", "savings").stdout, r.stdout, "help <command> is the same");
    assert.equal(run("-h", "savings").stdout, r.stdout, "the flag may come first");
    const o = run("overhead", "--help").stdout;
    assert.match(o, /context-doctor overhead split/, "both overhead forms");
    assert.match(o, /--min-tokens/);
});
test("every documented command has its own help", () => {
    const full = run("--help").stdout;
    const commands = documentedCommands(full);
    assert.ok(commands.length >= 25, commands.join(","));
    for (const c of commands) {
        const text = commandHelp(full, c);
        assert.ok(text?.startsWith("Usage:"), c);
        const r = run(c, "--help");
        assert.equal(r.status, 0, `${c} --help: ${r.stderr}`);
        assert.match(r.stdout, new RegExp(`context-doctor ${c}\\b`), c);
    }
});
test("analyze with no file says what is missing", () => {
    const r = run("analyze");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /analyze needs a conversation file/);
    assert.match(r.stderr, /context-doctor analyze/);
});
