/**
 * The shared scan's cache (scan.ts): a grown transcript resumed where the
 * last read stopped gives the records a fresh read gives, for every
 * extractor, wherever the file was cut (mid-line too); rewritten, damaged
 * and foreign entries are never trusted; nothing is written with
 * CONTEXT_DOCTOR_NO_CACHE; the cache stays bounded; overlapping runs agree.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clearScanMemo, pruneScanCache, rowsOf, scanCacheDir, type Extractor } from "../scan.js";
import { REQUEST_ROWS } from "../coldresume.js";
import { QUALITY_ROWS } from "../compactquality.js";
import { MISS_ROWS } from "../cachemisses.js";
import { LENS_ROWS } from "../lens.js";
import { MCP_ROWS } from "../mcpschema.js";
import { PRUNE_ROWS } from "../prune.js";
import { savingsRows } from "../savings.js";
import { USAGE_ROWS } from "../limits.js";
import { buildHistory, frozenClock, GOLDEN_COMMANDS } from "./history-fixture.js";
import { cleanEnv, goldenName } from "./golden-run.js";
import { normalizeOutput } from "./history-fixture.js";

const here = dirname(fileURLToPath(import.meta.url));
const EXTRACTORS: Extractor<any>[] = [REQUEST_ROWS, QUALITY_ROWS, MISS_ROWS, LENS_ROWS, MCP_ROWS, PRUNE_ROWS, USAGE_ROWS, savingsRows(true), savingsRows(false)];

function withCache<T>(fn: (cache: string) => T): T {
  const saved = process.env.CONTEXT_DOCTOR_CACHE_DIR;
  const cache = mkdtempSync(join(tmpdir(), "cd-scan-unit-"));
  process.env.CONTEXT_DOCTOR_CACHE_DIR = cache;
  clearScanMemo();
  try {
    return fn(cache);
  } finally {
    clearScanMemo();
    if (saved === undefined) delete process.env.CONTEXT_DOCTOR_CACHE_DIR;
    else process.env.CONTEXT_DOCTOR_CACHE_DIR = saved;
    rmSync(cache, { recursive: true, force: true });
  }
}

/** The extractor, counting the lines it is given (same id: same cache). */
function counting(ex: Extractor<any>): Extractor<any> & { lines: number } {
  const c = { ...ex, lines: 0, line(raw: string, row: () => any, out: unknown[], st: any) { c.lines++; ex.line(raw, row, out, st); } };
  return c;
}

const history = (() => {
  let home: string | undefined;
  return () => {
    if (!home) { home = mkdtempSync(join(tmpdir(), "cd-scan-hist-")); buildHistory(home); }
    return home;
  };
})();
const transcripts = (home: string) => {
  const p = join(home, ".claude", "projects", "-work-app");
  return [...readdirSync(p).filter((f) => f.endsWith(".jsonl")).map((f) => join(p, f)), join(p, "s4", "subagents", "agent-a1.jsonl")];
};

