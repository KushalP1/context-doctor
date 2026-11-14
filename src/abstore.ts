/**
 * The model comparisons `ab --via claude-code` finished, kept beside the
 * other state files (~/.claude/.context-doctor-ab.json, or the fallback
 * state folder), the newest 20. `fix` quotes the newest one that compared
 * the subagent lever's model with another on its subagent-model line. Kept
 * apart from abclaude.ts so `fix` reads it without loading the harness.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "./ledger.js";
import { SUBAGENT_CANDIDATE } from "./subagentpay.js";
import { modelName } from "./subagentmodel.js";

/** What is kept of a finished comparison: enough for `fix` to quote. */
export interface AbStoredResult {
  at: string;
  via: "claude-code";
  claudeCodeVersion?: string;
  authMethod?: string;
  subscriptionType?: string;
  repeat: number;
  tasks: number;
  models: Array<{ model: string; passed: number; completed: number; runs: number; costUsd: number }>;
}

export function abResultsPath(): string {
  return join(stateDir(), ".context-doctor-ab.json");
}

/** Whether Claude Code drew on a claude.ai plan's limits (true) or billed money (an API key, a console sign-in). */
export function onPlan(info: { authMethod?: string }): boolean {
  return info.authMethod === "claude.ai";
}

/** "Sonnet 5.5 passed 7/8, Opus 5.5 8/8": in the order given, over the completed runs. */
export function passLine(totals: Array<{ model: string; passed: number; completed: number }>): string {
  return totals.map((t, i) => `${modelName(t.model)} ${i === 0 ? "passed " : ""}${t.passed}/${t.completed}`).join(", ");
}

/** The kept comparisons; an unreadable file reads as none. */
export function readAbResults(path = abResultsPath()): AbStoredResult[] {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(v?.results) ? v.results.filter((r: any) => r && typeof r.at === "string" && Array.isArray(r.models)) : [];
  } catch {
    return [];
  }
}

/** Add one (the newest 20 are kept), written atomically. */
export function appendAbResult(entry: AbStoredResult, path = abResultsPath()): void {
  const all = [...readAbResults(path), entry].slice(-20);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ results: all }, null, 2) + "\n");
  renameSync(tmp, path);
}

/**
 * The newest kept comparison of `candidate` (the subagent lever's model)
 * with another model, both with completed runs: what `fix` quotes.
 */
export function latestModelComparison(candidate = SUBAGENT_CANDIDATE, path = abResultsPath()): AbStoredResult | undefined {
  if (!existsSync(path)) return undefined;
  return readAbResults(path)
    .filter((r) => r.models.some((m) => m.model === candidate && m.completed > 0) && r.models.some((m) => m.model !== candidate && m.completed > 0))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .at(-1);
}

/** fix's words for a kept comparison: "on your plan: Sonnet 5.5 passed 7/8, Opus 5.5 8/8, 2026-11-14". */
export function comparisonLine(r: AbStoredResult, candidate = SUBAGENT_CANDIDATE): string {
  const ordered = [...r.models.filter((m) => m.model === candidate), ...r.models.filter((m) => m.model !== candidate && m.completed > 0)];
  return `${onPlan(r) ? "on your plan" : "through your Claude Code"}: ${passLine(ordered)}, ${r.at.slice(0, 10)}`;
}
