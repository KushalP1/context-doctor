/**
 * A bare `context-doctor` in a terminal with history: fix's plan on one
 * screen, the quality-free fixes under one y/N question applied through
 * applyFix (the same writes and records as `fix --apply <ids>`), the others
 * with their dollars and the command for each. `n`, Ctrl-D and a stdin that
 * is not a terminal change nothing; piped, it is the Start here screen.
 *
 * The terminal is a real pseudo-terminal (Python's pty), where one is
 * available (not on Windows); the plan's grouping is tested everywhere.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFixIds, planFixes, type FixInputs } from "../fix.js";
import { firstQuestion, renderFirstScreen, splitFirstFixes } from "../firstfix.js";
import type { ToolOutputReplay } from "../tooloutput.js";
import type { ProjectPlan } from "../prune.js";
import { buildHistory, frozenClock, normalizeOutput } from "./history-fixture.js";
import { cleanEnv } from "./golden-run.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const cmd = (s: string) => `context-doctor ${s}`;

const hasPty =
  platform() !== "win32" && spawnSync("python3", ["-c", "import pty"], { stdio: "ignore", timeout: 10_000 }).status === 0;

// -- The grouping, on a plan made from measurements (no machine's history) ---------------

const ttl = (billedUsd: number, at5mUsd: number, at1hUsd: number) => ({ transcripts: 3, requests: 100, billedUsd, at5mUsd, at1hUsd, oneHourShare: 0.5, keptWarmAt1h: 5, wentColdAt5m: 0, unpriced: 0 });
function toolOutput(savedUsd: number): ToolOutputReplay {
  const cap = (c: number, saved: number) => ({ cap: c, moved: 100, results: 1000, tokens: 1e6, savedUsd: saved, openUsd: saved / 4 });
  return { transcripts: 3, requests: 900, billedUsd: 2000, alreadyMoved: 4, bash: [cap(8_000, savedUsd), cap(12_000, savedUsd / 2)], mcp: { cap: 10_000, moved: 2, results: 50, tokens: 1, savedUsd: 0.4, openUsd: 0.1 }, recommended: 8_000 };
}
const inputs: FixInputs = {
  days: 30,
  billedUsd: 2000,
  compactWindow: { window: 400_000, savedUsd: 854, savedShare: 0.44, compactionsPerWeek: 9, nowPerWeek: 3 },
  ttl: { days: 30, main: ttl(2000, 2400, 1835), subagents: ttl(100, 100, 120) },
  currentTtl: { overrides: [] },
  autopilot: { on: false, reachableUsd: 40, reachableShare: 0.02, unreachableSessions: 0, sessions: 3 },
  toolSearchOff: "false",
  mcpServers: 2,
  prune: { cwd: "/work/app", sessions: 8, unused: [{ kind: "mcp", name: "unused" } as ProjectPlan["unused"][number]], used: [], thin: false, alreadyOff: [] },
  subagentModel: {
    candidate: "claude-sonnet-5-5", agents: 168, requests: 9000, billedUsd: 1582, atCandidateUsd: 669, savedUsd: 913, unpriced: 0, movedFrom: { "claude-opus-5-5": 900 }, before: { "claude-opus-5-5": 450 },
    byType: [{ type: "general-purpose", agents: 160, requests: 8000, billedUsd: 1500, atCandidateUsd: 587, atHaikuUsd: 30, over100k: 10, moves: true, readOnly: false }],
  },
  toolOutput: toolOutput(294),
};

test("the quality-free set is the levers whose quality line is none: never compacting, autopilot or the subagents' model", () => {
  const fixes = planFixes(inputs);
  const { free, other } = splitFirstFixes(fixes);
  assert.deepEqual(free.map((f) => f.id), ["tool-output", "cache-ttl", "tool-search", "prune"]);
  assert.deepEqual(other.map((f) => f.id), ["subagent-model", "compact-window", "autopilot"]);
  // The mark follows the quality line: "none", or output moved where the model can still open it.
  for (const f of free) assert.ok(/^none/.test(f.quality) || f.id === "tool-output", `${f.id}: ${f.quality}`);
  for (const f of other) assert.ok(!/^none\b/.test(f.quality), `${f.id}: ${f.quality}`);
});

test("progress summaries off joins the one question by its own mark, and --apply all agrees with the set", () => {
  const fixes = planFixes({ ...inputs, progressSummaries: { agents: 40, summarized: 30, calls: 900, notesUsd: 74, forkUsd: 463, none: {}, hosts: [] } });
  const { free } = splitFirstFixes(fixes);
  assert.ok(free.some((f) => f.id === "progress-summaries"));
  assert.match(renderFirstScreen({ days: 30, billedUsd: 2000, fixes, command: cmd, ask: true }), /^ +\$74\.00  Subagent progress summaries off$/m);
  // Every quality-free fix is one `--apply all` applies too (the subagents' model, never in all, is never quality-free).
  const all = new Set(parseFixIds("all", fixes).ids);
  for (const f of free) assert.ok(all.has(f.id), f.id);
});

test("the screen: one total for the quality-free fixes, one line each, the others with their dollars and command, under 25 lines", () => {
  const fixes = planFixes(inputs);
  const text = renderFirstScreen({ days: 30, billedUsd: 2000, fixes, command: cmd, ask: true });
  const lines = text.split("\n");
  assert.ok(lines.length < 25, `${lines.length} lines`);
  assert.equal(lines[0], "context-doctor: your last 30 days of Claude Code, $2,000 of input at list prices");
  // $294 + $165, measured one by one: the overlap is said.
  assert.match(text, /^Free of any quality cost: \$459 a month \(2 more not priced\)$/m);
  assert.match(text, /^ +\$294  Long Bash output to a file past 8k characters$/m);
  assert.match(text, /^ +\$165  Cache lifetime, main conversation: 1 hour$/m);
  assert.match(text, /^ +not priced  MCP tool search back on$/m);
  assert.match(text, /each measured alone; they overlap, so together a little less/);
  assert.match(text, /^These trade something for money; read each in context-doctor fix first:$/m);
  assert.match(text, /^ +\$913  Subagents on Sonnet 5\.5, not Opus 5\.5 +context-doctor fix --apply subagent-model$/m);
  assert.match(text, /^ +\$854  Compact earlier: auto-compact window 400k +context-doctor fix --apply compact-window$/m);
  assert.match(text, /^ +\$40\.00  Autopilot: .* +context-doctor fix --apply autopilot$/m);
  // The question follows; nothing else says how to apply them.
  assert.ok(!/Apply them:/.test(text));
  assert.equal(firstQuestion(4, cmd), "Apply these 4 fixes? (undo any time: context-doctor fix undo) [y/N] ");
  assert.equal(firstQuestion(1, cmd), "Apply this fix? (undo any time: context-doctor fix undo) [y/N] ");
  // Not a terminal to ask in: the command that applies them, never a question.
  const printed = renderFirstScreen({ days: 30, billedUsd: 2000, fixes, command: cmd, ask: false });
  assert.match(printed.split("\n").at(-1)!, /^Apply them: context-doctor fix --apply tool-output,cache-ttl,tool-search,prune \(undo any time: context-doctor fix undo\)$/);
});

test("nothing quality-free to apply: one line that says so and points at fix; no history: one line too", () => {
  const fixes = planFixes({ ...inputs, toolOutput: undefined, ttl: undefined, toolSearchOff: undefined, prune: undefined });
  const text = renderFirstScreen({ days: 30, billedUsd: 2000, fixes, command: cmd, ask: true });
  assert.equal(text.split("\n").filter((l) => /Nothing to apply/.test(l)).length, 1);
  assert.match(text, /^Nothing to apply without a quality cost here; context-doctor fix shows every lever, measured\.$/m);
  assert.ok(!/Free of any quality cost/.test(text));
  assert.match(text, /\$854  Compact earlier/);
  const none = renderFirstScreen({ days: 30, billedUsd: 0, fixes: [], command: cmd, ask: true });
  assert.equal(none.split("\n").length, 2);
  assert.match(none, /No Claude Code sessions in the last 30 days/);
});

test("a fix already applied is named once, with where its saving since is shown", () => {
  const fixes = planFixes({ ...inputs, currentTtl: { main: "1h", overrides: [] } });
  const text = renderFirstScreen({ days: 30, billedUsd: 2000, fixes, command: cmd, ask: true });
  assert.match(text, /^Applied before: cache-ttl; context-doctor fix shows what each saved since\.$/m);
  assert.ok(!/Cache lifetime, main conversation/.test(text));
});

// -- On the fixture history, through a terminal ----------------------------------------------

/** A throwaway home with the fixture history, MCP tool search switched off (a second quality-free fix), and its own cache. */
function fixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), "cd-first-"));
  buildHistory(home);
  writeFileSync(join(home, ".claude", "settings.json"), '{\n  "env": { "ENABLE_TOOL_SEARCH": "false" }\n}\n');
  return home;
}

