/**
 * The A/B suite's tasks (`context-doctor ab`): small, self-contained coding
 * tasks, each a tiny repository, a request, and a deterministic check
 * (`node test.mjs`, exit 0 = pass). Every file is generated here: no
 * network, no dependencies, nothing from anyone's real sessions.
 *
 * Three of them carry a big file on purpose, because that is where the
 * levers act: a long format spec only one section of which matters
 * (pack_context), a production log the agent reads and then no longer needs
 * (autopilot's clearing), a design doc (both). The others are ordinary
 * small fixes, where a lever should change nothing.
 *
 * `solution` is the reference fix. The agent never sees it: the test suite
 * checks that every fixture fails its check and passes with the solution,
 * and the local mock API writes it to play a model that solves the task.
 */

export interface AbTask {
  id: string;
  title: string;
  /** The repository: relative path -> content. `test.mjs` is the check and is read-only to the agent. */
  files: Record<string, string>;
  /** What the agent is asked to do. */
  prompt: string;
  /** The reference fix: files to write over the fixture. */
  solution: Record<string, string>;
  /** A big file the task needs only part of (read whole, or packed). */
  bigFile?: string;
}

/** Deterministic filler prose: the same words on every machine and run. */
function filler(seed: number, sentences: number): string {
  const words = [
    "configuration", "loader", "section", "value", "parser", "release", "operator", "team", "file", "format",
    "history", "comment", "reader", "writer", "legacy", "service", "deployment", "default", "migration", "field",
    "token", "cluster", "region", "backup", "schedule", "policy", "client", "server", "cache", "window",
    "the", "a", "of", "to", "and", "in", "for", "with", "on", "by", "is", "was", "are", "were", "every", "some",
  ];
  let s = seed >>> 0;
  const next = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const out: string[] = [];
  for (let i = 0; i < sentences; i++) {
    const n = 9 + Math.floor(next() * 12);
    const w = Array.from({ length: n }, () => words[Math.floor(next() * words.length)]);
    out.push(w[0][0].toUpperCase() + w[0].slice(1) + " " + w.slice(1).join(" ") + ".");
  }
  return out.join(" ");
}

const lines = (...l: string[]) => l.join("\n") + "\n";

// -- 1. range: an off-by-one and two missing cases --------------------------

const range: AbTask = {
  id: "range-inclusive",
  title: "Fix an off-by-one and two edge cases",
  files: {
    "src/range.js": lines(
      "// range(start, end, step): the numbers from start to end.",
      "export function range(start, end, step = 1) {",
      "  const out = [];",
      "  for (let i = start; i < end; i += step) out.push(i);",
      "  return out;",
      "}",
    ),
    "test.mjs": lines(
      'import assert from "node:assert/strict";',
      'import { range } from "./src/range.js";',
      "assert.deepEqual(range(1, 5), [1, 2, 3, 4, 5]);",
      "assert.deepEqual(range(0, 10, 5), [0, 5, 10]);",
      "assert.deepEqual(range(0, 9, 4), [0, 4, 8]);",
      "assert.deepEqual(range(5, 1, -2), [5, 3, 1]);",
      "assert.deepEqual(range(3, 3), [3]);",
      "assert.deepEqual(range(4, 1), []);",
      "assert.throws(() => range(1, 2, 0), RangeError);",
      'console.log("ok");',
    ),
  },
  prompt:
    "range(start, end, step) in src/range.js must include `end` when the steps land on it (range(1, 5) is [1, 2, 3, 4, 5]), " +
    "count down when step is negative (range(5, 1, -2) is [5, 3, 1]), return [] when the steps never reach end, and throw a RangeError for step 0. Fix it.",
  solution: {
    "src/range.js": lines(
      "// range(start, end, step): the numbers from start to end, end included when a step lands on it.",
      "export function range(start, end, step = 1) {",
      '  if (step === 0) throw new RangeError("step must not be 0");',
      "  const out = [];",
      "  if (step > 0) for (let i = start; i <= end; i += step) out.push(i);",
      "  else for (let i = start; i >= end; i += step) out.push(i);",
      "  return out;",
      "}",
    ),
  },
};

