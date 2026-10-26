/**
 * Handoffs, the module: validation and bounds, secret masking, storage under
 * the (sandboxed) home directory, ids that never become paths, rotation, the
 * token math, and the read-only CLI. The MCP surfaces (prompt, tool,
 * resources, elicitation) are in handoff-mcp.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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

test("secrets, the QA sample: every realistic shape is masked, and the benign look-alikes are not", () => {
  // Every value is synthetic and assembled here, so no literal in this file
  // reads as a credential to a secret scanner.
  const j = (...p: string[]) => p.join("");
  const secrets: Record<string, string> = {
    "AWS secret .env": j("AWS_SECRET_", "ACCESS_KEY=", "wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYEXAMPLEKEY"),
    "AWS secret yaml": j("aws_secret_", "access_key = ", "wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYEXAMPLEKEY"),
    "GitHub fine-grained": j("github", "_pat_", "11ABCDEFG0123456789_", "abcdefghijklmnopqrstuvwxyz"),
    "npm": j("npm", "_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"),
    "Stripe test": j("sk", "_test_", "51H8abcdEFGHijklMNOPqrstUVWX"),
    "Stripe webhook": j("wh", "sec_", "abcdEFGHijklMNOPqrstUVWXyz012345"),
    "OpenAI legacy": j("sk", "-", "abcdefghijklmnopqrstT3BlbkFJabcdefghijklmnopqrst"),
    "PGP key": j("-----BEGIN PGP ", "PRIVATE KEY BLOCK-----\nlQOYBF0abcdef\n-----END PGP ", "PRIVATE KEY BLOCK-----"),
    "GCP service account": j('"private_key": "-----BEGIN ', 'PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n-----END ', 'PRIVATE KEY-----\\n"'),
    "postgres URL": j("postgres://admin:", "S3cretPassw0rd", "@db.internal:5432/prod"),
    "https URL creds": j("https://deploy:", "ghtoken123456", "@git.example.com/repo.git"),
    "redis URL, no digits": j("redis://:", "supersecretpassword", "@cache:6379"),
    "password: hunter2": j("password: ", "hunter2"),
    "password, no digits": j('password = "', "correcthorsebatterystaple", '"'),
    "DB_PASSWORD": j("DB_PASS", "WORD=Tr0ub4dor&3xyz"),
    "Django SECRET_KEY": j("SECRET_KEY = '", "django-insecure-8h2k$1x9@q!z7w#e4r5t6y", "'"),
    "secret_key": j("secret_key: ", "abcd1234efgh5678ijkl"),
    "JSON password": j('{"password": "', "P@ssw0rd2024!", '"}'),
    "Bearer": j("Authorization: Bearer ", "8f3e2a1b9c7d6e5f4a3b2c1d0e9f8a7b"),
    "TOKEN=": j("TOKEN=", "8f3e2a1b9c7d6e5f4a3b2c1d0e9f8a7b"),
    "Slack webhook": j("https://hooks.slack", ".com/services/", "T00000000/B00000000/", "XXXXXXXXXXXXXXXXXXXXXXXX"),
    "Google API key": j("AI", "za", "SyA1234567890abcdefghijklmnopqrstu"),
    "Hugging Face": j("hf", "_", "abcdefghijklmnopqrstuvwxyzABCDEFGH"),
    "SendGrid": j("SG", ".", "abcdefghijklmnopqrstuv", ".", "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"),
    "Twilio": j("S", "K", "0123456789abcdef0123456789abcdef"),
    "Azure AccountKey": j("DefaultEndpointsProtocol=https;AccountName=acct;Account", "Key=", "abc123def456ghi789jkl012mno345pqr678stu901vwx234yz==", ";EndpointSuffix=core.windows.net"),
    "mysql -p": j("mysql -u root -p", "S3cr3tPass99", " prod"),
    "export OPENAI_API_KEY": j("export OPENAI_", "API_KEY=", "abc123def456ghi789"),
    "apiKey camelCase": j('apiKey: "', "AbC123dEf456GhI789", '"'),
  };
  for (const [name, text] of Object.entries(secrets)) {
    const m = maskSecrets(text);
    assert.ok(m.count >= 1, `${name} was not masked: ${m.text}`);
    assert.match(m.text, /masked by context-doctor/, name);
  }
  const benign: Record<string, string> = {
    "env reference": "api_key = process.env.OPENAI_API_KEY",
    "pwd path": "pwd: /home/runner/work/repo2024/app",
    "type annotation": "password: string; // min length 12, must contain digits",
    "CSS class": ".sk-spinner-wave-container-12345 { color: red }",
    "placeholder": "api_key: YOUR_API_KEY_HERE_123",
    "a call": "secret = getSecret(name1, version2)",
    "token counts": "max_tokens: 4000, token_count: 123456, input_tokens = 98765",
    "git sha": "commit 2aac93e4f1b5c6d7e8f90a1b2c3d4e5f60718293",
    "uuid": "id: 123e4567-e89b-12d3-a456-426614174000",
    "prose": "the password field is required; rotate the secret monthly",
  };
  for (const [name, text] of Object.entries(benign)) {
    const m = maskSecrets(text);
    assert.equal(m.count, 0, `${name} was masked: ${m.text}`);
    assert.equal(m.text, text);
  }
});

// -- Storage safety (QA findings 6-9 and 11) -----------------------------------

const posix = process.platform !== "win32";

test("a handoffs folder that is a link, or a ~/.context-doctor that is one, is refused; nothing outside home is touched", { skip: !posix && "directory symlinks need privileges on Windows" }, () => {
  const meta = (id: string) => JSON.stringify({ id, title: "x", created: "2000-01-01T00:00:00.000Z", tokens: 1, briefTokens: 1, blocks: [], masked: 0 });
  // handoffs -> elsewhere, with a victim that looks like one of ours
  const home = tmpHome();
  const elsewhere = tmpHome();
  mkdirSync(join(home, ".context-doctor"));
  symlinkSync(elsewhere, join(home, ".context-doctor", "handoffs"));
  mkdirSync(join(elsewhere, "20000101-000000-victim"));
  writeFileSync(join(elsewhere, "20000101-000000-victim", "meta.json"), meta("20000101-000000-victim"));
  writeFileSync(join(elsewhere, "20000101-000000-victim", "precious.txt"), "data");
  assert.throws(() => saveHandoff({ brief: BRIEF }, { home }), (e: Error) => /~\/\.context-doctor\/handoffs is a symbolic link/.test(e.message) && !e.message.includes(home));
  assert.deepEqual(listHandoffs(home), []);
  assert.equal(readHandoff("20000101-000000-victim", home), undefined);
  assert.ok(existsSync(join(elsewhere, "20000101-000000-victim", "precious.txt")));
  assert.deepEqual(readdirSync(elsewhere), ["20000101-000000-victim"]);
  // ~/.context-doctor -> elsewhere
  const home2 = tmpHome();
  const elsewhere2 = tmpHome();
  symlinkSync(elsewhere2, join(home2, ".context-doctor"));
  assert.throws(() => saveHandoff({ brief: BRIEF }, { home: home2 }), /~\/\.context-doctor is a symbolic link/);
  assert.deepEqual(readdirSync(elsewhere2), []);
});

test("rotation removes only real folders of ours: a link named like a handoff, a file, a folder without our meta all stay", { skip: !posix && "symlinks" }, () => {
  const meta = (id: string) => JSON.stringify({ id, title: "x", created: "2020-01-01T00:00:00.000Z", tokens: 1, briefTokens: 1, blocks: [], masked: 0 });
  const home = tmpHome();
  const dir = handoffDir(home);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 100; i++) {
    const id = `20200101-0000${String(i).padStart(2, "0")}-old`;
    mkdirSync(join(dir, id));
    writeFileSync(join(dir, id, "meta.json"), JSON.stringify({ ...JSON.parse(meta(id)), created: new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString() }));
    writeFileSync(join(dir, id, "handoff.md"), "x");
  }
  const target = tmpHome();
  writeFileSync(join(target, "meta.json"), meta("19990101-000000-link"));
  writeFileSync(join(target, "precious.txt"), "data");
  symlinkSync(target, join(dir, "19990101-000000-link"));
  writeFileSync(join(dir, "19990101-000001-file"), "a file named like an id");
  mkdirSync(join(dir, "19990101-000000-nometa"));
  const s = saveHandoff({ brief: "new" }, { home });
  assert.equal(s.rotated, 1);
  assert.ok(existsSync(s.dir!));
  assert.ok(!existsSync(join(dir, "20200101-000000-old")), "the oldest of ours went");
  for (const n of ["19990101-000000-link", "19990101-000001-file", "19990101-000000-nometa"]) assert.ok(lstatSync(join(dir, n)), n);
  assert.ok(existsSync(join(target, "precious.txt")));
});

test("ordering is by time and save order, never the id string: future-dated folders cannot evict or outrank a new save", () => {
  const home = tmpHome();
  const dir = handoffDir(home);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 100; i++) {
    const id = `20991231-0000${String(i).padStart(2, "0")}-future`;
    mkdirSync(join(dir, id));
    writeFileSync(join(dir, id, "meta.json"), JSON.stringify({ id, title: "planted", created: new Date(Date.UTC(2099, 11, 31, 0, 0, i)).toISOString(), tokens: 1, briefTokens: 1, blocks: [], masked: 0 }));
    writeFileSync(join(dir, id, "handoff.md"), "planted");
  }
  const s = saveHandoff({ brief: "just saved", title: "mine" }, { home });
  assert.ok(existsSync(s.dir!), "the folder the tool reports exists");
  assert.equal(s.rotated, 1);
  assert.equal(readHandoff("latest", home)?.meta.title, "mine");

  // Two saves in one second under different titles: the later one is the latest.
  const home2 = tmpHome();
  const now = new Date("2026-10-26T10:00:00Z");
  saveHandoff({ brief: "first", title: "zzz first" }, { home: home2, now });
  saveHandoff({ brief: "second", title: "aaa second" }, { home: home2, now });
  assert.equal(readHandoff("latest", home2)?.meta.title, "aaa second");
  for (let i = 0; i < 60; i++) saveHandoff({ brief: "n", title: "same" }, { home: home2, now });
  assert.equal(listHandoffs(home2).length, 62);
  assert.equal(listHandoffs(home2)[0].id, "20261026-100000-same-60");
});

test("control characters never reach the file or a terminal; the model name is capped, cleaned and masked", () => {
  const home = tmpHome();
  const key = ["sk", "ant", "api03", "Q".repeat(30)].join("-");
  const s = saveHandoff(
    { brief: "line\u001b]0;PWNED\u0007\u001b[2J\r\nnext\u0085", title: "t\u001b[31mred", verbatim: [{ label: "L\u0000\u009b", text: "code\u001b[0m" }], model: `${key}\u001b[2J${"m".repeat(500)}` },
    { home }
  );
  const md = readFileSync(join(s.dir!, "handoff.md"), "utf8");
  const metaText = readFileSync(join(s.dir!, "meta.json"), "utf8");
  for (const t of [md, s.meta.title, s.meta.blocks[0].label]) assert.doesNotMatch(t, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  assert.match(md, /line\]0;PWNED\[2J\nnext/);
  assert.ok(s.meta.model!.length <= HANDOFF_LIMITS.modelChars);
  assert.ok(!metaText.includes("QQQQ") && !metaText.includes("\\u001b"), metaText.slice(0, 300));
  assert.throws(() => saveHandoff({ brief: "b", model: 42 as unknown as string }, { home }), /model/);

  // A hand-edited handoff.md with escape sequences is printed clean.
  writeFileSync(join(s.dir!, "handoff.md"), "# Handoff\n\u001b]0;PWNED\u0007\u001b[2Jvisible\n", { flag: "w" });
  const shown = spawnSync(process.execPath, [cli, "handoff", "latest"], { env: sandboxEnv(home), encoding: "utf8" });
  assert.equal(shown.status, 0);
  assert.doesNotMatch(shown.stdout, /\u001b|\u0007/);
  assert.match(shown.stdout, /visible/);
  const listed = spawnSync(process.execPath, [cli, "handoff", "list"], { env: sandboxEnv(home), encoding: "utf8" });
  assert.doesNotMatch(listed.stdout, /\u001b/);
});
