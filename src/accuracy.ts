/**
 * `context-doctor accuracy` — how much of what you are billed for is actually
 * visible in your transcript.
 *
 * Every profile in this tool describes the CONVERSATION: the messages the
 * transcript records. Your bill covers the whole request, which also carries
 * the harness's system prompt, tool schemas, skills, and per-turn injected
 * content that is never written to the transcript at all.
 *
 * Both numbers are correct; they answer different questions. This command
 * measures the distance between them on your own sessions, so "why is my bill
 * bigger than the profile?" has an answer with evidence behind it.
 *
 * WHAT THIS IS NOT: a tokenizer benchmark. It cannot be — the content behind
 * the gap is unavailable to us, so the gap cannot be attributed to estimator
 * drift. To measure the estimator itself, use `analyze --exact`, which counts
 * the same bytes with the provider's own tokenizer.
 */

import { estimateTokens, formatTokens, MESSAGE_OVERHEAD_TOKENS } from "./tokens.js";
import { parseConversation } from "./parse.js";
import { listSessions, parseSessionFile } from "./session.js";

export interface AccuracyReport {
  sessionsScanned: number;
  /** Turn-to-turn observations used. */
  samples: number;
  /** Median share of a turn's billed growth that the transcript accounts for. */
  medianCoverage: number;
  /** Median tokens per turn billed but absent from the transcript. */
  medianInvisiblePerTurn: number;
  /** Median fixed baseline: system prompt + tool schemas, before any turn. */
  medianBaseline?: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Below this, a turn is too small for the ratio to mean anything. */
const MIN_DELTA_TOKENS = 200;

export function measureAccuracy(limit = 20): AccuracyReport {
  const coverages: number[] = [];
  const invisible: number[] = [];
  const baselines: number[] = [];
  let scanned = 0;

  for (const info of listSessions(limit)) {
    let parsed;
    try {
      parsed = parseSessionFile(info.path);
    } catch {
      continue; // an unreadable session is not a measurement
    }
    const usage = parsed.usageSamples ?? [];
    if (usage.length < 2) continue;
    scanned++;

    // Estimate through the same parser the profiler uses, with the same
    // per-message overhead — anything else would measure a different estimator.
    const normalized = parseConversation(parsed.conversationJson).messages;
    const estimateAt = (i: number): number => {
      const m = normalized[i];
      return m ? estimateTokens(m.text) + MESSAGE_OVERHEAD_TOKENS : 0;
    };

    let baseline = usage[0].input;
    for (let i = 0; i < usage[0].index; i++) baseline -= estimateAt(i);
    if (baseline > 0) baselines.push(baseline);

    for (let s = 1; s < usage.length; s++) {
      const billed = usage[s].input - usage[s - 1].input;
      if (billed < MIN_DELTA_TOKENS) continue;
      let visible = 0;
      for (let i = usage[s - 1].index; i < usage[s].index; i++) visible += estimateAt(i);
      if (visible <= 0) continue;
      // A turn cannot be more than fully visible; ratios above 1 mean the
      // billed figure moved for another reason (a compaction, a schema change).
      const coverage = visible / billed;
      if (coverage > 1) continue;
      coverages.push(coverage);
      invisible.push(billed - visible);
    }
  }

  return {
    sessionsScanned: scanned,
    samples: coverages.length,
    medianCoverage: median(coverages),
    medianInvisiblePerTurn: median(invisible),
    medianBaseline: baselines.length ? median(baselines) : undefined,
  };
}

export function renderAccuracy(report: AccuracyReport): string {
  const lines: string[] = [];
  lines.push("CONTEXT DOCTOR — billed context vs what your transcript shows");
  lines.push("═".repeat(56));

  if (report.samples === 0) {
    lines.push("No usable samples found.");
    lines.push("");
    lines.push("This reads input-token counts recorded in Claude Code transcripts, so it");
    lines.push("needs local sessions with at least two assistant turns.");
    return lines.join("\n");
  }

  const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
  lines.push(`${report.samples} turns across ${report.sessionsScanned} session(s).`);
  lines.push("");
  if (report.medianBaseline !== undefined) {
    lines.push(`Fixed baseline     ~${formatTokens(report.medianBaseline)} tokens before your first turn —`);
    lines.push("                   system prompt, tool schemas and skills, none of which the");
    lines.push("                   transcript stores.");
  }
  lines.push(`Transcript covers  ${pct(report.medianCoverage)} of a typical turn's billed growth`);
  lines.push(`Not in transcript  ~${formatTokens(report.medianInvisiblePerTurn)} tokens per turn (injected reminders,`);
  lines.push("                   skill and file content, and other per-request additions)");
  lines.push("");
  lines.push("Both numbers are right. Profiles describe the conversation you can see and");
  lines.push("act on; your bill covers the whole request. Trimming what the profile shows");
  lines.push("still saves real money — it just starts from a higher floor than the profile");
  lines.push("implies.");
  lines.push("");
  lines.push("This does NOT measure tokenizer drift: the missing content is not available");
  lines.push("to compare against. For that, use `analyze --exact` (provider tokenizer).");
  return lines.join("\n");
}
