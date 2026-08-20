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
export declare function statePath(): string;
export declare function ledgerPath(): string;
export declare function recordLedger(entry: Omit<LedgerEntry, "ts">): void;
export declare function readLedger(): LedgerEntry[];
