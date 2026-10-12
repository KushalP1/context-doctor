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
import { LedgerEntry } from "./ledger.js";
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
export declare function proxySavings(ledger: LedgerEntry[], live: LiveProxyStats | null): ProxySavings;
export declare function buildImpactReport(proxyPort?: number): Promise<string>;