const envFor = (home: string) => cleanEnv(home, { CONTEXT_DOCTOR_CACHE_DIR: join(home, ".cd-cache") });

/**
 * A bare run with stdout (and, unless `stdin` names a file, stdin) on a
 * pseudo-terminal; `input` is what is typed. stderr goes to /dev/null, so the
 * progress line stays out of the screen.
 */
function inTerminal(home: string, input: string, stdin?: string, args: string[] = []) {
  const node = [process.execPath, ...frozenClock(), cli, ...args];
  const sh = `exec "$@" 2>/dev/null${stdin ? ` <${stdin}` : ""}`;
  const r = spawnSync("python3", ["-c", "import os, pty, sys; status = pty.spawn(sys.argv[1:]); sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else status >> 8)", "sh", "-c", sh, "sh", ...node], {
    cwd: join(home, "work", "app"), env: envFor(home), encoding: "utf8", input, timeout: 60_000,
  });
  // The terminal's line ends and readline's cursor moves, and the typed answer the terminal echoes before the prompt.
  const screen = normalizeOutput((r.stdout ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r\n/g, "\n").replace(/\r/g, ""), home).replace(/^[^\n]*\n(?=context-doctor:)/, "");
  return { ...r, screen };
}

/** Every file under home except the transcript cache, path to bytes. */
function snapshot(home: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (p === join(home, ".cd-cache")) continue;
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(home, p), readFileSync(p, "latin1"));
    }
  };
  walk(home);
  return out;
}