// -- 2. slugify: implement from rules in the README --------------------------

const slugify: AbTask = {
  id: "slugify",
  title: "Implement a function from a short spec",
  files: {
    "README.md": lines(
      "# slugs",
      "",
      "`slugify(title)` turns a title into a URL slug:",
      "",
      "1. Letters with accents lose them (`Crème` becomes `creme`); everything is lower case.",
      "2. Every run of characters that are not a-z or 0-9 becomes one `-`.",
      "3. No `-` at the start or the end.",
      "4. At most 32 characters. A longer slug is cut back to the last `-` at or before character 32, so no word is cut in half; a slug whose first word is longer than 32 characters is cut at 32.",
      "5. An empty result is `untitled`.",
    ),
    "src/slug.js": lines("export function slugify(title) {", '  throw new Error("not implemented");', "}"),
    "test.mjs": lines(
      'import assert from "node:assert/strict";',
      'import { slugify } from "./src/slug.js";',
      'assert.equal(slugify("Hello, World!"), "hello-world");',
      'assert.equal(slugify("  Crème Brûlée -- Recipe  "), "creme-brulee-recipe");',
      'assert.equal(slugify("a___b...c"), "a-b-c");',
      'assert.equal(slugify("The quick brown fox jumps over the lazy dog"), "the-quick-brown-fox-jumps-over");',
      'assert.equal(slugify("x".repeat(40)), "x".repeat(32));',
      'assert.equal(slugify("!!!"), "untitled");',
      'assert.equal(slugify("Ünïcödé 2026"), "unicode-2026");',
      'console.log("ok");',
    ),
  },
  prompt: "Implement slugify in src/slug.js following the rules in README.md.",
  solution: {
    "src/slug.js": lines(
      "export function slugify(title) {",
      '  let s = title.normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase();',
      '  s = s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");',
      "  if (s.length > 32) {",
      "    const cut = s.slice(0, 33).lastIndexOf(\"-\");",
      "    s = cut > 0 ? s.slice(0, cut) : s.slice(0, 32);",
      "  }",
      '  return s || "untitled";',
      "}",
    ),
  },
};

// -- 3. ini: implement from one section of a long format document ------------

const formatDoc = [
  "# The KEYFILE format",
  "",
  "This document describes the KEYFILE configuration format used by the deployment tools. Most of it is background; implementers need section 7.",
  "",
  "## 1. History",
  "",
  filler(11, 30),
  "",
  "## 2. Design goals",
  "",
  filler(12, 25),
  "",
  "## 3. Encoding",
  "",
  "Files are UTF-8. " + filler(13, 15),
  "",
  "## 4. Tooling",
  "",
  filler(14, 28),
  "",
  "## 5. Versioning",
  "",
  filler(15, 20),
  "",
  "## 6. Examples from the field",
  "",
  filler(16, 30),
  "",
  "## 7. Parsing rules",
  "",
  "A parser returns a plain object. Lines are processed in order:",
  "",
  "- Blank lines are ignored. Lines whose first non-space character is `;` or `#` are comments and are ignored. There are no comments after a value.",
  "- `[name]` starts a section: later keys go into `result[name]`. A dotted name `[a.b]` means `result.a.b`, created as nested objects. Spaces inside the brackets around the name are trimmed.",
  "- `key = value` sets a key in the current section; keys before the first section go on the result itself. Key and value are trimmed. Only the first `=` splits; the value may contain more.",
  "- A value wrapped in double quotes keeps its inner spaces and loses the quotes: `name = \"  a b \"` is `\"  a b \"` without the outer quotes, i.e. `  a b `.",
  "- `true` and `false` become booleans; a value that is an integer (optional `-`, digits only) becomes a number. Everything else stays a string. Quoted values always stay strings.",
  "- A key set twice in one section keeps the last value. A section seen twice continues the first one.",
  "- Any other non-blank line is an error: throw a SyntaxError whose message includes the 1-based line number as `line N`.",
  "",
  "## 8. Security notes",
  "",
  filler(17, 22),
  "",
  "## 9. Frequently asked questions",
  "",
  filler(18, 35),
  "",
].join("\n");

