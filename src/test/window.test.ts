/**
 * `--days` counts events, not files: a session touched today brings only
 * today's requests, reads, subagents and compactions into `--days 1`, each
 * by its own timestamp. And repeated reads are per project and file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costPerTask } from "../tasks.js";
import { repeatedReads } from "../reads.js";
import { subagentPayback } from "../subagentpay.js";
import { compactionQuality } from "../compactquality.js";

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;
const OLD = Date.now() - 10 * DAY;
const NEW = Date.now() - 3_600_000;
const usage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 100_000, output_tokens: 0 };

/** A request that runs one Bash command and gets its result. */
function bash(tag: string, at: number, command: string, cwd = "/w/app") {
  const tool = `toolu_${tag}`;
  return [
    { type: "assistant", uuid: `${tag}-a`, cwd, timestamp: iso(at), message: { id: `msg_${tag}`, model: "claude-haiku-4-5", role: "assistant", content: [{ type: "tool_use", id: tool, name: "Bash", input: { command } }], usage } },
    { type: "user", uuid: `${tag}-u`, cwd, timestamp: iso(at + 1000), message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool, content: "ok" }] } },
  ];
}
/** A request that reads one file and gets its contents. */
function read(tag: string, at: number, file: string, cwd: string) {
  const tool = `toolu_${tag}`;
  return [
    { type: "assistant", uuid: `${tag}-a`, cwd, timestamp: iso(at), message: { id: `msg_${tag}`, model: "claude-haiku-4-5", role: "assistant", content: [{ type: "tool_use", id: tool, name: "Read", input: { file_path: file } }], usage } },
    { type: "user", uuid: `${tag}-u`, cwd, timestamp: iso(at + 1000), message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool, content: "export const x = 1;\n".repeat(200) }] } },
  ];
}

test("tasks --days 1: only the day's requests and commits of a long session", () => {
  const p = join(mkdtempSync(join(tmpdir(), "cd-win-")), "s.jsonl");
  writeFileSync(p, jsonl([...bash("old", OLD, "git commit -m old"), ...bash("new", NEW, "git commit -m new"), ...bash("new2", NEW + 60_000, "ls")]));
  const r = costPerTask(1, [p]);
  // Haiku 4.5: 100k cache read at $0.10/M per request, two requests in the day.
  assert.ok(Math.abs(r.usd - (2 * 100_000 * 0.1) / 1e6) < 1e-12, `${r.usd}`);
  assert.equal(r.commits, 1);
  assert.equal(costPerTask(30, [p]).commits, 2);
});

test("reads --days 1: only the day's reads, and only sessions active in the day", () => {
  const d = mkdtempSync(join(tmpdir(), "cd-win-reads-"));
  const s1 = join(d, "s1.jsonl");
  writeFileSync(s1, jsonl([...read("r1", OLD, "/w/app/a.ts", "/w/app"), ...read("r2", NEW, "/w/app/b.ts", "/w/app")]));
  const s2 = join(d, "s2.jsonl");
  writeFileSync(s2, jsonl(read("r3", OLD, "/w/app/a.ts", "/w/app")));
  const r = repeatedReads(1, [s1, s2], 1);
  assert.equal(r.reads, 1);
  assert.equal(r.sessions, 1, "a session with nothing in the day is not one of the day's sessions");
  assert.deepEqual(r.files.map((f) => f.path), ["/w/app/b.ts"]);
});

test("reads: the same file read from two projects is counted per project", () => {
  const d = mkdtempSync(join(tmpdir(), "cd-win-proj-"));
  const paths = [
    // One session of project B reads the shared file...
    ["b1", "/w/b"],
    // ...and so do the three sessions of project A.
    ["a1", "/w/a"],
    ["a2", "/w/a"],
    ["a3", "/w/a"],
  ].map(([name, cwd]) => {
    const p = join(d, `${name}.jsonl`);
    writeFileSync(p, jsonl(read(name, NEW, "/shared/README.md", cwd)));
    return p;
  });
  const r = repeatedReads(30, paths, 3);
  assert.equal(r.files.length, 1, "read in 3 sessions of A; once in B is not repeated");
  assert.equal(r.files[0].project, "/w/a");
  assert.equal(r.files[0].sessions, 3);
  assert.equal(r.files[0].projectSessions, 3);
  for (const f of repeatedReads(30, paths, 1).files) assert.ok(f.sessions <= f.projectSessions, `${f.sessions}/${f.projectSessions} sessions`);
});

test("subagents --days 1: only the subagents that started in the day", () => {
  const d = mkdtempSync(join(tmpdir(), "cd-win-subs-"));
  const parent = join(d, "s.jsonl");
  writeFileSync(parent, jsonl([...bash("p1", OLD, "ls"), ...bash("p2", NEW, "ls")]));
  mkdirSync(join(d, "s", "subagents"), { recursive: true });
  for (const [id, at] of [["old", OLD], ["new", NEW]] as const) {
    writeFileSync(
      join(d, "s", "subagents", `agent-${id}.jsonl`),
      jsonl([
        { type: "user", isSidechain: true, timestamp: iso(at), message: { content: `task ${id}` } },
        { type: "assistant", isSidechain: true, timestamp: iso(at + 1000), message: { id: `sub_${id}`, model: "claude-haiku-4-5", usage } },
      ])
    );
  }
  const r = subagentPayback(1, [parent]);
  assert.deepEqual(r.subagents.map((a) => a.task), ["task new"]);
  assert.equal(subagentPayback(30, [parent]).subagents.length, 2);
});

test("compactions --days 2: a compaction from ten days ago is not in the window", () => {
  const rows: unknown[] = [];
  for (let i = 0; i < 10; i++) rows.push(...read(`b${i}`, OLD + i * 60_000, `/w/f${i}.ts`, "/w"));
  rows.push({ type: "system", subtype: "compact_boundary", uuid: "cb", timestamp: iso(OLD + 11 * 60_000) });
  for (let i = 0; i < 10; i++) rows.push(...read(`c${i}`, OLD + (12 + i) * 60_000, `/w/f${i}.ts`, "/w"));
  rows.push(...bash("today", NEW, "ls", "/w"));
  const p = join(mkdtempSync(join(tmpdir(), "cd-win-cq-")), "s.jsonl");
  writeFileSync(p, jsonl(rows));
  assert.equal(compactionQuality(2, [p]).compactions, 0);
  assert.equal(compactionQuality(30, [p]).compactions, 1);
});
