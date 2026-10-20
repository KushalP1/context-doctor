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

import { foldTotals, LedgerEntry, readLedger } from "./ledger.js";
import { listSessions, parseSessionFile } from "./session.js";
import { parseConversation } from "./parse.js";
import { profileConversation } from "./profile.js";
import { formatTokens } from "./tokens.js";
import { formatUsd, inputCostUsd, pricingFor } from "./pricing.js";
import { coldResumeFollowThrough } from "./coldresume.js";

/**
 * The dollar figure for `tokens`, of which only `priced` have a model with a
 * known price. Pricing the whole total at the priced part's rate, or showing
 * the priced part's dollars beside the whole total unlabeled, overstated it.
 */
function pricedNote(usd: number, priced: number, tokens: number): string {
  if (tokens <= 0) return "";
  if (priced <= 0 || usd <= 0) return " (no known price for these models)";
  if (priced >= tokens) return ` ≈ ${formatUsd(usd)}`;
  return ` ≈ ${formatUsd(usd)} on the ${formatTokens(priced)} with a known price; ${formatTokens(tokens - priced)} unpriced`;
}

/** Sessions larger than this are skipped in the report (keeps it snappy). */
const MAX_SESSION_BYTES = 30 * 1024 * 1024;

/** The parts of the proxy's /stats that lifetime savings depend on. */
export interface LiveProxyStats {
  startedAt?: string;
  tokensSaved?: number;
  estUsdSaved?: number;
}

export interface ProxySavings {
  /** Lifetime tokens the proxy removed: ledger checkpoints plus what the live run has not checkpointed. */
  tokens: number;
  usd: number;
  /** The part of `tokens` from runs before the live one (all of it when none is running). */
  earlier: number;
  /** Ledger checkpoints written by those earlier runs. */
  earlierCheckpoints: number;
}

/**
 * Lifetime proxy savings, for `report` and the dashboard alike.
 *
 * A running proxy writes the DELTA of its total to the ledger every 60 s
 * (proxy.ts, so history survives a restart), while /stats keeps returning the
 * whole total since its startedAt. Ledger + /stats therefore counted every
 * checkpointed token twice: one request saving 22k read "~45k" a minute later.
 * Here every ledger checkpoint counts once, and the live run adds only what its
 * own checkpoints (entries written since its startedAt) do not hold yet. The
 * dashboard used to show the live figure alone, so a stopped proxy read 0.
 *
 * Known limit: if ledger rotation folds this run's own checkpoints into a
 * rollup, they can no longer be told apart and count twice again. Only the
 * proxy can close that (by reporting its checkpointed total in /stats).
 */
export function proxySavings(ledger: LedgerEntry[], live: LiveProxyStats | null): ProxySavings {
  const carried = foldTotals(ledger.filter((e) => e.ev === "rollup"));
  const events = ledger.filter((e) => e.ev === "proxy");
  const sum = (es: LedgerEntry[], pick: (e: LedgerEntry) => number | undefined) => es.reduce((s, e) => s + (pick(e) ?? 0), 0);
  const recorded = sum(events, (e) => e.saved) + carried.proxySaved;
  const recordedUsd = sum(events, (e) => e.usd) + carried.proxyUsd;
  if (!live) return { tokens: recorded, usd: recordedUsd, earlier: recorded, earlierCheckpoints: events.length };

  // Without a parseable startedAt no checkpoint can be attributed to this run;
  // count the live total whole, as before.
  const since = Date.parse(live.startedAt ?? "");
  const thisRun = Number.isFinite(since) ? events.filter((e) => e.ts >= since) : [];
  const liveTokens = live.tokensSaved ?? 0;
  // max(0, …): another proxy checkpointing meanwhile must not make this negative.
  const pending = Math.max(0, liveTokens - sum(thisRun, (e) => e.saved));
  const pendingUsd = Math.max(0, (live.estUsdSaved ?? 0) - sum(thisRun, (e) => e.usd));
  const tokens = recorded + pending;
  return {
    tokens,
    usd: recordedUsd + pendingUsd,
    earlier: Math.max(0, tokens - liveTokens),
    earlierCheckpoints: events.length - thisRun.length,
  };
}

/** What the report reads from a running proxy's /stats. */
interface ProxyStatsView extends LiveProxyStats {
  requests: number;
  optimizedRequests: number;
  tokensSaved: number;
  estUsdSaved: number;
}