const ini: AbTask = {
  id: "ini-parser",
  title: "Implement a parser from one section of a long spec",
  bigFile: "docs/FORMAT.md",
  files: {
    "docs/FORMAT.md": formatDoc,
    "src/ini.js": lines("// parseIni(text): parse a KEYFILE document (see docs/FORMAT.md).", "export function parseIni(text) {", '  throw new Error("not implemented");', "}"),
    "test.mjs": lines(
      'import assert from "node:assert/strict";',
      'import { parseIni } from "./src/ini.js";',
      "const doc = [",
      '  "; deployment settings",',
      '  "name = web",',
      '  "",',
      '  "[server]",',
      '  "port = 8080",',
      '  "host = example.org ",',
      '  "debug = false",',
      '  "  # an indented comment",',
      '  "url = http://x/?a=b",',
      '  "[ db.primary ]",',
      '  "user = \\"  admin \\"",',
      '  "retries = -3",',
      '  "ratio = 1.5",',
      '  "[server]",',
      '  "port = 9090",',
      "].join(\"\\n\");",
      "assert.deepEqual(parseIni(doc), {",
      '  name: "web",',
      '  server: { port: 9090, host: "example.org", debug: false, url: "http://x/?a=b" },',
      '  db: { primary: { user: "  admin ", retries: -3, ratio: "1.5" } },',
      "});",
      'assert.deepEqual(parseIni("[a]\\nflag = true\\nq = \\"42\\""), { a: { flag: true, q: "42" } });',
      'assert.throws(() => parseIni("[a]\\nok = 1\\nnot a pair"), (e) => e instanceof SyntaxError && /line 3/.test(e.message));',
      'console.log("ok");',
    ),
  },
  prompt: "Implement parseIni in src/ini.js. The format is specified in docs/FORMAT.md (a long document; the rules are in one section of it).",
  solution: {
    "src/ini.js": lines(
      "// parseIni(text): parse a KEYFILE document (see docs/FORMAT.md, section 7).",
      "export function parseIni(text) {",
      "  const result = {};",
      "  let current = result;",
      '  text.split("\\n").forEach((raw, i) => {',
      "    const line = raw.trim();",
      '    if (line === "" || line.startsWith(";") || line.startsWith("#")) return;',
      "    const header = /^\\[(.*)\\]$/.exec(line);",
      "    if (header) {",
      "      current = result;",
      '      for (const part of header[1].trim().split(".")) current = current[part] ??= {};',
      "      return;",
      "    }",
      '    const eq = line.indexOf("=");',
      '    if (eq <= 0) throw new SyntaxError("line " + (i + 1) + ": expected key = value");',
      "    const key = line.slice(0, eq).trim();",
      "    const rawValue = raw.slice(raw.indexOf(\"=\") + 1).trim();",
      "    let value;",
      '    if (rawValue.length >= 2 && rawValue.startsWith("\\"") && rawValue.endsWith("\\"")) value = rawValue.slice(1, -1);',
      '    else if (rawValue === "true" || rawValue === "false") value = rawValue === "true";',
      "    else if (/^-?\\d+$/.test(rawValue)) value = Number(rawValue);",
      "    else value = rawValue;",
      "    current[key] = value;",
      "  });",
      "  return result;",
      "}",
    ),
  },
};

// -- 4. retry: a bug the production log points at ---------------------------

