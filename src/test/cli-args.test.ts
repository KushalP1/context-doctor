/**
 * Arguments are parsed strictly: a mistyped option used to be taken as a
 * positional (or silently ignored) and the command ran with defaults, a
 * mistyped --strategy ran nothing, and `<command> --help` printed all 200
 * lines of help.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandHelp, documentedCommands, levenshtein, suggest } from "../clihelp.js";
import { sandboxEnv } from "./sandbox.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const home = mkdtempSync(join(tmpdir(), "ctxdoc-args-"));
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: sandboxEnv(home), cwd: home });

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

test("--json is JSON or an error: never a text report a script then fails to parse", () => {
  // These printed their text report with exit 0.
  for (const args of [["report"], ["autopilot", "status"], ["doctor"], ["instructions"], ["diff", "a", "b"]]) {
    const r = run(...args, "--json");
    assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}`);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, new RegExp(`${args[0]} has no --json output\\. Commands with one: .*spend`));
  }
  // These printed text lists under --json.
  const s = run("session", "--list", "--json");
  assert.equal(s.status, 0, s.stderr);
  assert.deepEqual(JSON.parse(s.stdout), []);
  const c = run("compact-window", "--json");
  assert.equal(c.status, 0, c.stderr);
  const cw = JSON.parse(c.stdout);
  assert.equal(cw.sessions, 0);
  assert.equal(cw.current, null);
  const off = run("budget", "off", "--json");
  assert.equal(off.status, 0, off.stderr);
  assert.equal(JSON.parse(off.stdout), null, "no budget now, as `budget --json` says it");
  // And --days is a whole number of days ("Last 1.5 days" was printed).
  const d = run("spend", "--days", "1.5");
  assert.equal(d.status, 1);
  assert.match(d.stderr, /--days needs a whole number of at least 1; got "1\.5"/);
  // And each command's help says whether it has --json.
  assert.match(run("spend", "--help").stdout, /--json {18}\(analyze, /);
  assert.match(run("fix", "--help").stdout, /--days <n>/, "fix reads --days");
  assert.ok(!/--json/.test(run("doctor", "--help").stdout));
});

test("budget --json says how many of the period's requests had no known price", () => {
  const h = mkdtempSync(join(tmpdir(), "ctxdoc-budget-json-"));
  const project = join(h, ".claude", "projects", "-work");
  mkdirSync(project, { recursive: true });
  const row = (id: string, model: string) => JSON.stringify({
    type: "assistant", timestamp: new Date().toISOString(), sessionId: "s1", cwd: "/work",
    message: { id, role: "assistant", model, content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
  writeFileSync(join(project, "s1.jsonl"), [row("m1", "claude-sonnet-5"), row("m2", "some-local-model")].join("\n") + "\n");
  const go = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: sandboxEnv(h), cwd: h });
  assert.equal(go("budget", "50/day").status, 0);
  const r = go("budget", "--json");
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.ok(j.spent > 0, r.stdout);
  assert.deepEqual(j.unpriced, { requests: 1, models: ["some-local-model"] });
});

test("analyze with no file says what is missing", () => {
  const r = run("analyze");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /analyze needs a conversation file/);
  assert.match(r.stderr, /context-doctor analyze/);
});