async function fetchProxyStats(port: number): Promise<ProxyStatsView | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/stats`, { signal: AbortSignal.timeout(500) });
    if (!res.ok) return null;
    return (await res.json()) as ProxyStatsView;
  } catch {
    return null;
  }
}

export async function buildImpactReport(proxyPort = 8787): Promise<string> {
  const lines: string[] = [];
  lines.push("CONTEXT DOCTOR — impact report");
  lines.push("═".repeat(56));

  const ledger = readLedger();
  // Rotation folds dropped entries into a rollup. Counting it is what keeps
  // these lifetime totals from going backwards once the cap is hit.
  const carried = foldTotals(ledger.filter((e) => e.ev === "rollup"));
  // "doctor-probe" entries came from `doctor` (before 0.30), not from the hook.
  const checks = ledger.filter((e) => (e.ev === "check" || e.ev === undefined) && e.sid !== "doctor-probe");
  const optimizes = ledger.filter((e) => e.ev === "optimize");

  // Observed per-session reductions: when a session SHRANK between two deep
  // checks (compaction/cleanup after a warning), that drop is measured fact.
  const bySession = new Map<string, { toks: number[]; warns: number }>();
  for (const c of checks) {
    // "mcp-sketch" was a shared id for unrelated chats (fixed in 0.24); never a session.
    if (!c.sid || c.sid === "mcp-sketch" || typeof c.tok !== "number") continue;
    const s = bySession.get(c.sid) ?? { toks: [], warns: 0 };
    s.toks.push(c.tok);
    if (c.warn) s.warns++;
    bySession.set(c.sid, s);
  }
  const reductionBySession = new Map<string, number>();
  for (const [sid, s] of bySession) {
    let reduction = 0;
    for (let i = 1; i < s.toks.length; i++) {
      if (s.toks[i] < s.toks[i - 1]) reduction += s.toks[i - 1] - s.toks[i];
    }
    reductionBySession.set(sid, reduction);
  }
  const totalReduction = [...reductionBySession.values()].reduce((a, b) => a + b, 0) + carried.shrinkage;

  // Optimize-event savings, split by model family (claude / gpt / other).
  const optimizeSaved = optimizes.reduce((s, e) => s + (e.saved ?? 0), 0) + carried.optimizeSaved;
  const savedByFamily = new Map<string, number>();
  let optimizeUsd = 0;
  /** The part of optimizeSaved whose model has a known price: the dollars cover only this. */
  let optimizePriced = 0;
  for (const e of optimizes) {
    const family = /claude/i.test(e.model ?? "") ? "claude" : /gpt|^o\d/i.test(e.model ?? "") ? "gpt" : "other";
    savedByFamily.set(family, (savedByFamily.get(family) ?? 0) + (e.saved ?? 0));
    const pricing = pricingFor(e.model);
    if (pricing && e.saved) {
      optimizeUsd += inputCostUsd(e.saved, pricing);
      optimizePriced += e.saved;
    }
  }

  const proxy = await fetchProxyStats(proxyPort);
  // Persisted checkpoints cover earlier runs AND the live one's past minutes;
  // proxySavings counts each token once.
  const savedByProxy = proxySavings(ledger, proxy);
  const proxySaved = savedByProxy.tokens;
  const proxyHistoric = savedByProxy.earlier;

  // -- Headline: what context-doctor has saved ----------------------------------
  // Only what context-doctor itself removed. Sessions also shrink when Claude
  // Code auto-compacts or the user runs /compact; counting that as our saving
  // overclaimed (until 0.24 it was in this total), so it is shown apart.
  const totalSaved = proxySaved + optimizeSaved;
  lines.push("Tokens context-doctor saved (measured)");
  lines.push("─".repeat(56));
  lines.push(`TOTAL: ~${formatTokens(totalSaved)} tokens`);
  if (proxy) {
    lines.push(
      `  · proxy (exact): ${formatTokens(proxySaved)} — ${formatTokens(proxyHistoric)} from earlier runs, ` +
        `${formatTokens(proxy.tokensSaved)} live across ${proxy.optimizedRequests}/${proxy.requests} requests ≈ ${formatUsd(proxy.estUsdSaved)}`
    );
  } else {
    lines.push(
      proxyHistoric > 0
        ? `  · proxy (exact, from ${savedByProxy.earlierCheckpoints} earlier run checkpoint(s)): ${formatTokens(proxyHistoric)} — not running now`
        : `  · proxy: not running on :${proxyPort} (its exact savings appear here once it runs)`
    );
  }
  const familyNote = [...savedByFamily.entries()]
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}: ${formatTokens(v)}`)
    .join(", ");
  lines.push(
    `  · optimizations applied via CLI/chat tools (exact): ${formatTokens(optimizeSaved)} over ${optimizes.length} run(s)` +
      (familyNote ? ` [${familyNote}]` : "") +
      pricedNote(optimizeUsd, optimizePriced, optimizeSaved)
  );
  lines.push("");
  lines.push(`Sessions that got smaller after a hygiene warning: ${formatTokens(totalReduction)} tokens`);
  lines.push("  (mostly compaction, by you or Claude Code; not counted above, because a warning");
  lines.push("  may or may not be why it happened)");
  lines.push("");

  // -- Hook activity ------------------------------------------------------------
  lines.push("Hygiene activity (every-prompt hook)");
  lines.push("─".repeat(56));
  if (checks.length > 0) {
    const warnings = checks.filter((e) => e.warn).length + carried.warnings;
    lines.push(`${checks.length + carried.checks} deep context checks across ${bySession.size} session(s); ${warnings} warning(s) delivered to the model.`);
    lines.push("(Prompt-level fast checks are not logged — they cost ~1ms and leave no trace by design.)");
  } else {
    lines.push("No hook activity recorded yet (ledger appears after the first deep check of a heavy session).");
  }
  const offers = ledger.filter((e) => e.ev === "cold_resume");
  if (offers.length > 0) {
    const paths = new Map<string, string>();
    for (const s of listSessions(10_000)) paths.set((s.path.split(/[\\/]/).pop() ?? "").slice(0, 12), s.path);
    const f = coldResumeFollowThrough(offers, paths);
    lines.push(`/compact offered on ${f.offers} return(s) to a large session after the cache expired;`);
    lines.push(`a compaction (yours or Claude Code's) followed within the hour on ${f.compacted}.`);
    if (f.offers >= 5 && f.compacted / f.offers < 0.2) {
      lines.push("Rarely acted on? `context-doctor compact-window` makes Claude Code compact earlier by itself.");
    }
  }
  lines.push("");

  // -- Measured-now: recent session profiles ------------------------------------
  lines.push("Your recent sessions — live context and waste still recoverable");
  lines.push("─".repeat(56));
  const sessions = listSessions(8).filter((s) => s.sizeBytes <= MAX_SESSION_BYTES);
  if (sessions.length === 0) {
    lines.push("No Claude Code session transcripts found.");
  } else {
    let totalTokens = 0;
    let totalWaste = 0;
    let totalWasteUsd = 0;
    /** Recoverable tokens in sessions whose model has a known price: the dollars cover only these. */
    let pricedWaste = 0;
    for (const s of sessions) {
      try {
        const parsed = parseSessionFile(s.path);
        if (parsed.messageCount === 0) continue;
        const p = profileConversation(parseConversation(parsed.conversationJson), parsed.model);
        totalTokens += p.totalTokens;
        totalWaste += p.totalEstSavings;
        // Claude Code sessions run on the prompt cache, so recoverable tokens
        // cost the cached rate on each message, not the full input rate.
        const pr = pricingFor(p.model);
        if (p.cost && pr) {
          totalWasteUsd += p.cost.savingsPerCallUsd * (pr.cacheReadPerM / pr.inputPerM);
          pricedWaste += p.totalEstSavings;
        }
        const wastePct = p.totalTokens > 0 ? Math.round((p.totalEstSavings / p.totalTokens) * 100) : 0;
        // Ledger sids are the session UUID's first 12 chars (= filename prefix).
        const sid = (s.path.split(/[\\/]/).pop() ?? "").slice(0, 12);
        const saved = reductionBySession.get(sid) ?? 0;
        const warns = bySession.get(sid)?.warns ?? 0;
        lines.push(
          `  ${(parsed.title ?? s.path.split("/").pop() ?? "session").slice(0, 40).padEnd(42)} ` +
            `${formatTokens(p.totalTokens).padStart(6)} tok · waste ${String(wastePct).padStart(2)}%` +
            (saved > 0 ? ` · saved ${formatTokens(saved)}` : warns > 0 ? ` · ${warns} warning(s)` : "")
        );
      } catch {
        /* unreadable session — skip */
      }
    }
    lines.push("");
    lines.push(
      `Across these sessions: ~${formatTokens(totalTokens)} tokens held; ~${formatTokens(totalWaste)} still recoverable` +
        (totalWasteUsd > 0
          ? pricedWaste < totalWaste
            ? ` (≈ ${formatUsd(totalWasteUsd)} of input per message on the ~${formatTokens(pricedWaste)} with a known price; ~${formatTokens(totalWaste - pricedWaste)} unpriced)`
            : ` (≈ ${formatUsd(totalWasteUsd)} of input per message sent in them)`
          : totalWaste > 0
            ? " (no known price for these models)"
            : "")
    );
  }
  lines.push("");
  lines.push("What no report can show: tokens Claude AVOIDED adding thanks to the standing");
  lines.push("hygiene guidance — the same session cannot be re-run without it. Proxy numbers");
  lines.push("above are exact; session numbers are what optimization would still save now.");

  return lines.join("\n");
}