function appLog(): string {
  const out: string[] = [];
  let t = Date.UTC(2026, 9, 20, 8, 0, 0);
  const at = () => new Date((t += 1370)).toISOString();
  const routes = ["/api/orders", "/api/users", "/api/cart", "/health", "/api/search", "/api/invoices"];
  for (let i = 0; i < 300; i++) {
    const r = routes[(i * 7) % routes.length];
    if (i % 37 === 11) {
      const id = 4000 + i;
      out.push(`${at()} WARN  payments  request ${id} to billing failed (503), retrying: attempt=1 delayMs=NaN`);
      out.push(`${at()} WARN  payments  request ${id} to billing failed (503), retrying: attempt=2 delayMs=NaN`);
      out.push(`${at()} ERROR payments  request ${id} gave up after 3 attempts with retries=3; no retry waited (delayMs=NaN)`);
    } else {
      out.push(`${at()} INFO  http      ${r} 200 ${12 + ((i * 13) % 180)}ms user=${1000 + ((i * 31) % 900)}`);
    }
  }
  return out.join("\n") + "\n";
}

const retry: AbTask = {
  id: "retry-backoff",
  title: "Find a bug from a production log",
  bigFile: "logs/app.log",
  files: {
    "logs/app.log": appLog(),
    "src/retry.js": lines(
      "// withRetry(fn, options): call fn until it succeeds, waiting longer after each failure.",
      "// options: retries (failures to retry after, default 3), baseDelayMs (default 100), sleep (ms => Promise).",
      "export async function withRetry(fn, options = {}) {",
      "  const retries = options.retries ?? 3;",
      "  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));",
      "  for (let attempt = 1; ; attempt++) {",
      "    try {",
      "      return await fn(attempt);",
      "    } catch (err) {",
      "      if (attempt >= retries) throw err;",
      "      await sleep(options.baseDelay * 2 ** (attempt - 1));",
      "    }",
      "  }",
      "}",
    ),
    "test.mjs": lines(
      'import assert from "node:assert/strict";',
      'import { withRetry } from "./src/retry.js";',
      "const waits = [];",
      "let calls = 0;",
      'const failing = async () => { calls++; throw new Error("503"); };',
      "await assert.rejects(withRetry(failing, { sleep: async (ms) => { waits.push(ms); } }));",
      "assert.equal(calls, 4, \"retries: 3 means 3 retries after the first try\");",
      "assert.deepEqual(waits, [100, 200, 400]);",
      "waits.length = 0; calls = 0;",
      'const flaky = async (n) => { calls++; if (n < 3) throw new Error("503"); return "done"; };',
      'assert.equal(await withRetry(flaky, { baseDelayMs: 50, sleep: async (ms) => { waits.push(ms); } }), "done");',
      "assert.deepEqual(waits, [50, 100]);",
      'console.log("ok");',
    ),
  },
  prompt: "The production log in logs/app.log shows the billing retries misbehaving. Find the cause in src/retry.js (the helper every service uses) and fix it.",
  solution: {
    "src/retry.js": lines(
      "// withRetry(fn, options): call fn until it succeeds, waiting longer after each failure.",
      "// options: retries (failures to retry after, default 3), baseDelayMs (default 100), sleep (ms => Promise).",
      "export async function withRetry(fn, options = {}) {",
      "  const retries = options.retries ?? 3;",
      "  const base = options.baseDelayMs ?? 100;",
      "  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));",
      "  for (let attempt = 1; ; attempt++) {",
      "    try {",
      "      return await fn(attempt);",
      "    } catch (err) {",
      "      if (attempt > retries) throw err;",
      "      await sleep(base * 2 ** (attempt - 1));",
      "    }",
      "  }",
      "}",
    ),
  },
};

// -- 5. csv: quoted fields --------------------------------------------------

