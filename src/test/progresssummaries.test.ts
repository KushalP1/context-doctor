/**
 * Subagent progress summaries: the estimate (who gets them, how often, what
 * each costs both ways), `spend`'s line beside the total, the gap it
 * explains in the mod's cost ledger, and fix's `progress-summaries` lever
 * (offered, applied and undone byte for byte, a value you set left alone).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eligibility, estimateProgressSummaries, FORK_PROMPT_TOKENS, NOTES_TOKENS, simulateAgent, SUMMARY_OUTPUT_TOKENS, type ProgressSummaryEstimate } from "../progresssummaries.js";
import { requestCost } from "../pricing.js";
import { renderSpend, renderSpendShare, spendReport } from "../spend.js";
import { costGaps } from "../modmeasure.js";
import { applyFix, fixOverrides, parseFixIds, planFixes, progressSummariesSavedSince, progressSummariesState, readFixRecords, renderFixPlan, savedSince, undoFixes, type FixInputs } from "../fix.js";

process.env.CONTEXT_DOCTOR_CACHE_DIR = mkdtempSync(join(tmpdir(), "cd-ps-cache-"));

const OPUS = "claude-opus-5-5";
const T0 = Date.parse("2026-11-10T10:00:00.000Z");
const NOW = Date.parse("2026-11-12T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const near = (a: number, b: number, what = "") => assert.ok(Math.abs(a - b) < 1e-9, `${what} ${a} vs ${b}`);

interface AgentSpec { id: string; start: number; steps: number; stepMs: number; entrypoint?: string; version?: string; meta?: Record<string, unknown> | null; prompt0?: number; grow?: number }

/** A subagent transcript: its prompt, then per step a reply (prompt growing by `grow`) and a tool result 1 s later. */
function agentRows(a: AgentSpec, session: string): string {
  const head = { sessionId: session, agentId: a.id, isSidechain: true, entrypoint: a.entrypoint ?? "cli", version: a.version ?? "2.1.321", cwd: "/p" };
  const rows: unknown[] = [{ ...head, type: "user", uuid: `${a.id}-u0`, timestamp: iso(a.start), message: { role: "user", content: "do it" } }];
  for (let k = 0; k < a.steps; k++) {
    const at = a.start + (k + 1) * a.stepMs;
    const prompt = (a.prompt0 ?? 20_000) + k * (a.grow ?? 2_000);
    rows.push({ ...head, type: "assistant", uuid: `${a.id}-a${k}`, timestamp: iso(at), message: { id: `msg_${a.id}_${k}`, role: "assistant", model: OPUS, content: [{ type: "tool_use", id: `t${k}`, name: "Bash", input: {} }], usage: { input_tokens: 10, cache_read_input_tokens: prompt - 510, cache_creation_input_tokens: 500, output_tokens: 100 } } });
    rows.push({ ...head, type: "user", uuid: `${a.id}-r${k}`, timestamp: iso(at + 1000), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${k}`, content: "ok" }] } });
  }
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

/** A Claude Code project with one session (a main reply) and its subagents; the paths of the main transcript and each agent. */
function history(home: string, session: string, agents: AgentSpec[], entrypoint = "cli"): { main: string; agents: string[] } {
  const dir = join(home, ".claude", "projects", "-p");
  mkdirSync(join(dir, session, "subagents"), { recursive: true });
  const main = join(dir, `${session}.jsonl`);
  writeFileSync(main, JSON.stringify({ type: "assistant", sessionId: session, entrypoint, version: "2.1.321", uuid: `${session}-m`, timestamp: iso(T0), message: { id: `msg_${session}_main`, role: "assistant", model: OPUS, content: [{ type: "text", text: "hi" }], usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000, output_tokens: 10 } } }) + "\n");
  const files: string[] = [];
  for (const a of agents) {
    const f = join(dir, session, "subagents", `agent-${a.id}.jsonl`);
    writeFileSync(f, agentRows(a, session));
    if (a.meta !== null) writeFileSync(f.replace(/\.jsonl$/, ".meta.json"), JSON.stringify(a.meta ?? { agentType: "general-purpose", requestShape: "background", requestNonInteractive: true }));
    files.push(f);
  }
  for (const f of [main, ...files]) utimesSync(f, new Date(NOW - 3_600_000), new Date(NOW - 3_600_000));
  return { main, agents: files };
}

test("the timer: one summary per 30 s tick while the transcript changed, none before 3 messages or after the agent ends", () => {
  const home = mkdtempSync(join(tmpdir(), "cd-ps-sim-"));
  // Steps every 10 s for 100 s: rows at 0, 10, 11, 20, 21, ... 100, 101.
  const { agents } = history(home, "s1", [{ id: "a1", start: T0, steps: 10, stepMs: 10_000 }]);
  const e = estimateProgressSummaries(agents);
  // Ticks at 30, 60, 90 s: each finds new rows. The one at 120 s is after the last row (101 s).
  assert.equal(e.calls, 3);
  assert.equal(e.summarized, 1);
  // The tick at 30 s: the reply at 30 s is the last one (prompt 22,000 + ... ), the next one's prompt says what came after it.
  const fork = (read: number, next: number, at: number) => requestCost(OPUS, { input_tokens: next - read + FORK_PROMPT_TOKENS, cache_read_input_tokens: read, cache_creation_input_tokens: 0, output_tokens: SUMMARY_OUTPUT_TOKENS }, at)!.totalUsd;
  const notes = (at: number) => requestCost(OPUS, { input_tokens: NOTES_TOKENS, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: SUMMARY_OUTPUT_TOKENS }, at)!.totalUsd;
  const p = (k: number) => 20_000 + k * 2_000;
  near(e.forkUsd, fork(p(2), p(3), T0 + 30_000) + fork(p(5), p(6), T0 + 60_000) + fork(p(8), p(9), T0 + 90_000), "fork");
  near(e.notesUsd, 3 * notes(T0 + 30_000), "notes");
  assert.ok(e.forkUsd > e.notesUsd, "a 20k+ context read costs more than 1,850 fresh tokens");

  // A long blocking call: the transcript does not change, so the ticks in it send nothing.
  const recs = [
    { t: "m" as const, ts: T0 }, { t: "m" as const, ts: T0 + 1_000 }, { t: "r" as const, ts: T0 + 2_000, model: OPUS, p: 30_000 }, { t: "m" as const, ts: T0 + 2_000 },
    { t: "m" as const, ts: T0 + 200_000 }, { t: "r" as const, ts: T0 + 201_000, model: OPUS, p: 31_000 }, { t: "m" as const, ts: T0 + 201_000 },
  ];
  // Ticks 30..180 s: the first finds 3 messages, the next five find the same 3; 210 s is past the end (201 s).
  assert.equal(simulateAgent(recs).calls, 1);
  // Under 3 messages by the first tick, and an agent shorter than 30 s: none.
  assert.equal(simulateAgent(recs.slice(0, 2)).calls, 0);
  assert.equal(simulateAgent([{ t: "m", ts: T0 }, { t: "m", ts: T0 + 1 }, { t: "r", ts: T0 + 2, model: OPUS, p: 9 }, { t: "m", ts: T0 + 29_000 }]).calls, 0);
  // Only ticks inside the window count.
  assert.equal(estimateProgressSummaries(agents, { since: T0 + 45_000 }).calls, 2);
  assert.equal(estimateProgressSummaries(agents, { until: T0 + 45_000 }).calls, 1);
  // An agent that ran wholly outside the window is not counted at all.
  assert.equal(estimateProgressSummaries(agents, { since: T0 + 3_600_000 }).agents, 0);
});

test("who gets them (2.1.321): background subagents in a terminal session, and background forks anywhere", () => {
  const bg = { agentType: "general-purpose", requestShape: "background" };
  assert.equal(eligibility(bg, "cli"), "yes");
  // The Desktop app runs Claude Code through the SDK: not interactive, and it never asks for them.
  assert.equal(eligibility(bg, "claude-desktop"), "host");
  assert.equal(eligibility(bg, "sdk-cli"), "host");
  assert.equal(eligibility(bg, "claude-vscode"), "host");
  assert.equal(eligibility({ ...bg, isFork: true }, "claude-desktop"), "yes");
  assert.equal(eligibility({ agentType: "general-purpose", requestShape: "foreground" }, "cli"), "foreground");
  assert.equal(eligibility({ agentType: "general-purpose" }, "cli"), "unknown", "before 2.1.266 no shape is recorded");
  assert.equal(eligibility(undefined, "cli"), "unknown");
  assert.equal(eligibility(bg, "cli", { workflow: true }), "workflow");
  assert.equal(eligibility({ agentType: "workflow-subagent", requestShape: "foreground" }, "cli"), "workflow");
  assert.equal(eligibility(bg, "cli", { forkGateOff: true }), "fork-gate-off");
  assert.equal(eligibility({ ...bg, isFork: true }, "cli", { forkGateOff: true }), "yes");
  assert.equal(eligibility(bg, "claude-desktop", { interactive: () => true }), "yes", "a measurement can ask what a terminal would have cost");

  const home = mkdtempSync(join(tmpdir(), "cd-ps-who-"));
  const a = (id: string, meta?: Record<string, unknown> | null, entrypoint?: string) => ({ id, start: T0, steps: 10, stepMs: 10_000, meta, entrypoint });
  const { agents } = history(home, "s2", [a("b1"), a("b2", undefined, "claude-desktop"), a("b3", { agentType: "general-purpose", requestShape: "foreground" }), a("b4", null)]);
  const e = estimateProgressSummaries(agents);
  assert.deepEqual([e.agents, e.summarized, e.calls], [4, 1, 3]);
  assert.deepEqual(e.none, { host: 1, foreground: 1, unknown: 1 });
  assert.deepEqual(e.hosts, ["claude-desktop"]);
});

test("the variable: after fix set it, a Claude Code that reads it (2.1.318+) wrote none; savedSince counts what it stopped", () => {
  const home = mkdtempSync(join(tmpdir(), "cd-ps-off-"));
  const set = T0 + 3_600_000;
  const { agents } = history(home, "s3", [
    { id: "c1", start: T0, steps: 10, stepMs: 10_000 },
    { id: "c2", start: set + 60_000, steps: 10, stepMs: 10_000 },
    { id: "c3", start: set + 60_000, steps: 10, stepMs: 10_000, version: "2.1.317" },
  ]);
  const e = estimateProgressSummaries(agents, { offSince: set });
  // c1 ran before it was set; c3's Claude Code predates the variable and ignored it.
  assert.deepEqual([e.summarized, e.calls, e.none.off], [2, 6, 1]);
  const s = progressSummariesSavedSince(set, agents);
  assert.deepEqual([s.summarized, s.calls, s.none.old], [1, 3, 1]);
});

test("spend: shown beside the total as a range, never inside it; none for the Desktop app; not estimated when set with no record", () => {
  const home = mkdtempSync(join(tmpdir(), "cd-ps-spend-"));
  const { main } = history(home, "s4", [{ id: "d1", start: T0, steps: 30, stepMs: 10_000, prompt0: 80_000 }]);
  const r = spendReport(3, { claudePaths: [main], now: NOW });
  const off = spendReport(3, { claudePaths: [main], now: NOW, progress: false });
  near(r.usd, off.usd, "the total");
  const ps = r.progressSummaries;
  assert.ok(ps && "calls" in ps);
  assert.equal(ps.agents, 1);
  assert.equal(ps.calls, 10);
  assert.ok(ps.notesUsd > 0 && ps.forkUsd > ps.notesUsd);
  const text = renderSpend(r);
  assert.match(text, /Not in it: ~10 subagent progress summaries \(1 background agent\), an estimate:\n {2}\$0\.\d\d as notes, \$\d\.\d\d at the whole context; no transcript records them/);
  for (const l of text.split("\n").filter((x) => /progress summaries|as notes/.test(x))) assert.ok(l.length <= 80, l);
  assert.match(renderSpendShare(r), /Not in it: Claude Code's subagent progress summaries, which no transcript records: \$0\.\d\d-\$\d\.\d\d, an estimate\./);
  assert.equal(off.progressSummaries, undefined);
  assert.doesNotMatch(renderSpend(off), /progress summaries/);
  // Set by the user (no record of when): not estimated, and said so.
  const set = spendReport(3, { claudePaths: [main], now: NOW, progress: { set: "~/.claude/settings.json env" } });
  assert.deepEqual(set.progressSummaries, { set: "~/.claude/settings.json env" });
  assert.match(renderSpend(set), /Subagent progress summaries: not estimated, CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES is set in ~\/\.claude\/settings\.json env/);
  // Set by fix before these ran: none.
  assert.equal(spendReport(3, { claudePaths: [main], now: NOW, progress: { set: "x", offSince: T0 - 1 } }).progressSummaries, undefined);
  // The same agent in the Desktop app: none written, nothing shown.
  const desk = mkdtempSync(join(tmpdir(), "cd-ps-desk-"));
  const d = history(desk, "s5", [{ id: "d2", start: T0, steps: 30, stepMs: 10_000, entrypoint: "claude-desktop" }], "claude-desktop");
  assert.equal(spendReport(3, { claudePaths: [d.main], now: NOW }).progressSummaries, undefined);
});

test("the mod's ledger: Claude Code's cost above ours by the summaries it billed; the estimate brackets the gap", () => {
  const home = mkdtempSync(join(tmpdir(), "cd-ps-gap-"));
  const { main } = history(home, "s6", [{ id: "g1", start: T0, steps: 60, stepMs: 10_000, prompt0: 40_000, grow: 1_500 }]);
  const r = spendReport(3, { claudePaths: [main], now: NOW });
  const ours = r.sessions.reduce((s, x) => s + x.usd, 0);
  const ps = r.progressSummaries as { calls: number; notesUsd: number; forkUsd: number };
  // What Claude Code counted, as the mod's ledger would hold it: our requests plus one summary a tick, as served
  // (notes on the agent's model; here a little shorter than the estimate's 1,850 tokens and 65 of output).
  const billed = ps.calls * requestCost(OPUS, { input_tokens: 1_700, output_tokens: 30 }, T0)!.totalUsd;
  const [gap] = costGaps([{ ts: NOW, sid: "s6", cc: ours + billed, cd: ours }]);
  assert.ok(gap.gap < 0, "ours is under Claude Code's");
  const missing = gap.cc - gap.cd;
  assert.ok(missing <= ps.forkUsd && missing <= ps.notesUsd * 1.2 && missing >= ps.notesUsd * 0.8, `${missing} vs ${ps.notesUsd}-${ps.forkUsd}`);
  // With the estimate added the session is within the K2 target (2%).
  assert.ok(Math.abs((ours + ps.notesUsd - gap.cc) / gap.cc) < 0.02);
});

/** An estimate whose figures the plan tests choose. */
const estimate = (notesUsd: number, forkUsd = notesUsd * 6, over: Partial<ProgressSummaryEstimate> = {}): ProgressSummaryEstimate => ({ agents: 40, summarized: 30, calls: 4_000, notesUsd, forkUsd, none: {}, hosts: [], ...over });
const base: FixInputs = { days: 30, billedUsd: 2000 };

test("fix: offered at the notes' figure with what the user loses, in --apply all; a value set is named; none in the Desktop app", () => {
  const fixes = planFixes({ ...base, progressSummaries: estimate(42, 300), subagentModel: { candidate: "claude-sonnet-5-5", agents: 40, requests: 9000, billedUsd: 600, atCandidateUsd: 600, savedUsd: 0, unpriced: 0, movedFrom: {}, before: {}, byType: [] } });
  assert.equal(fixes.length, 1);
  const f = fixes[0];
  assert.equal(f.id, "progress-summaries");
  assert.equal(f.state, "available");
  assert.equal(f.savedUsd, 42);
  near(f.savedShare!, 42 / 600);
  assert.equal(f.value, "1");
  assert.match(f.quality, /none to the work: a summary never enters the subagent's context; you lose the 3-5 word progress line/);
  assert.match(f.basis, /4,000 summaries for 30 background subagents/);
  assert.match(f.basis, /an estimate/);
  assert.match(f.basis, /\$300 if each sent the whole context/);
  assert.match(f.change, /env\.CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES = "1" \(Claude Code 2\.1\.318\+\)/);
  const text = renderFixPlan(30, 2000, fixes, []);
  assert.match(text, /1\. Subagent progress summaries off +\$42\.00 \(7% of subagents\)/);
  // Quality-free: --apply all applies it.
  assert.deepEqual(parseFixIds("all", fixes).ids, ["progress-summaries"]);
  // Under a dollar: not offered.
  assert.deepEqual(planFixes({ ...base, progressSummaries: estimate(0.5) }), []);
  // Too old a Claude Code here is named.
  const old = planFixes({ ...base, progressSummaries: estimate(42), claudeCodeInstalls: [{ version: "2.1.317", path: "/opt/claude", source: "cli" }] });
  assert.match(old[0].tooOld!, /predates this setting \(Claude Code 2\.1\.318\+\)/);
  // Set by the user: applied when it turns them off, left alone when it keeps them.
  const on = planFixes({ ...base, progressSummaries: estimate(42), progressSummariesSet: { value: "1", where: "~/.claude/settings.json env" } });
  assert.deepEqual(on.map((x) => [x.id, x.state]), [["progress-summaries", "applied"]]);
  const keep = planFixes({ ...base, progressSummaries: estimate(42), progressSummariesSet: { value: "0", where: "the environment" } });
  assert.equal(keep[0].state, "not-here");
  assert.match(renderFixPlan(30, 2000, keep, []), /- Subagent progress summaries: CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES=0 in the environment: left as you set it \(turning them off would have saved about \$42\.00\)/);
  // Every background subagent ran in the Desktop app: said, nothing offered.
  const desk = planFixes({ ...base, progressSummaries: estimate(0, 0, { summarized: 0, calls: 0, none: { host: 243 }, hosts: ["claude-desktop"] }) });
  assert.equal(desk[0].state, "not-here");
  assert.match(renderFixPlan(30, 2000, desk, []), /- Subagent progress summaries: your 243 background subagents ran in the Desktop app, where Claude Code writes no progress summaries: nothing to turn off/);
  // It overlaps the subagents' model.
  const both = planFixes({ ...base, progressSummaries: estimate(42), subagentModel: { candidate: "claude-sonnet-5-5", agents: 40, requests: 9000, billedUsd: 600, atCandidateUsd: 300, savedUsd: 300, unpriced: 0, movedFrom: { [OPUS]: 1 }, before: { [OPUS]: 1 }, byType: [{ type: "general-purpose", agents: 40, requests: 9000, billedUsd: 600, atCandidateUsd: 300, atHaikuUsd: 30, over100k: 0, moves: true, readOnly: false }] } });
  assert.match(renderFixPlan(30, 2000, both, []), /progress-summaries and subagent-model: the progress summaries run on the subagents' model/);
});

test("fix: apply then undo puts settings.json back byte for byte; a value you set, in the file or the shell, is never overwritten", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-ps-rt-"));
  mkdirSync(join(home, ".claude"));
  const settings = join(home, ".claude", "settings.json");
  const [fix] = planFixes({ ...base, progressSummaries: estimate(42) });
  const deps = { home, now: 5_000, env: {} as NodeJS.ProcessEnv, cwd: home };
  for (const original of [undefined, '{\r\n    "model": "opus",\r\n    "env": {\r\n        "FOO": "1"\r\n    }\r\n}\r\n', '{"theme":"dark"}']) {
    if (original === undefined) assert.ok(!existsSync(settings));
    else writeFileSync(settings, original);
    const r = await applyFix(fix, deps);
    assert.equal(r.ok, true, r.lines.join("\n"));
    assert.equal(JSON.parse(readFileSync(settings, "utf8")).env.CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES, "1");
    const rec = readFixRecords(home).find((x) => x.id === "progress-summaries")!;
    assert.equal(rec.at, 5_000);
    assert.equal(rec.hadPrevious, false);
    // What Claude Code now sees, and what spend and savedSince read from it.
    const st = progressSummariesState({ home, cwd: home, env: {} });
    assert.equal(st.set?.value, "1");
    assert.equal(st.offSince, 5_000);
    assert.match(st.set!.where, /settings\.json env$/);
    const since = savedSince(readFixRecords(home), { subagentPaths: [] });
    assert.deepEqual(since.map((s) => [s.id, s.savedUsd, s.detail]), [["progress-summaries", undefined, "no background subagent in a terminal session since"]]);
    const lines = await undoFixes(["progress-summaries"], deps);
    assert.match(lines.join("\n"), /✓ env\.CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES removed/);
    if (original === undefined) assert.ok(!existsSync(settings), "the file fix created goes again");
    else assert.equal(readFileSync(settings, "utf8"), original);
  }
  // Set by the user, even to keep them: refused, the file untouched, nothing recorded.
  const mine = '{\n  "env": { "CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES": "0" }\n}\n';
  writeFileSync(settings, mine);
  const r = await applyFix(fix, deps);
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /"0" in .*settings\.json, a value you set: left as it is/);
  assert.equal(readFileSync(settings, "utf8"), mine);
  assert.deepEqual(readFixRecords(home), []);
  assert.deepEqual(progressSummariesState({ home, cwd: home, env: {} }).set, { value: "0", where: progressSummariesState({ home, cwd: home, env: {} }).set!.where });
  // Set in the shell Claude Code starts in: the settings value would replace it, so refused too.
  writeFileSync(settings, "{}\n");
  const e = await applyFix(fix, { ...deps, env: { CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES: "false" } });
  assert.equal(e.ok, false);
  assert.match(e.lines[0], /CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES=false in the environment/);
  assert.equal(readFileSync(settings, "utf8"), "{}\n");
  assert.deepEqual(progressSummariesState({ home, cwd: home, env: { CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES: "TRUE" } }).set, { value: "TRUE", where: "the environment" });
});

test("fix: a project, local or managed value that keeps them is named as an override; the fork gate is read", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-ps-ov-"));
  mkdirSync(join(home, ".claude"));
  const cwd = mkdtempSync(join(tmpdir(), "cd-ps-ov-proj-"));
  mkdirSync(join(cwd, ".claude"));
  writeFileSync(join(cwd, ".claude", "settings.local.json"), '{"env": {"CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES": "0"}}');
  writeFileSync(join(cwd, ".claude", "settings.json"), '{"env": {"CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES": "1", "CLAUDE_CODE_FORK_SUBAGENT": "0"}}');
  const env = {} as NodeJS.ProcessEnv;
  const over = fixOverrides("progress-summaries", { home, cwd, env });
  assert.equal(over.length, 1, "a project value that turns them off is no override");
  assert.match(over[0], /CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES=0 in .*settings\.local\.json env/);
  const st = progressSummariesState({ home, cwd, env });
  assert.equal(st.set, undefined, "the local value wins and is not the user's");
  assert.equal(st.forkGateOff, true);
  const [fix] = planFixes({ ...base, progressSummaries: estimate(42) });
  const r = await applyFix(fix, { home, cwd, env });
  assert.equal(r.ok, false);
  assert.match(r.lines.join("\n"), /⚠ written, but it will not take effect while .*settings\.local\.json env overrides it/);
});
