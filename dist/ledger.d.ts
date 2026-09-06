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
/**
 * Reduce a set of entries to the totals the reports care about.
 *
 * Absorbs existing rollups, so folding stays correct across any number of
 * rotations rather than only the first.
 */
export declare function foldTotals(entries: LedgerEntry[]): CarriedTotals;
export declare function statePath(): string;
export declare function ledgerPath(): string;
export declare function recordLedger(entry: Omit<LedgerEntry, "ts">): void;
export declare function readLedger(): LedgerEntry[];