const csv: AbTask = {
  id: "csv-quotes",
  title: "Handle quoted fields in a parser",
  files: {
    "src/csv.js": lines("// parseCsvLine(line): the fields of one CSV line (RFC 4180 quoting).", "export function parseCsvLine(line) {", '  return line.split(",");', "}"),
    "test.mjs": lines(
      'import assert from "node:assert/strict";',
      'import { parseCsvLine } from "./src/csv.js";',
      'assert.deepEqual(parseCsvLine("a,b,c"), ["a", "b", "c"]);',
      'assert.deepEqual(parseCsvLine("\\"x, y\\",z"), ["x, y", "z"]);',
      'assert.deepEqual(parseCsvLine("\\"say \\"\\"hi\\"\\"\\",2"), ["say \\"hi\\"", "2"]);',
      'assert.deepEqual(parseCsvLine("a,,c,"), ["a", "", "c", ""]);',
      'assert.deepEqual(parseCsvLine("\\"\\""), [""]);',
      'console.log("ok");',
    ),
  },
  prompt: "parseCsvLine in src/csv.js splits on every comma, which breaks quoted fields. Make it follow RFC 4180 quoting: fields in double quotes may contain commas, and a doubled quote inside them is one quote.",
  solution: {
    "src/csv.js": lines(
      "// parseCsvLine(line): the fields of one CSV line (RFC 4180 quoting).",
      "export function parseCsvLine(line) {",
      "  const fields = [];",
      '  let field = "";',
      "  let quoted = false;",
      "  for (let i = 0; i < line.length; i++) {",
      "    const c = line[i];",
      "    if (quoted) {",
      '      if (c === "\\"" && line[i + 1] === "\\"") { field += "\\""; i++; }',
      '      else if (c === "\\"") quoted = false;',
      "      else field += c;",
      '    } else if (c === "\\"") quoted = true;',
      '    else if (c === ",") { fields.push(field); field = ""; }',
      "    else field += c;",
      "  }",
      "  fields.push(field);",
      "  return fields;",
      "}",
    ),
  },
};

// -- 6. rename across files, keeping a deprecated alias ----------------------

const rename: AbTask = {
  id: "rename-export",
  title: "Rename a function across files",
  files: {
    "src/users.js": lines(
      "const USERS = new Map([[1, { id: 1, name: \"Ada\" }], [2, { id: 2, name: \"Lin\" }]]);",
      "export function getUser(id) {",
      "  return USERS.get(id) ?? null;",
      "}",
    ),
    "src/api.js": lines('import { getUser } from "./users.js";', "export function handle(id) {", "  const user = getUser(id);", "  return user ? { status: 200, body: user } : { status: 404 };", "}"),
    "src/report.js": lines('import { getUser } from "./users.js";', "export function names(ids) {", "  return ids.map((id) => getUser(id)?.name ?? \"?\").join(\", \");", "}"),
    "test.mjs": lines(
      'import assert from "node:assert/strict";',
      'import { readFileSync } from "node:fs";',
      'import * as users from "./src/users.js";',
      'import { handle } from "./src/api.js";',
      'import { names } from "./src/report.js";',
      'assert.equal(typeof users.fetchUser, "function");',
      'assert.equal(users.fetchUser(1).name, "Ada");',
      'assert.equal(users.getUser(2).name, "Lin", "getUser stays, as a deprecated alias");',
      "assert.deepEqual(handle(1), { status: 200, body: { id: 1, name: \"Ada\" } });",
      'assert.equal(names([1, 2, 3]), "Ada, Lin, ?");',
      'for (const f of ["src/api.js", "src/report.js"]) assert.ok(!/getUser/.test(readFileSync(f, "utf8")), f + " still calls getUser");',
      'assert.match(readFileSync("src/users.js", "utf8"), /@deprecated/);',
      'console.log("ok");',
    ),
  },
  prompt:
    "Rename getUser to fetchUser in src/users.js and update every caller in src/. Keep getUser exported as an alias that calls fetchUser, marked with a JSDoc @deprecated tag, so outside code keeps working.",
  solution: {
    "src/users.js": lines(
      "const USERS = new Map([[1, { id: 1, name: \"Ada\" }], [2, { id: 2, name: \"Lin\" }]]);",
      "export function fetchUser(id) {",
      "  return USERS.get(id) ?? null;",
      "}",
      "/** @deprecated Use fetchUser. */",
      "export function getUser(id) {",
      "  return fetchUser(id);",
      "}",
    ),
    "src/api.js": lines('import { fetchUser } from "./users.js";', "export function handle(id) {", "  const user = fetchUser(id);", "  return user ? { status: 200, body: user } : { status: 404 };", "}"),
    "src/report.js": lines('import { fetchUser } from "./users.js";', "export function names(ids) {", "  return ids.map((id) => fetchUser(id)?.name ?? \"?\").join(\", \");", "}"),
  },
};

