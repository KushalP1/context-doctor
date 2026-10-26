/**
 * Handoffs, the module: validation and bounds, secret masking, storage under
 * the (sandboxed) home directory, ids that never become paths, rotation, the
 * token math, and the read-only CLI. The MCP surfaces (prompt, tool,
 * resources, elicitation) are in handoff-mcp.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HANDOFF_LIMITS, handoffDir, handoffMath, isHandoffId, listHandoffs, maskSecrets, readHandoff, renderHandoffList,
  renderHandoffMarkdown, renderMath, saveHandoff, slugify, validateHandoff,
} from "../handoff.js";
import { exchangeTokens } from "../sketch.js";
import { sandboxEnv, withSandboxHome } from "./sandbox.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const tmpHome = () => mkdtempSync(join(tmpdir(), "cd-handoff-"));
// Fake credentials are assembled at run time, so no literal in this file looks
// like a real key to a secret scanner (GitHub push protection blocks them).
const fake = (...parts: string[]) => parts.join("");
const BRIEF = "Goal: ship the billing fix.\nDecided: keep the v2 schema.\nState: tests pass locally.\nOpen: deploy, notify ops.\nIds: PR #412, table invoices_v2.";

test("validate: empty brief, oversize brief, too many or oversize blocks, bad numbers are refused with a reason", () => {
  assert.deepEqual(validateHandoff({ brief: BRIEF }), []);
  assert.match(validateHandoff({ brief: "  " }).join(" "), /brief.*empty/);
  assert.match(validateHandoff({ brief: "x".repeat(HANDOFF_LIMITS.briefChars + 1) }).join(" "), /limit is 6000/);
  const many = Array.from({ length: HANDOFF_LIMITS.blocks + 1 }, (_, i) => ({ label: `b${i}`, text: "x" }));
  assert.match(validateHandoff({ brief: BRIEF, verbatim: many }).join(" "), /21 verbatim blocks/);
  assert.match(validateHandoff({ brief: BRIEF, verbatim: [{ label: "big", text: "x".repeat(HANDOFF_LIMITS.blockChars + 1) }] }).join(" "), /"big".*limit is 20000/);
  assert.match(validateHandoff({ brief: BRIEF, verbatim: [{ label: "", text: "x" }] }).join(" "), /label/);
  assert.match(validateHandoff({ brief: BRIEF, verbatim: [{ label: "l", text: "" }] }).join(" "), /text is empty/);
  const three = Array.from({ length: 4 }, (_, i) => ({ label: `b${i}`, text: "y".repeat(HANDOFF_LIMITS.blockChars) }));
  assert.match(validateHandoff({ brief: BRIEF, verbatim: three }).join(" "), /not a cut/);
  assert.match(validateHandoff({ brief: BRIEF, chatTokens: -1 }).join(" "), /chatTokens/);
  assert.match(validateHandoff({ brief: BRIEF, turns: Number.NaN }).join(" "), /turns/);
  assert.match(validateHandoff({ brief: BRIEF, title: "t".repeat(81) }).join(" "), /title/);
  assert.throws(() => saveHandoff({ brief: "" }, { home: tmpHome() }), /empty/);
});

test("secrets: provider keys, private keys and password assignments are masked; env references and prose are not", () => {
  const text = [
    "export OPENAI_API_KEY=" + fake("sk-", "proj-", "AbCdEf0123456789AbCdEf0123456789"),
    "anthropic: " + fake("sk-", "ant-", "api03-", "Z".repeat(24)),
    "aws " + fake("AKIA", "IOSFODNN7EXAMPLE"),
    "token " + fake("ghp", "_", "a".repeat(36)),
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
    'password: "hunter2hunter2X"',
    "apiKey = process.env.API_KEY",
    "the password field is required",
  ].join("\n");
  const m = maskSecrets(text);
  assert.equal(m.count, 6, m.text);
  for (const secret of [fake("sk-", "proj-AbCdEf"), fake("sk-", "ant-api03"), fake("AKIA", "IOSFODNN7EXAMPLE"), fake("ghp", "_aaaa"), "b3BlbnNzaC1rZXktdjEAAAAA", "hunter2hunter2X"]) {
    assert.ok(!m.text.includes(secret), `${secret} survived`);
  }
  assert.match(m.text, /apiKey = process\.env\.API_KEY/);
  assert.match(m.text, /the password field is required/);
  assert.ok(m.kinds.includes("a private key") && m.kinds.includes("an OpenAI key"));
});

test("save: one folder per handoff under ~/.context-doctor/handoffs, private files, nothing outside", () => {
  const home = tmpHome();
  const now = new Date("2026-10-26T12:15:30Z");
  const s = saveHandoff({ brief: BRIEF, title: "Billing fix / v2!", verbatim: [{ label: "the migration", text: "ALTER TABLE invoices_v2 ADD x int;\n```\nnested fence\n```" }], model: "claude-sonnet-5", turns: 40 }, { home, now });
  assert.equal(s.meta.id, "20261026-121530-billing-fix-v2");
  assert.ok(isHandoffId(s.meta.id));
  assert.equal(s.dir, join(handoffDir(home), s.meta.id));
  assert.deepEqual(readdirSync(s.dir!).sort(), ["handoff.md", "meta.json"]);
  assert.deepEqual(readdirSync(home), [".context-doctor"], "nothing else is written in the home directory");
  if (process.platform !== "win32") {
    assert.equal(statSync(join(s.dir!, "handoff.md")).mode & 0o777, 0o600);
    assert.equal(statSync(s.dir!).mode & 0o777, 0o700);
  }
  const md = readFileSync(join(s.dir!, "handoff.md"), "utf8");
  assert.match(md, /^# Handoff: Billing fix \/ v2!/);
  assert.match(md, /Decided: keep the v2 schema/);
  // The block holds a ``` fence, so the handoff fences it with four.
  assert.match(md, /\n````\nALTER TABLE[\s\S]*nested fence\n```\n````\n/);
  assert.equal(s.meta.blocks.length, 1);
  assert.ok(s.meta.tokens > s.meta.briefTokens);
  assert.equal(s.math.nowSource, "turns");
  assert.equal(s.math.now, 40 * exchangeTokens("claude-sonnet-5"));

  // A second save in the same second gets its own folder; nothing is overwritten.
  const again = saveHandoff({ brief: BRIEF, title: "Billing fix / v2!" }, { home, now });
  assert.equal(again.meta.id, "20261026-121530-billing-fix-v2-2");
  assert.equal(readFileSync(join(s.dir!, "handoff.md"), "utf8"), md);

  // Untitled: the brief's first line names it.
  const untitled = saveHandoff({ brief: BRIEF }, { home, now: new Date("2026-10-26T12:16:00Z") });
  assert.equal(untitled.meta.title, "Goal: ship the billing fix.");
  assert.equal(listHandoffs(home)[0].id, untitled.meta.id, "newest first");
});

test("save: secrets are masked before anything is written, and the result says how many", () => {
  const home = tmpHome();
  const s = saveHandoff({ brief: `${BRIEF}\nKey: ${fake("sk-", "ant-", "api03-", "SECRET".repeat(4))}`, verbatim: [{ label: "env", text: `STRIPE=${fake("sk", "_live_", "abcdefghijklmnopqrstuvwx")}` }] }, { home });
  assert.equal(s.meta.masked, 2);
  assert.deepEqual(s.maskedKinds.sort(), ["a Stripe key", "an Anthropic key"]);
  const onDisk = readFileSync(join(s.dir!, "handoff.md"), "utf8") + readFileSync(join(s.dir!, "meta.json"), "utf8");
  assert.ok(!onDisk.includes("SECRETSECRET") && !onDisk.includes(fake("sk", "_live_abc")));
  assert.match(onDisk, /masked by context-doctor/);
});

test("store: false builds the handoff and writes nothing (the HTTP server's default)", () => {
  const home = tmpHome();
  const s = saveHandoff({ brief: BRIEF }, { home, store: false });
  assert.equal(s.dir, undefined);
  assert.match(s.markdown, /Continue from this handoff/);
  assert.equal(existsSync(join(home, ".context-doctor")), false);
});

test("read: only well-formed ids of saved handoffs; no path, traversal or symlink reaches the filesystem", () => {
  const home = tmpHome();
  const s = saveHandoff({ brief: BRIEF, title: "one" }, { home });
  assert.equal(readHandoff(s.meta.id, home)?.meta.id, s.meta.id);
  assert.equal(readHandoff("latest", home)?.meta.id, s.meta.id);
  for (const bad of ["../../etc/passwd", "..", `${s.meta.id}/../${s.meta.id}`, `/${s.meta.id}`, `${s.meta.id}%2F..`, "C:\\Windows", "20261026-121530-ONE", "", "latest/.."]) {
    assert.equal(readHandoff(bad, home), undefined, `read ${JSON.stringify(bad)}`);
    assert.equal(isHandoffId(bad), false);
  }
  // A folder named like a handoff but without our meta is not one.
  mkdirSync(join(handoffDir(home), "20200101-000000-stray"));
  writeFileSync(join(handoffDir(home), "20200101-000000-stray", "handoff.md"), "not ours");
  assert.equal(readHandoff("20200101-000000-stray", home), undefined);
  assert.deepEqual(listHandoffs(home).map((m) => m.id), [s.meta.id]);
  if (process.platform !== "win32") {
    // A handoff.md replaced by a link to another file is not read through.
    const outside = join(home, "outside.txt");
    writeFileSync(outside, "SECRET OUTSIDE");
    const linked = saveHandoff({ brief: BRIEF, title: "linked" }, { home, now: new Date(Date.now() + 5000) });
    const file = join(linked.dir!, "handoff.md");
    unlinkSync(file);
    symlinkSync(outside, file);
    assert.equal(readHandoff(linked.meta.id, home), undefined);
  }
});

test("rotation keeps the newest 100 and removes only folders that are ours", () => {
  const home = tmpHome();
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  for (let i = 0; i < HANDOFF_LIMITS.kept + 2; i++) saveHandoff({ brief: `brief ${i}`, title: `h${i}` }, { home, now: new Date(t0 + i * 1000) });
  const ids = listHandoffs(home).map((m) => m.id);
  assert.equal(ids.length, HANDOFF_LIMITS.kept);
  assert.ok(ids.includes("20260101-000141-h101") && !ids.includes("20260101-000000-h0") && !ids.includes("20260101-000001-h1"));
  // Something else in the folder is left alone.
  writeFileSync(join(handoffDir(home), "notes.txt"), "mine");
  saveHandoff({ brief: "one more" }, { home, now: new Date(t0 + 999_000) });
  assert.ok(existsSync(join(handoffDir(home), "notes.txt")));
});

test("math: per-turn cost now vs after, from a given size, from turns, or a hint when unknown", () => {
  const given = handoffMath(600, { chatTokens: 48_000, model: "claude-sonnet-5" });
  assert.equal(given.now, 48_000);
  assert.ok(given.nowUsd! > given.afterUsd! && given.nowCachedUsd! < given.nowUsd!);
  const text = renderMath(given);
  assert.match(text, /Now: ~48k tokens re-read on every turn \(\$/);
  assert.match(text, /After: ~600 in a new chat/);
  assert.match(text, /Saves ~47k tokens per further turn \(99%\)/);
  assert.match(renderMath(handoffMath(600, { turns: 30 })), /estimated from the turn count/);
  assert.match(renderMath(handoffMath(600, {})), /Pass chat_tokens/);
  assert.doesNotMatch(renderMath(handoffMath(600, { chatTokens: 1000 })), /\$|NaN/, "no price without a known model");
});

test("slugs and markdown stay tame", () => {
  assert.equal(slugify("Ünïcode — title: with/slashes"), "unicode-title-with-slashes");
  assert.equal(slugify("!!!"), "handoff");
  assert.ok(slugify("x".repeat(100)).length <= 40);
  const md = renderHandoffMarkdown("t", "2026-10-26T12:00:00.000Z", "brief", []);
  assert.doesNotMatch(md, /Verbatim/);
});

test("the default location follows the sandboxed home (HOME and USERPROFILE)", async () => {
  const home = tmpHome();
  await withSandboxHome(home, () => {
    assert.equal(homedir(), home);
    assert.equal(handoffDir(), join(home, ".context-doctor", "handoffs"));
    const s = saveHandoff({ brief: BRIEF });
    assert.ok(s.dir!.startsWith(home));
  });
});

test("cli: handoff list, latest, show <id>, --json; unknown ids and bad subcommands exit 1", () => {
  const home = tmpHome();
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, "handoff", ...args], { env: sandboxEnv(home), encoding: "utf8" });
  const empty = run();
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /No handoffs saved yet/);
  assert.equal(run("latest").status, 1);

  const s = saveHandoff({ brief: BRIEF, title: "cli check" }, { home });
  const list = run("list");
  assert.match(list.stdout, new RegExp(s.meta.id));
  assert.match(list.stdout, /cli check/);
  assert.equal(run("latest").stdout, s.markdown);
  assert.equal(run("show", s.meta.id).stdout, s.markdown);
  assert.equal(run(s.meta.id).stdout, s.markdown, "an id alone shows it");
  assert.equal(JSON.parse(run("list", "--json").stdout)[0].id, s.meta.id);
  assert.equal(JSON.parse(run("latest", "--json").stdout).markdown, s.markdown);
  const missing = run("show", "20990101-000000-nope");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No saved handoff/);
  assert.equal(run("show", "../../etc/passwd").status, 1);
  assert.equal(run("show").status, 1);
  assert.equal(run("frobnicate").status, 1);
  assert.match(renderHandoffList(listHandoffs(home), home), /newest 100 are kept/);
});
