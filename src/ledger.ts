/**
 * Local activity ledger: one JSONL line per notable event, feeding
 * `context-doctor report`. Best-effort by design — a ledger failure must
 * never break a prompt, a tool call, or an optimize run.
 *
 * Event shapes (all carry ts):
 *   check    — hook deep-parsed a session   {ev?: undefined|"check", sid, tok, warn}
 *              (pre-0.3.6 hook entries have no `ev` field; treated as checks)
 *   optimize — an optimization was applied  {ev: "optimize", src: "cli"|"mcp", saved, model?}
 */

import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface LedgerEntry {
  ts: number;
  ev?: "check" | "optimize";
  sid?: string;
  tok?: number;
  warn?: boolean;
  src?: "cli" | "mcp";
  saved?: number;
  model?: string;
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
    // Cap growth: past ~256KB keep the most recent 500 entries.
    if (existsSync(path) && statSync(path).size > 256 * 1024) {
      const lines = readFileSync(path, "utf8").trimEnd().split("\n");
      writeFileSync(path, lines.slice(-500).join("\n") + "\n");
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