// -- 7. a TTL cache from a design doc ----------------------------------------

const designDoc = [
  "# Cache design",
  "",
  "## Context",
  "",
  filler(21, 25),
  "",
  "## Alternatives considered",
  "",
  filler(22, 30),
  "",
  "## Decision: TtlCache",
  "",
  "`new TtlCache({ max, ttlMs, now })` where `now` is a function returning milliseconds (default `Date.now`). Entries expire `ttlMs` after they were last **set** (reading does not extend them).",
  "",
  "- `get(key)`: the value, or `undefined` when absent or expired (an expired entry is removed). A hit makes the entry the most recently used.",
  "- `set(key, value)`: stores it as the most recently used, with a fresh expiry. When that makes more than `max` live entries, remove expired entries first, then the least recently used, until `max` remain.",
  "- `delete(key)`: removes it; returns whether a live entry was removed.",
  "- `size`: a getter, the number of entries that have not expired.",
  "",
  "## Rollout",
  "",
  filler(23, 28),
  "",
].join("\n");

const ttl: AbTask = {
  id: "ttl-cache",
  title: "Build a small class from a design doc",
  bigFile: "docs/DESIGN.md",
  files: {
    "docs/DESIGN.md": designDoc,
    "src/cache.js": lines("// TtlCache: see docs/DESIGN.md.", "export class TtlCache {", "  constructor(options) {", '    throw new Error("not implemented");', "  }", "}"),
    "test.mjs": lines(
      'import assert from "node:assert/strict";',
      'import { TtlCache } from "./src/cache.js";',
      "let t = 0;",
      "const c = new TtlCache({ max: 2, ttlMs: 100, now: () => t });",
      'c.set("a", 1); c.set("b", 2);',
      'assert.equal(c.get("a"), 1);',
      'c.set("c", 3);',
      'assert.equal(c.get("b"), undefined, "b was least recently used");',
      'assert.equal(c.get("a"), 1); assert.equal(c.get("c"), 3);',
      "assert.equal(c.size, 2);",
      "t = 99; assert.equal(c.get(\"a\"), 1, \"reading does not extend\");",
      't = 100; assert.equal(c.get("a"), undefined, "expired at ttlMs");',
      "assert.equal(c.size, 0);",
      't = 200; c.set("x", 1); t = 250; c.set("y", 2); t = 301; c.set("z", 3);',
      'assert.equal(c.get("x"), undefined); assert.equal(c.get("y"), 2); assert.equal(c.get("z"), 3);',
      'assert.equal(c.delete("y"), true); assert.equal(c.delete("y"), false); assert.equal(c.size, 1);',
      'console.log("ok");',
    ),
  },
  prompt: "Implement TtlCache in src/cache.js as decided in docs/DESIGN.md.",
  solution: {
    "src/cache.js": lines(
      "// TtlCache: see docs/DESIGN.md.",
      "export class TtlCache {",
      "  constructor({ max, ttlMs, now = Date.now }) {",
      "    this.max = max; this.ttlMs = ttlMs; this.now = now; this.map = new Map();",
      "  }",
      "  #live(key) {",
      "    const e = this.map.get(key);",
      "    if (!e) return undefined;",
      "    if (this.now() >= e.expires) { this.map.delete(key); return undefined; }",
      "    return e;",
      "  }",
      "  get(key) {",
      "    const e = this.#live(key);",
      "    if (!e) return undefined;",
      "    this.map.delete(key); this.map.set(key, e);",
      "    return e.value;",
      "  }",
      "  set(key, value) {",
      "    this.map.delete(key);",
      "    this.map.set(key, { value, expires: this.now() + this.ttlMs });",
      "    if (this.size <= this.max) return;",
      "    for (const k of [...this.map.keys()]) this.#live(k); // expired entries go first",
      "    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);",
      "  }",
      "  delete(key) {",
      "    const live = this.#live(key) !== undefined;",
      "    this.map.delete(key);",
      "    return live;",
      "  }",
      "  get size() {",
      "    let n = 0;",
      "    for (const e of this.map.values()) if (this.now() < e.expires) n++;",
      "    return n;",
      "  }",
      "}",
    ),
  },
};

