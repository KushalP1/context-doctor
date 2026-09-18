/**
 * Subagent accounting reads `<session>/subagents/agent-*.jsonl`, the files
 * Claude Code actually writes (the parent transcript never contains them).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSubagents, subagentDir, subagentReport } from "../subagents.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

function line(type: "user" | "assistant", content: unknown, extra: Record<string, unknown> = {}, ts = "2026-09-18T10:00:00.000Z"): string {
  return JSON.stringify({ type, timestamp: ts, isSidechain: true, message: { role: type, content, ...extra } });
}
function usage(input: number, read: number, write: number, out: number, model = "claude-sonnet-5") {
  return { model, usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: out } };
}

/** A parent transcript plus a subagents dir laid out exactly as Claude Code does. */
function session(): { transcript: string; subs: string } {
  const project = mkdtempSync(join(tmpdir(), "ctxdoc-subs-"));
  const transcript = join(project, "sess-1.jsonl");
  writeFileSync(transcript, [line("user", "parent turn"), line("assistant", "ok", usage(1000, 0, 0, 10))].join("\n") + "\n");
  const subs = join(project, "sess-1", "subagents");
  mkdirSync(subs, { recursive: true });
  return { transcript, subs };
}

test("totals, cache-aware cost, task text, duration and ordering come from the subagent files", () => {
  const { transcript, subs } = session();
  // Agent A: two calls on sonnet; second call mostly cache reads.
  writeFileSync(
    join(subs, "agent-aaa.jsonl"),
    [
      line("user", "You are auditing the   backend.   Read only.", {}, "2026-09-18T10:00:00.000Z"),
      line("assistant", "working", usage(10_000, 0, 5_000, 500), "2026-09-18T10:01:00.000Z"),
      line("assistant", "done", usage(200, 14_800, 0, 300), "2026-09-18T10:05:00.000Z"),
    ].join("\n") + "\n"
  );
  // Agent B: one call on a model with no price on file.
  writeFileSync(
    join(subs, "agent-bbb.jsonl"),
    [line("user", [{ type: "text", text: "summarize the diff" }]), line("assistant", "x", usage(3_000, 0, 0, 100, "totally-unknown-model"))].join("\n") + "\n"
  );
  // Noise that must not break or count: an empty file and a non-agent file.
  writeFileSync(join(subs, "agent-empty.jsonl"), "");
  writeFileSync(join(subs, "notes.txt"), "not a transcript");

  const report = subagentReport(transcript);
  assert.ok(report);
  assert.equal(report.agents.length, 2, "empty and non-agent files are ignored");

  const a = report.agents.find((x) => x.id === "aaa")!;
  assert.equal(a.calls, 2);
  assert.equal(a.task, "You are auditing the backend. Read only.", "whitespace collapsed, first user turn");
  assert.equal(a.finalContextTokens, 15_000, "context on the LAST call");
  assert.equal(a.inputBilledTokens, 30_000, "input billed sums every call");
  assert.equal(a.cacheReadTokens, 14_800);
  assert.equal(a.outputTokens, 800);
  assert.equal(a.durationMs, 5 * 60_000);
  // sonnet: $3/M input, $0.3/M cache read, $15/M output; writes at 1.25x.
  const expected = ((10_000 + 5_000 * 1.25) * 3 + 200 * 3 + 14_800 * 0.3 + 800 * 15) / 1_000_000;
  assert.ok(Math.abs((a.estCostUsd ?? 0) - expected) < 1e-9, `cost ${a.estCostUsd} vs ${expected}`);

  const b = report.agents.find((x) => x.id === "bbb")!;
  assert.equal(b.task, "summarize the diff", "block-array content is flattened");
  assert.equal(b.estCostUsd, undefined, "an unpriced model is not silently costed at zero");
  assert.equal(report.unpriced, 1);
  assert.equal(report.agents[0].id, "aaa", "priced and most expensive first");
  assert.equal(report.totalInputBilled, 33_000);
  assert.equal(report.totalOutput, 900);
});

test("rendering names the invisible money and compares total against total", () => {
  const { transcript, subs } = session();
  writeFileSync(
    join(subs, "agent-big.jsonl"),
    [line("user", "do the whole audit"), line("assistant", "x", usage(1_000, 249_000, 0, 2_000))].join("\n") + "\n"
  );
  const report = subagentReport(transcript);
  const out = renderSubagents(report, 1.0) ?? "";
  assert.match(out, /1 subagent\(s\) made 1 API calls: 250k input billed/);
  assert.match(out, /on top of the parent session's own input cost \(\$1\.00\)/, "ratio is against the parent's TOTAL input cost");
  assert.match(out, /ended above 200k tokens of context/, "a subagent doing a main session's job is called out");
  assert.match(out, /do the whole audit/);
  assert.equal(renderSubagents(null), null);
});

test("no subagents directory means nothing to say, not an error", () => {
  const project = mkdtempSync(join(tmpdir(), "ctxdoc-nosubs-"));
  const transcript = join(project, "lonely.jsonl");
  writeFileSync(transcript, line("user", "hi") + "\n");
  assert.equal(subagentDir(transcript), join(project, "lonely", "subagents"));
  assert.equal(subagentReport(transcript), null);
  // An existing but empty directory is the same.
  mkdirSync(join(project, "lonely", "subagents"), { recursive: true });
  assert.equal(subagentReport(transcript), null);
});

test("session prints the subagent section and includes it in --json", async () => {
  const { transcript, subs } = session();
  writeFileSync(join(subs, "agent-one.jsonl"), [line("user", "fix the tests"), line("assistant", "x", usage(5_000, 0, 0, 100))].join("\n") + "\n");
  const run = (...args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile(process.execPath, [cliPath, "session", transcript, ...args], (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
  const text = await run();
  assert.match(text, /Subagents \(their own windows, your bill\)/);
  assert.match(text, /fix the tests/);
  const json = JSON.parse(await run("--json"));
  assert.equal(json.session.subagents.agents.length, 1);
  assert.equal(json.session.subagents.agents[0].inputBilledTokens, 5_000);
});