function assertUnchanged(before: Map<string, string>, home: string, what: string) {
  const after = snapshot(home);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), `${what}: no file added or removed`);
  for (const [k, v] of before) assert.equal(after.get(k), v, `${what}: ${k} unchanged`);
}

const SCREEN = `context-doctor: your last 30 days of Claude Code, $127 of input at list prices

Free of any quality cost: 2 fixes, not priced
  not priced  MCP tool search back on
  not priced  Switch off 1 unused MCP server or skill in this project

These trade something for money; read each in context-doctor fix first:
      $13.31  Compact earlier: auto-compact window 400k                   context-doctor fix --apply compact-window
       $3.64  Autopilot: clear stale tool output when the cache is cold   context-doctor fix --apply autopilot
       $2.45  Subagents on Sonnet 5.5, not Opus 5.5                       context-doctor fix --apply subagent-model

The full report: context-doctor savings. All commands: context-doctor --help
`;

test("fixture, stdin not a terminal: the screen (golden), under 25 lines and 15 s cold, printed only: nothing written", { skip: !hasPty && "needs python3's pty module" }, () => {
  const home = fixtureHome();
  const before = snapshot(home);
  const t0 = Date.now();
  const r = inTerminal(home, "", "/dev/null");
  const ms = Date.now() - t0;
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.screen, `${SCREEN}Apply them: context-doctor fix --apply tool-search,prune (undo any time: context-doctor fix undo)\n`);
  assert.ok(r.screen.trimEnd().split("\n").length < 25);
  assert.ok(ms < 15_000, `${ms} ms cold`);
  assertUnchanged(before, home, "print only");
});

