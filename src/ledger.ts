/**
 * Local activity ledger: one JSONL line per notable event, feeding
 * `context-doctor report`. Best-effort by design — a ledger failure must
 * never break a prompt, a tool call, or an optimize run.
 *
 * Event shapes (all carry ts):
 *   check    — hook deep-parsed a session   {ev?: undefined|"check", sid, tok, warn}
 *              (pre-0.3.6 hook entries have no `ev` field; treated as checks)
 *   optimize — an optimization was applied  {ev: "optimize", src: "cli"|"mcp", saved, model?}
 *   proxy    — proxy savings checkpoint      {ev: "proxy", saved, usd?, requests?}
 *   rollup   — totals folded in on rotation   {ev: "rollup", ...carried sums}
 *
 * The ledger is capped, and everything it feeds is a LIFETIME total. Simply
 * dropping old lines made those totals go backwards — measured: 1,692,000
 * tokens saved became 501,000 the moment the cap was hit. So rotation folds
 * what it drops into a single rollup entry instead of discarding it.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface LedgerEntry {
  ts: number;
  ev?: "check" | "optimize" | "proxy" | "rollup";
  sid?: string;
  tok?: number;
  warn?: boolean;
  src?: "cli" | "mcp" | "proxy";
  usd?: number;
  requests?: number;
  saved?: number;
  model?: string;
  /** rollup only: sums carried forward from entries rotation removed. */
  carried?: CarriedTotals;
}

/** Everything the reports total up, preserved across ledger rotation. */
export interface CarriedTotals {
  optimizeSaved: number;
  optimizeUsd: number;
  proxySaved: number;
  proxyUsd: number;
  proxyRequests: number;
  checks: number;
  warnings: number;
  /** Session shrinkage observed between consecutive checks. */
  shrinkage: number;
  /** Timestamp of the oldest folded entry, so reports can say "since". */
  since?: number;
}

const EMPTY_CARRIED: CarriedTotals = {
  optimizeSaved: 0, optimizeUsd: 0, proxySaved: 0, proxyUsd: 0,
  proxyRequests: 0, checks: 0, warnings: 0, shrinkage: 0,
};

/**
 * Reduce a set of entries to the totals the reports care about.
 *
 * Absorbs existing rollups, so folding stays correct across any number of
 * rotations rather than only the first.
 */
export function foldTotals(entries: LedgerEntry[]): CarriedTotals {
  const out: CarriedTotals = { ...EMPTY_CARRIED };
  const perSession = new Map<string, number[]>();
  for (const e of entries) {
    if (e.ev === "rollup" && e.carried) {
      out.optimizeSaved += e.carried.optimizeSaved;
      out.optimizeUsd += e.carried.optimizeUsd;
      out.proxySaved += e.carried.proxySaved;
      out.proxyUsd += e.carried.proxyUsd;
      out.proxyRequests += e.carried.proxyRequests;
      out.checks += e.carried.checks;
      out.warnings += e.carried.warnings;
      out.shrinkage += e.carried.shrinkage;
      if (e.carried.since) out.since = Math.min(out.since ?? e.carried.since, e.carried.since);
      continue;
    }
    out.since = Math.min(out.since ?? e.ts, e.ts);
    if (e.ev === "optimize") {
      out.optimizeSaved += e.saved ?? 0;
      out.optimizeUsd += e.usd ?? 0;
    } else if (e.ev === "proxy") {
      out.proxySaved += e.saved ?? 0;
      out.proxyUsd += e.usd ?? 0;
      out.proxyRequests += e.requests ?? 0;
    } else {
      out.checks++;
      if (e.warn) out.warnings++;
      if (e.sid && typeof e.tok === "number") perSession.set(e.sid, [...(perSession.get(e.sid) ?? []), e.tok]);
    }
  }
  for (const toks of perSession.values()) {
    for (let i = 1; i < toks.length; i++) if (toks[i] < toks[i - 1]) out.shrinkage += toks[i - 1] - toks[i];
  }
  return out;
}

export function statePath(): string {
  return process.env.CONTEXT_DOCTOR_HOOK_STATE ?? join(homedir(), ".claude", ".context-doctor-hook-state.json");
}

export function ledgerPath(): string {
  return join(dirname(statePath()), ".context-doctor-ledger.jsonl");
}

export function recordLedger(entry: Omit<LedgerEntry, "ts">): void {
  const path = ledgerPath();
  try {
    // Claude-Desktop-only machines have no ~/.claude — create it so their
    // optimize events count in `context-doctor report` too.
    mkdirSync(dirname(path), { recursive: true });
    // Cap growth: past ~256KB keep the most recent 500 entries — but fold the
    // dropped ones into a rollup first, or every lifetime total in the reports
    // silently shrinks the moment a heavy user crosses the cap.
    if (existsSync(path) && statSync(path).size > 256 * 1024) {
      const lines = readFileSync(path, "utf8").trimEnd().split("\n");
      const parse = (line: string): LedgerEntry[] => {
        try {
          return [JSON.parse(line) as LedgerEntry];
        } catch {
          return [];
        }
      };
      const kept = lines.slice(-500);
      const dropped = lines.slice(0, -500).flatMap(parse);
      const carried = foldTotals(dropped);
      const rollup: LedgerEntry = { ts: Date.now(), ev: "rollup", carried };
      writeFileSync(path, [JSON.stringify(rollup), ...kept].join("\n") + "\n");
    }
    appendFileSync(path, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
  } catch {
    /* best-effort */
  }
}

export function readLedger(): LedgerEntry[] {
  const path = ledgerPath();
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .trimEnd()
      .split("\n")
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LedgerEntry];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
