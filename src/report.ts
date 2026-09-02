/**
 * Render a ContextProfile as a readable terminal/markdown report.
 * Plain text with ASCII bars — no color deps, so output pastes cleanly
 * anywhere (terminals, issues, chat).
 */

import { ContextProfile, Category } from "./profile.js";
import { formatTokens } from "./tokens.js";
import { formatUsd } from "./pricing.js";

const CATEGORY_LABELS: Record<Category, string> = {
  system: "System prompt",
  user: "User messages",
  assistant: "Assistant replies",
  tool_calls: "Tool calls",
  tool_results: "Tool results",
  other: "Other",
};

const SEVERITY_MARK = { high: "✖", warn: "▲", info: "ℹ" } as const;

function bar(fraction: number, width = 28): string {
  const filled = Math.round(fraction * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export interface RenderOptions {
  /**
   * Replace anything quoted from the conversation with a placeholder, so a
   * profile can be pasted into a bug report without leaking content. Numbers
   * and structure — the parts that make a report useful — are kept.
   */
  redact?: boolean;
}

/** Mask filesystem paths and quoted fragments inside a finding's text. */
function redactText(text: string): string {
  return text
    .replace(/(?:\/[\w.@ -]+){2,}/g, "[path]")
    .replace(/\b[\w.-]+\.(ts|tsx|js|jsx|py|go|rs|java|rb|md|json|ya?ml|sql|sh)\b/gi, "[file]");
}

export function renderProfile(profile: ContextProfile, options: RenderOptions = {}): string {
  const lines: string[] = [];
  const p = profile;

  lines.push("CONTEXT DOCTOR — profile");
  lines.push("═".repeat(56));
  // A malformed or non-conversation input still profiles (as raw text), but a
  // report that does not say so reads as a confident answer to the wrong
  // question. Lead with the warning.
  if (p.parseWarning) {
    lines.push(`⚠ ${p.parseWarning}`);
    lines.push("");
  }
  lines.push(`Total: ~${formatTokens(p.totalTokens)} tokens across ${p.messageCount} messages (${p.sourceFormat} format)`);
  if (p.model) {
    const windowNote = p.contextWindow
      ? ` of ${formatTokens(p.contextWindow)} window (${p.usagePct!.toFixed(1)}%)`
      : " (unknown window size)";
    lines.push(`Model: ${p.model}${windowNote}`);
  }
  if (p.cost) {
    lines.push(
      `Cost:  ~${formatUsd(p.cost.perCallUsd)} input per call · ~${formatUsd(p.cost.per1kCallsUsd)} per 1k calls · ` +
      `~${p.cost.ttftSeconds.toFixed(1)}s of latency per call (estimates)`
    );
  }
  lines.push("");

  // Category breakdown, largest first
  lines.push("Where the tokens go");
  lines.push("─".repeat(56));
  const cats = (Object.entries(p.categories) as Array<[Category, number]>)
    .filter(([, t]) => t > 0)
    .sort((a, b) => b[1] - a[1]);
  const maxLabel = Math.max(...cats.map(([c]) => CATEGORY_LABELS[c].length));
  for (const [cat, tokens] of cats) {
    const frac = p.totalTokens > 0 ? tokens / p.totalTokens : 0;
    lines.push(
      `${CATEGORY_LABELS[cat].padEnd(maxLabel)}  ${bar(frac)} ${String(Math.round(frac * 100)).padStart(3)}%  ~${formatTokens(tokens)}`
    );
  }
  lines.push("");

  // Largest messages
  lines.push("Largest messages");
  lines.push("─".repeat(56));
  for (const m of p.largestMessages) {
    const label = m.toolName ? `${m.kind}:${m.toolName}` : m.kind;
    // The preview is the only place raw conversation text reaches the report.
    const body = options.redact ? "[redacted]" : m.preview;
    lines.push(`  #${m.index} [${label}] ~${formatTokens(m.tokens)}  ${body}`);
  }
  lines.push("");

  // Findings
  if (p.findings.length > 0) {
    lines.push(`Findings (${p.findings.length})`);
    lines.push("─".repeat(56));
    for (const f of p.findings) {
      const savings = f.estSavings > 0 ? ` [save ~${formatTokens(f.estSavings)}]` : "";
      lines.push(`${SEVERITY_MARK[f.severity]} ${options.redact ? redactText(f.message) : f.message}${savings}`);
      lines.push(`   → ${f.suggestion}`);
    }
    lines.push("");
    if (p.totalEstSavings > 0) {
      const pct = p.totalTokens > 0 ? Math.round((p.totalEstSavings / p.totalTokens) * 100) : 0;
      let recovery = `Potential recovery: ~${formatTokens(p.totalEstSavings)} tokens (~${pct}% of context)`;
      if (p.cost && p.cost.savingsPerCallUsd > 0) {
        recovery += ` ≈ ${formatUsd(p.cost.savingsPer1kCallsUsd)} per 1k calls, ${p.cost.ttftSavedSeconds.toFixed(1)}s faster per call`;
      }
      lines.push(recovery);
      lines.push(`Run \`context-doctor optimize <file>\` to apply the safe fixes automatically.`);
    }
  } else {
    lines.push("No issues found — this context is in good shape.");
  }

  return lines.join("\n");
}
