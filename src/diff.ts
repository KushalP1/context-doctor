/**
 * `context-doctor diff <before> <after>` — compare two profiles.
 *
 * Optimization currently has to be taken on trust: you run it, a number
 * changes, and nothing shows what actually moved. This puts two profiles side
 * by side, so "we cut the context" becomes a claim with evidence — which
 * categories shrank, which findings were resolved, and what it means in money
 * and latency.
 *
 * Works on any two inputs `analyze` accepts, plus session transcripts, so it
 * covers before/after an optimization and one session against another.
 */

import { readFileSync } from "node:fs";
import { parseConversation } from "./parse.js";
import { ContextProfile, Finding, profileConversation } from "./profile.js";
import { parseSessionFile } from "./session.js";
import { formatTokens } from "./tokens.js";
import { formatUsd } from "./pricing.js";

/** Load either a conversation file or a Claude Code / ChatGPT transcript. */
function loadProfile(path: string, model?: string): ContextProfile {
  if (path.endsWith(".jsonl")) {
    const session = parseSessionFile(path);
    return profileConversation(parseConversation(session.conversationJson), model ?? session.model);
  }
  return profileConversation(parseConversation(readFileSync(path, "utf8")), model);
}

/** Signed token delta with a stable label. */
interface CategoryChange {
  label: string;
  before: number;
  after: number;
}

function signed(n: number): string {
  return n === 0 ? "±0" : `${n > 0 ? "+" : "−"}${formatTokens(Math.abs(n))}`;
}

/** A finding is "the same finding" when its id and message positions match. */
function findingKey(f: Finding): string {
  return `${f.id}:${f.messages.join(",")}`;
}

export function renderDiff(beforePath: string, afterPath: string, model?: string): string {
  const before = loadProfile(beforePath, model);
  const after = loadProfile(afterPath, model);

  const lines: string[] = [];
  lines.push("CONTEXT DOCTOR — diff");
  lines.push("═".repeat(56));
  lines.push(`before: ${beforePath}`);
  lines.push(`after:  ${afterPath}`);
  lines.push("");

  const delta = after.totalTokens - before.totalTokens;
  const pct = before.totalTokens > 0 ? (delta / before.totalTokens) * 100 : 0;
  lines.push(
    `Total: ${formatTokens(before.totalTokens)} → ${formatTokens(after.totalTokens)} tokens ` +
      `(${signed(delta)}, ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`
  );
  lines.push(`Messages: ${before.messageCount} → ${after.messageCount}`);
  if (before.cost && after.cost) {
    const costDelta = after.cost.per1kCallsUsd - before.cost.per1kCallsUsd;
    const ttftDelta = after.cost.ttftSeconds - before.cost.ttftSeconds;
    lines.push(
      `Cost:  ${formatUsd(before.cost.per1kCallsUsd)} → ${formatUsd(after.cost.per1kCallsUsd)} per 1k calls ` +
        `(${costDelta <= 0 ? "saves " : "costs "}${formatUsd(Math.abs(costDelta))}), ` +
        `${Math.abs(ttftDelta).toFixed(1)}s ${ttftDelta <= 0 ? "faster" : "slower"} per call`
    );
  }
  lines.push("");

  // Where the change actually landed.
  const categories: CategoryChange[] = (Object.keys(before.categories) as Array<keyof typeof before.categories>).map(
    (key) => ({ label: key, before: before.categories[key], after: after.categories[key] })
  );
  const moved = categories.filter((c) => c.before !== c.after);
  if (moved.length > 0) {
    lines.push("Where it changed");
    lines.push("─".repeat(56));
    for (const c of moved.sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before))) {
      lines.push(`  ${c.label.padEnd(14)} ${formatTokens(c.before).padStart(7)} → ${formatTokens(c.after).padStart(7)}  ${signed(c.after - c.before)}`);
    }
    lines.push("");
  }

  // Findings resolved and introduced — the qualitative half of the story.
  const beforeKeys = new Map(before.findings.map((f) => [findingKey(f), f]));
  const afterKeys = new Map(after.findings.map((f) => [findingKey(f), f]));
  const resolved = [...beforeKeys].filter(([k]) => !afterKeys.has(k)).map(([, f]) => f);
  const introduced = [...afterKeys].filter(([k]) => !beforeKeys.has(k)).map(([, f]) => f);

  lines.push(`Findings: ${before.findings.length} → ${after.findings.length}`);
  lines.push("─".repeat(56));
  for (const f of resolved.slice(0, 5)) lines.push(`  ✓ resolved: ${f.message}`);
  if (resolved.length > 5) lines.push(`  ✓ … and ${resolved.length - 5} more resolved`);
  for (const f of introduced.slice(0, 5)) lines.push(`  ✗ new:      ${f.message}`);
  if (introduced.length > 5) lines.push(`  ✗ … and ${introduced.length - 5} more introduced`);
  if (resolved.length === 0 && introduced.length === 0) lines.push("  (no change in findings)");
  lines.push("");

  const verdict =
    delta < 0
      ? `Net improvement: ${formatTokens(-delta)} tokens removed, ${resolved.length} finding(s) resolved.`
      : delta > 0
        ? `Context grew by ${formatTokens(delta)} tokens.`
        : "No change in total context.";
  lines.push(verdict);
  return lines.join("\n");
}