test("a grown transcript resumed from the cache gives exactly the records of a fresh read, for every extractor and wherever it was cut", () => {
  withCache(() => {
    const dir = mkdtempSync(join(tmpdir(), "cd-scan-grow-"));
    try {
      // The shapes that matter, not every file: compactions and a fork's parent, a malformed row and a
      // half-written last line, CRLF, a subagent (a lighter test keeps slow CI runners unstarved).
      const sources = transcripts(history()).filter((p) => /[\\/](s1|live|crlf)\.jsonl$|agent-a1\.jsonl$/.test(p));
      assert.equal(sources.length, 4);
      for (const src of sources) {
        const full = readFileSync(src);
        // Cut points: early, mid-file, just before and after a newline, and mid-line.
        const nl = full.indexOf(10, Math.floor(full.length / 2));
        const cuts = [1, Math.floor(full.length / 7), nl, nl + 1, nl + 40, full.length - 3];
        for (const cut of cuts) {
          for (const ex of EXTRACTORS) {
            const path = join(dir, `${ex.id}-${cut}-${src.split(/[\\/]/).pop()}`);
            writeFileSync(path, full.subarray(0, cut));
            rowsOf(path, ex);
            appendFileSync(path, full.subarray(cut));
            // From the disk entry, as the next run finds it.
            clearScanMemo();
            const c = counting(ex);
            const resumed = rowsOf(path, c);
            const fresh = rowsOf(path, ex, { keep: false });
            assert.deepEqual(resumed, fresh, `${ex.id}, ${src.split(/[\\/]/).pop()} cut at ${cut} of ${full.length}`);
            // JSON in, JSON out: what the next run reads back is what was computed.
            assert.deepEqual(JSON.parse(JSON.stringify(resumed)), resumed);
            // Resumed: only the lines from the one the cut fell in (or after it) were read again.
            const after = full.subarray(cut).toString("utf8").split("\n").length;
            if (ex.resumable !== false && cut > 1) assert.ok(c.lines <= after, `${ex.id} resumed, not re-read (${c.lines} lines read, ${after} after the cut)`);
          }
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a transcript rewritten in place is read again: smaller, same size within one clock tick, or a different start", () => {
  withCache(() => {
    const dir = mkdtempSync(join(tmpdir(), "cd-scan-rw-"));
    try {
      const row = (id: string, n: number) => JSON.stringify({ type: "assistant", uuid: id, timestamp: "2026-09-30T10:00:00.000Z", message: { id, model: "claude-opus-5-5", usage: { input_tokens: n, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + "\n";
      const path = join(dir, "t.jsonl");
      writeFileSync(path, row("a1", 100) + row("a2", 200));
      const t = statSync(path).mtime;
      assert.equal(rowsOf(path, REQUEST_ROWS).length, 2);
      // Same size, same time, same inode: only the content tells.
      writeFileSync(path, row("b1", 300) + row("b2", 400));
      utimesSync(path, t, t);
      assert.deepEqual(rowsOf(path, REQUEST_ROWS).map((r: any) => r.uuid), ["b1", "b2"]);
      clearScanMemo();
      assert.deepEqual(rowsOf(path, REQUEST_ROWS).map((r: any) => r.uuid), ["b1", "b2"]);
      // Grown, but the part read before changed: not resumed.
      writeFileSync(path, row("c1", 500) + row("c2", 600) + row("c3", 700));
      assert.deepEqual(rowsOf(path, REQUEST_ROWS).map((r: any) => r.uuid), ["c1", "c2", "c3"]);
      // Truncated.
      truncateSync(path, row("c1", 500).length);
      assert.deepEqual(rowsOf(path, REQUEST_ROWS).map((r: any) => r.uuid), ["c1"]);
      rmSync(path);
      assert.throws(() => rowsOf(path, REQUEST_ROWS), /ENOENT|unreadable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a damaged or foreign cache entry is a miss, and is replaced", () => {
  withCache((cache) => {
    const path = transcripts(history())[0];
    const good = rowsOf(path, REQUEST_ROWS);
    const files = readdirSync(cache, { recursive: true }).map(String).filter((f) => f.endsWith(".json") && f.includes("requests.1"));
    assert.equal(files.length, 1);
    const entry = join(cache, files[0]);
    const real = JSON.parse(readFileSync(entry, "utf8"));
    for (const bad of ["{\"path\":", "[]", "null", JSON.stringify({ ...real, path: "/elsewhere.jsonl" }), JSON.stringify({ ...real, id: "requests.0" }), JSON.stringify({ ...real, rows: "x" })]) {
      writeFileSync(entry, bad);
      clearScanMemo();
      assert.deepEqual(rowsOf(path, REQUEST_ROWS), good);
      assert.equal(JSON.parse(readFileSync(entry, "utf8")).path, path);
    }
  });
});

test("CONTEXT_DOCTOR_NO_CACHE keeps nothing on disk; the cache folder follows CONTEXT_DOCTOR_CACHE_DIR, then XDG_CACHE_HOME, then ~/.cache", () => {
  withCache((cache) => {
    process.env.CONTEXT_DOCTOR_NO_CACHE = "1";
    try {
      rowsOf(transcripts(history())[0], REQUEST_ROWS);
      assert.deepEqual(readdirSync(cache), []);
    } finally {
      delete process.env.CONTEXT_DOCTOR_NO_CACHE;
    }
  });
  assert.equal(scanCacheDir({ CONTEXT_DOCTOR_CACHE_DIR: "/c" }), "/c");
  assert.equal(scanCacheDir({ XDG_CACHE_HOME: join(tmpdir(), "x") }), join(tmpdir(), "x", "context-doctor"));
  assert.match(scanCacheDir({ XDG_CACHE_HOME: "relative" }), /[\\/]\.cache[\\/]context-doctor$/);
});

test("pruning: other versions, gone or long-untouched transcripts and stray temporary files go; the oldest go past the size cap", () => {
  withCache((cache) => {
    const home = history();
    const dir = mkdtempSync(join(tmpdir(), "cd-scan-prune-"));
    try {
      const keep = transcripts(home).slice(0, 4);
      for (const p of keep) rowsOf(p, REQUEST_ROWS);
      const gone = join(dir, "gone.jsonl");
      const stale = join(dir, "stale.jsonl");
      for (const p of [gone, stale]) { writeFileSync(p, readFileSync(keep[0])); rowsOf(p, REQUEST_ROWS); }
      rmSync(gone);
      utimesSync(stale, new Date(Date.now() - 200 * 86_400_000), new Date(Date.now() - 200 * 86_400_000));
      const root = join(cache, "transcripts");
      const version = readdirSync(root).find((v) => v.startsWith("v"))!;
      mkdirSync(join(root, "v0-0.0.1", "requests.1"), { recursive: true });
      writeFileSync(join(root, "v0-0.0.1", "requests.1", "x.json"), "{}");
      const tmp = join(root, version, "requests.1", "y.json.1.ab.tmp");
      writeFileSync(tmp, "");
      utimesSync(tmp, new Date(Date.now() - 2 * 3_600_000), new Date(Date.now() - 2 * 3_600_000));
      pruneScanCache(Date.now(), true);
      assert.deepEqual(readdirSync(root).filter((v) => !v.startsWith(".")), [version]);
      const left = readdirSync(join(root, version, "requests.1"));
      assert.equal(left.length, keep.length, "only the entries of transcripts still there and recent");
      // Over the cap: the oldest entries go until 80% of it.
      const total = left.reduce((n, f) => n + statSync(join(root, version, "requests.1", f)).size, 0);
      process.env.CONTEXT_DOCTOR_CACHE_MAX_MB = String(total / 2 / 1024 / 1024);
      try {
        pruneScanCache(Date.now(), true);
      } finally {
        delete process.env.CONTEXT_DOCTOR_CACHE_MAX_MB;
      }
      assert.ok(readdirSync(join(root, version, "requests.1")).length < keep.length);
      // Once a day unless forced.
      writeFileSync(join(root, "v0-0.0.1"), "");
      pruneScanCache(Date.now());
      assert.ok(existsSync(join(root, "v0-0.0.1")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("overlapping runs on one cache agree with each other and with the golden reports, and leave only whole entries", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-scan-conc-"));
  const cache = mkdtempSync(join(tmpdir(), "cd-scan-conc-cache-"));
  try {
    buildHistory(home);
    const args = ["savings", "--json"];
    const want = readFileSync(join(here, "..", "..", "src", "test", "golden", "base", goldenName(args)), "utf8");
    assert.ok(GOLDEN_COMMANDS.some((c) => c.join(" ") === args.join(" ")));
    const runs = await Promise.all(Array.from({ length: 4 }, () => new Promise<string>((resolve) => {
      const p = spawn(process.execPath, [...frozenClock(), join(here, "..", "cli.js"), ...args], { cwd: join(home, "work", "app"), env: cleanEnv(home, { CONTEXT_DOCTOR_CACHE_DIR: cache }) });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("close", (status) => resolve(normalizeOutput(`${out}\n[exit ${status}]\n`, home)));
    })));
    for (const r of runs) assert.equal(r, want);
    const entries = readdirSync(cache, { recursive: true }).map(String).filter((f) => f.endsWith(".json") || f.endsWith(".tmp"));
    assert.ok(entries.length > 0);
    for (const f of entries) {
      assert.ok(f.endsWith(".json"), `no temporary file left: ${f}`);
      assert.doesNotThrow(() => JSON.parse(readFileSync(join(cache, f), "utf8")), f);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

test("uninstall removes the transcript cache, and the cache folder once empty", () => {
  const home = mkdtempSync(join(tmpdir(), "cd-scan-uninst-"));
  try {
    const cache = join(home, ".cache", "context-doctor");
    mkdirSync(join(cache, "transcripts", "v1-x", "requests.1"), { recursive: true });
    writeFileSync(join(cache, "transcripts", "v1-x", "requests.1", "a.json"), "{}");
    const r = spawnSync(process.execPath, [join(here, "..", "cli.js"), "uninstall"], { env: cleanEnv(home), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Removed the transcript cache/);
    assert.ok(!existsSync(cache));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("autopilot's replay resumes from its kept state when a transcript grows, equal to a fresh replay; a missing or mismatched state means a full replay", () => {
  withCache((cache) => {
    const dir = mkdtempSync(join(tmpdir(), "cd-scan-replay-"));
    try {
      const ex = savingsRows(true);
      const full = readFileSync(transcripts(history()).find((p) => /[\\/]s1\.jsonl$/.test(p))!);
      const lines = full.toString("utf8").split("\n").length;
      for (const [label, spoil] of [["kept", () => {}], ["missing", (f: string) => rmSync(f)], ["mismatched", (f: string) => writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), off: 1 }))]] as const) {
        const path = join(dir, `${label}.jsonl`);
        const cut = full.indexOf(10, Math.floor(full.length * 0.8)) + 1;
        writeFileSync(path, full.subarray(0, cut));
        rowsOf(path, ex);
        const states = readdirSync(cache, { recursive: true }).map(String).filter((f) => f.endsWith(".state.json"));
        const state = states.map((f) => join(cache, f)).find((f) => JSON.parse(readFileSync(f, "utf8")).path === path)!;
        assert.ok(state, "a recently written transcript keeps the replay's state");
        spoil(state);
        appendFileSync(path, full.subarray(cut));
        clearScanMemo();
        const c = counting(ex);
        const resumed = rowsOf(path, c);
        assert.deepEqual(resumed, rowsOf(path, ex, { keep: false }), label);
        if (label === "kept") assert.ok(c.lines < lines / 4, `resumed: ${c.lines} of ${lines} lines replayed`);
        else assert.ok(c.lines >= lines - 1, `${label}: replayed in full (${c.lines} of ${lines})`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