// -- 8. money formatting -----------------------------------------------------

const money: AbTask = {
  id: "money-format",
  title: "Fix formatting edge cases",
  files: {
    "src/money.js": lines(
      "// formatMoney(cents, currency): USD $1,234.56, EUR €1.234,56, JPY ¥1,235 (no minor unit).",
      "export function formatMoney(cents, currency) {",
      '  const symbol = { USD: "$", EUR: "€", JPY: "¥" }[currency];',
      "  return symbol + (cents / 100).toFixed(2);",
      "}",
    ),
    "test.mjs": lines(
      'import assert from "node:assert/strict";',
      'import { formatMoney } from "./src/money.js";',
      'assert.equal(formatMoney(123456, "USD"), "$1,234.56");',
      'assert.equal(formatMoney(5, "USD"), "$0.05");',
      'assert.equal(formatMoney(-100, "USD"), "-$1.00");',
      'assert.equal(formatMoney(123456789, "EUR"), "€1.234.567,89");',
      'assert.equal(formatMoney(1235, "JPY"), "¥1,235", "JPY amounts are whole yen: 1235 means ¥1,235");',
      'assert.equal(formatMoney(0, "EUR"), "€0,00");',
      'assert.throws(() => formatMoney(1, "XYZ"), /XYZ/);',
      'console.log("ok");',
    ),
  },
  prompt:
    "formatMoney in src/money.js gets thousands separators, negatives and the yen wrong. USD: $1,234.56 and -$1.00. EUR: €1.234,56 (dots group thousands, comma before cents). JPY has no minor unit, so the amount is whole yen: formatMoney(1235, \"JPY\") is ¥1,235. An unknown currency throws an error naming it. Fix it.",
  solution: {
    "src/money.js": lines(
      "// formatMoney(cents, currency): USD $1,234.56, EUR €1.234,56, JPY ¥1,235 (no minor unit).",
      "const FORMATS = {",
      '  USD: { symbol: "$", group: ",", decimal: ".", minor: 2 },',
      '  EUR: { symbol: "€", group: ".", decimal: ",", minor: 2 },',
      '  JPY: { symbol: "¥", group: ",", decimal: "", minor: 0 },',
      "};",
      "export function formatMoney(amount, currency) {",
      "  const f = FORMATS[currency];",
      '  if (!f) throw new Error("unknown currency " + currency);',
      "  const abs = Math.abs(amount);",
      "  const units = f.minor ? Math.floor(abs / 100) : abs;",
      '  const grouped = String(units).replace(/\\B(?=(\\d{3})+(?!\\d))/g, f.group);',
      '  const minor = f.minor ? f.decimal + String(abs % 100).padStart(2, "0") : "";',
      '  return (amount < 0 ? "-" : "") + f.symbol + grouped + minor;',
      "}",
    ),
  },
};

export const AB_TASKS: AbTask[] = [range, slugify, ini, retry, csv, rename, ttl, money];
