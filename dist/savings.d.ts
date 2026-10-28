/**
 * `context-doctor savings`: what autopilot would have saved on YOUR recent
 * Claude Code sessions, measured, not modelled.
 *
 * Each session is replayed request by request, twice: as it was sent, and as
 * autopilot (autoclear.ts, the shipped class) would have sent it. Both arms
 * are priced the way the prompt cache bills (reads at the model's cache-read
 * rate, writes at the session's own 5-minute/1-hour TTL mix, a cold cache
 * after an idle gap longer than the request's own TTL). The difference
 * between the arms is the saving. The baseline shown to the user is not an
 * estimate: it is the input the sessions were actually billed for, read from
 * the usage every transcript records, each request at its own model's price.
 */
import { type AutoClearOptions } from "./autoclear.js";
export interface SessionSavings {
    path: string;
    project: string;
    model?: string;
    requests: number;
    /**
     * Cache-weighted input actually billed (usage in the transcript), in
     * base-input-token units: reads at 0.1x, writes at 1.25x (5-minute TTL)
     * or 2x (1-hour TTL) as each request recorded them.
     */
    billedWeighted: number;
    billedUsd: number;
    /** Replay difference, in the same units. */
    savedWeighted: number;
    savedUsd: number;
    /** Raw input tokens autopilot would not have sent. */
    savedTokens: number;
    savedPct: number;
    /** Claude Code surface that ran the session ("cli", "claude-vscode", "claude-desktop", ...). */
    entrypoint?: string;
    /** Can a settings-file ANTHROPIC_BASE_URL route this surface through autopilot? */
    autopilotReachable: boolean;
    /** Returns to this session after the cache expired, and what /compact then would have saved. */
    coldResumes: number;
    coldResumeNetUsd: number;
}
/**
 * The desktop app runs Claude Code "host-orchestrated": it sets
 * ANTHROPIC_BASE_URL itself and drops the same key from settings files, so
 * the autopilot proxy cannot sit in front of it (checked in Claude Code
 * 2.1.284). Terminal and IDE sessions read settings normally.
 */
export declare function autopilotReaches(entrypoint?: string): boolean;
export interface SavingsReport {
    days: number;
    /** Sessions with 10+ requests in the period: the ones replayed and counted. */
    sessions: SessionSavings[];
    /** Claude Code transcripts written in the period, replayed or not (the progress line's total). */
    transcripts: number;
    billedUsd: number;
    savedUsd: number;
    savedTokens: number;
    billedTokens: number;
    savedPct: number;
    worse: number;
    /** Autopilot's share in sessions it can actually reach. */
    reachableUsd: number;
    unreachableSessions: number;
    coldResumes: number;
    coldResumeNetUsd: number;
}
/**
 * One arm of the replay: the history as sent, priced incrementally at each
 * request's own model. Reads are priced as they go; writes are kept at the
 * input price and multiplied by the session's write TTL mix at the end
 * (`usd(writeMult)`), since the mix is only known once the whole transcript
 * has been read.
 */
/** What an arm needs from a clearer: autopilot's AutoClearer, or the simulated server-side rule (serverclear.ts). */
export interface ReplayClearer {
    apply(body: Record<string, unknown>, now: number): {
        firstChanged: number;
    };
}
/**
 * Replay one Claude Code transcript. Undefined when it holds too few requests
 * to mean anything. `runRows` is shared by every transcript of one report: a
 * forked session starts as a copy of its parent's history, which replays
 * here (it shapes the context) but was billed once, under the parent.
 * `coldRows` does the same for the cold-resume count, which reads the
 * transcript again after the replay has added its rows to `runRows`.
 */
export declare function replaySession(path: string, options?: AutoClearOptions, since?: number, runRows?: Set<string>, coldRows?: Set<string>, makeClearer?: (model?: string) => ReplayClearer, replay?: boolean): SessionSavings | undefined;
export declare function estimateSavings(days?: number, options?: AutoClearOptions, paths?: string[], onProgress?: (done: number, total: number) => void, replay?: boolean): SavingsReport;
/** Optional third lever, computed by compactwindow.ts and passed in by the CLI. */
export interface CompactWindowLine {
    window: number;
    savedUsd: number;
    compactionsPerWeek: number;
    nowPerWeek: number;
    isCurrent: boolean;
}
export declare function renderSavings(r: SavingsReport, autopilotOn?: boolean, cw?: CompactWindowLine, missLines?: string[], limitLines?: string[], lensLines?: string[]): string;
/**
 * `savings --share`: a few lines people can paste or screenshot. Totals only:
 * no project names, paths or session ids, so sharing it leaks nothing.
 */
export declare function renderShare(r: SavingsReport): string;
