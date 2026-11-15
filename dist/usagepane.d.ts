/**
 * `context-doctor mod usage`: the figures behind the mod's usage pane
 * (ROADMAP F5), printed as JSON for the mod to draw.
 *
 * Claude Code's Desktop app dropped its usage view (anthropics/claude-code
 * #102264, #102098, #102130; #102094 the context ring) and 2.1.323 removed
 * `subagentStatusLine` (#109446). The pane puts them back from what is on
 * this machine:
 *
 *  - tokens and list-price dollars by model for today, 7 and 30 days, from
 *    the requests `spend` reads (claudeSpend, through the shared scan
 *    cache), kept in a small file for HISTORY_TTL_MS so a pane left open
 *    does not scan every refresh (warm, the scan is ~150 ms on the author's
 *    22,000 requests; cold, ~2.7 s);
 *  - the limit windows from the limits ledger (the 5-hour one only when the
 *    plan has it: Ultra has none), each with its pace, read on every refresh;
 *    and, with the history (it reads the transcripts over the readings'
 *    span), `limits`' per-reset figures (limitsByReset, ROADMAP F4): the
 *    list-price dollars per 1% of the current weekly window, or the last one
 *    that had a figure, and the latest move in that figure, dated;
 *  - each running subagent the mod names (from `$.agent.list()`): its
 *    model and context from its transcript's tail, its cost so far from the
 *    session's price entries, which the every-prompt hook and `mod measure`
 *    keep (sessionTotal: only what was appended since is read).
 *
 * The context ring itself is Claude Code's own figure (`session.measure`),
 * drawn by the mod with no run of this command.
 *
 * Silent like the status line: anything unreadable is left out, and the
 * command prints `{}` at worst and exits 0.
 */
import { type SpendItem } from "./spend.js";
import { type LimitReading, type LimitsByReset } from "./limits.js";
import type { AgentUse, HistoryUse, LimitWindow, UsagePaneData } from "./mod/logic.js";
/** The history part is measured again at most this often, whoever asks (two sessions' panes share it). */
export declare const HISTORY_TTL_MS: number;
export type { AgentUse, HistoryUse, LimitWindow, ModelUse, PeriodUse, UsagePaneData } from "./mod/logic.js";
export interface UsagePaneInput {
    sessionId?: string;
    cwd?: string;
    /** The running subagents' ids, as `$.agent.list()` gives them. */
    agents?: unknown;
    /** Leave the history out (a refresh for the subagents alone). */
    history?: boolean;
    /** Measure the history again even within HISTORY_TTL_MS (the pane's Refresh). */
    fresh?: boolean;
}
/** Sum the requests into today, the last 7 and the last 30 days, each by model, the most dollars first. */
export declare function summarizeHistory(items: SpendItem[], now: number): HistoryUse;
/**
 * What the pane takes of `limits`' per-reset view (F4): for each Claude
 * window, dollars per 1% of the current window (or of the last one that had
 * a figure: a new window has too few stretches), the latest move in that
 * figure, and whether the plan has no 5-hour window (Ultra).
 */
export declare function limitFitsOf(r: LimitsByReset): Pick<HistoryUse, "limitFits" | "limitMove" | "noFiveHour">;
/** The history part: from the cache while it is fresh, else measured (spend's scan, then the limit fits over the same requests). */
export declare function historyUse(now: number, fresh?: boolean): {
    h: HistoryUse;
    from: "cache" | "measured";
    ms: number;
};
/**
 * Each Claude window in the ledger, newest reading first, with its pace.
 * A window with no reading in the last 8 days is not shown: a plan with no
 * 5-hour window (Ultra) has only the weekly one.
 */
export declare function limitWindows(now: number, fits?: HistoryUse["limitFits"], readings?: LimitReading[]): LimitWindow[];
/** A subagent's model and context, from the last request in its transcript's tail. */
export declare function agentTail(file: string): {
    model?: string;
    contextTokens?: number;
};
/** Each running subagent's model, context and cost so far. */
export declare function agentUse(sessionId: string | undefined, cwd: string | undefined, list: unknown, now: number): AgentUse[];
/** Everything the pane draws but the context ring. Never throws. */
export declare function usagePane(input: UsagePaneInput, now?: number): UsagePaneData;