test("fixture, y: exactly the quality-free set applied, byte for byte as fix --apply writes it; fix undo puts it all back", { skip: !hasPty && "needs python3's pty module" }, () => {
  const home = fixtureHome();
  const original = snapshot(home);
  const r = inTerminal(home, "y\n");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.screen.startsWith(`${SCREEN}Apply these 2 fixes? (undo any time: context-doctor fix undo) [y/N] y`), r.screen);
  assert.match(r.screen, /✓ ~\/\.claude\/settings\.json: env\.ENABLE_TOOL_SEARCH = "auto"/);
  assert.match(r.screen, /✓ switched off in ~\/work\/app\/\.claude\/settings\.local\.json: unused/);
  assert.match(r.screen, /Undo: context-doctor fix undo/);

  // The same history, the same ids through fix --apply: the same files, the same records.
  const twin = fixtureHome();
  const f = spawnSync(process.execPath, [...frozenClock(), cli, "fix", "--apply", "tool-search,prune"], { cwd: join(twin, "work", "app"), env: envFor(twin), encoding: "utf8", input: "", timeout: 60_000 });
  assert.equal(f.status, 0, f.stdout + f.stderr);
  const a = snapshot(home), b = snapshot(twin);
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort());
  const changed = [...a.keys()].filter((k) => a.get(k) !== original.get(k)).sort();
  assert.deepEqual(changed.map((k) => k.replace(/\\/g, "/")), [".claude/.context-doctor-fixes.json", ".claude/.context-doctor-pruned.json", ".claude/settings.json", "work/app/.claude/settings.local.json"]);
  for (const k of changed) assert.equal(normalizeOutput(a.get(k)!, home), normalizeOutput(b.get(k)!, twin), k);
  const records = JSON.parse(a.get(join(".claude", ".context-doctor-fixes.json"))!).fixes.map((x: { id: string }) => x.id);
  assert.deepEqual(records, ["tool-search", "prune"]);

  const u = spawnSync(process.execPath, [cli, "fix", "undo"], { cwd: join(home, "work", "app"), env: envFor(home), encoding: "utf8", timeout: 60_000 });
  assert.equal(u.status, 0, u.stdout + u.stderr);
  const undone = snapshot(home);
  for (const [k, v] of original) assert.equal(undone.get(k), v, `${k} back as it was`);
  assert.ok(!existsSync(join(home, ".claude", ".context-doctor-fixes.json")));
});

test("fixture, n or Ctrl-D: nothing changes", { skip: !hasPty && "needs python3's pty module" }, () => {
  for (const [what, input] of [["n", "n\n"], ["Enter", "\n"], ["Ctrl-D", "\x04"]] as const) {
    const home = fixtureHome();
    const before = snapshot(home);
    const r = inTerminal(home, input);
    assert.equal(r.error, undefined, `${what}: it must not wait until the timeout`);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.screen, /Apply these 2 fixes\?/);
    assert.match(r.screen, /Nothing changed\. context-doctor fix asks about each lever/);
    assertUnchanged(before, home, what);
  }
});

test("fixture, piped (no terminal at all): the Start here screen, nothing measured or written; --json is the savings report as before", () => {
  const home = fixtureHome();
  const before = snapshot(home);
  const r = spawnSync(process.execPath, [...frozenClock(), cli], { cwd: join(home, "work", "app"), env: envFor(home), encoding: "utf8", input: "y\n", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^context-doctor: see where your Claude Code tokens go/);
  assert.ok(!/Apply/.test(r.stdout));
  assertUnchanged(before, home, "piped");
});

test("fixture, a bare --json in a terminal is still the savings report", { skip: !hasPty && "needs python3's pty module" }, () => {
  const home = fixtureHome();
  const r = inTerminal(home, "", "/dev/null", ["--json"]);
  assert.equal(r.status, 0, r.stdout);
  const j = JSON.parse(r.screen.slice(r.screen.indexOf("{")));
  assert.ok(Array.isArray(j.sessions) && typeof j.billedUsd === "number" && typeof j.reachableUsd === "number");
});
