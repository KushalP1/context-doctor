/**
 * `context-doctor report` — one impact report for this machine.
 *
 * Honesty rules baked in: proxy numbers are EXACT (real before/after on every
 * request). Session numbers are MEASURED-NOW (current size + what optimization
 * would still recover). The behavioral counterfactual — what Claude avoided
 * wasting because of hygiene guidance — cannot be measured by anyone: the same
 * session cannot be re-run without it. The report says so instead of inventing
 * a number.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { ledgerPath } from "./hook.js";
import { listSessions, parseSessionFile } from "./session.js";
import { parseConversation } from "./parse.js";
import { profileConversation } from "./profile.js";
import { formatTokens } from "./tokens.js";
import { formatUsd } from "./pricing.js";

/** Sessions larger than this are skipped in the report (keeps it snappy). */
const MAX_SESSION_BYTES = 30 * 1024 * 1024;

async function fetchProxyStats(port: number): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/stats`, { signal: AbortSignal.timeout(500) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, number>;
  } catch {
    return null;
  }
}

export async function buildImpactReport(proxyPort = 8787): Promise<string> {
  const lines: string[] = [];
  lines.push("CONTEXT DOCTOR — impact report");
  lines.push("═".repeat(56));

  // -- Exact: proxy savings ----------------------------------------------------
  lines.push("Measured savings (exact — every request counted)");
  lines.push("─".repeat(56));
  const proxy = await fetchProxyStats(proxyPort);
  if (proxy) {
    lines.push(
      `Proxy since ${String((proxy as any).startedAt ?? "start")}: ${proxy.optimizedRequests}/${proxy.requests} requests optimized, ` +
        `${formatTokens(proxy.tokensSaved)} tokens ≈ ${formatUsd(proxy.estUsdSaved)} saved`
    );
  } else {
    lines.push(`Proxy not running on :${proxyPort} — exact per-request savings apply only to API apps routed through it.`);
  }
  lines.push("");

  // -- Hook activity from the ledger -------------------------------------------
  lines.push("Hygiene activity (every-prompt hook)");
  lines.push("─".repeat(56));
  const lp = ledgerPath();
  if (existsSync(lp)) {
    const entries = readFileSync(lp, "utf8")
      .trimEnd()
      .split("\n")
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as { ts: number; sid: string; tok: number; warn: boolean }];
        } catch {
          return [];
        }
      });
    const sessions = new Set(entries.map((e) => e.sid));
    const warnings = entries.filter((e) => e.warn).length;
    lines.push(
      `${entries.length} deep context checks across ${sessions.size} session(s); ` +
        `${warnings} hygiene warning(s) delivered to the model.`
    );
    lines.push("(Prompt-level fast checks are not logged — they cost ~1ms and leave no trace by design.)");
  } else {
    lines.push("No hook activity recorded yet (ledger appears after the first deep check of a heavy session).");
  }
  lines.push("");

  // -- Measured-now: recent session profiles ------------------------------------
  lines.push("Your recent sessions — waste still recoverable today");
  lines.push("─".repeat(56));
  const sessions = listSessions(8).filter((s) => s.sizeBytes <= MAX_SESSION_BYTES);
  if (sessions.length === 0) {
    lines.push("No Claude Code session transcripts found.");
  } else {
    let totalTokens = 0;
    let totalWaste = 0;
    let totalWasteUsd = 0;
    for (const s of sessions) {
      try {
        const parsed = parseSessionFile(s.path);
        if (parsed.messageCount === 0) continue;
        const p = profileConversation(parseConversation(parsed.conversationJson), parsed.model);
        totalTokens += p.totalTokens;
        totalWaste += p.totalEstSavings;
        if (p.cost) totalWasteUsd += p.cost.savingsPerCallUsd;
        const wastePct = p.totalTokens > 0 ? Math.round((p.totalEstSavings / p.totalTokens) * 100) : 0;
        lines.push(
          `  ${(parsed.title ?? s.path.split("/").pop() ?? "session").slice(0, 44).padEnd(46)} ` +
            `${formatTokens(p.totalTokens).padStart(6)} tokens · waste ${String(wastePct).padStart(2)}%`
        );
      } catch {
        /* unreadable session — skip */
      }
    }
    lines.push("");
    lines.push(
      `Across these sessions: ~${formatTokens(totalTokens)} tokens held; ~${formatTokens(totalWaste)} still recoverable` +
        (totalWasteUsd > 0 ? ` (≈ ${formatUsd(totalWasteUsd)} of input per message sent in them)` : "")
    );
  }
  lines.push("");
  lines.push("What no report can show: tokens Claude AVOIDED adding thanks to the standing");
  lines.push("hygiene guidance — the same session cannot be re-run without it. Proxy numbers");
  lines.push("above are exact; session numbers are what optimization would still save now.");

  return lines.join("\n");
}
