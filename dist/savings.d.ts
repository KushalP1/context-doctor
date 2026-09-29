/**
 * `context-doctor savings`: what autopilot would have saved on YOUR recent
 * Claude Code sessions, measured, not modelled.
 *
 * Each session is replayed request by request, twice: as it was sent, and as
 * autopilot (autoclear.ts, the shipped class) would have sent it. Both arms
 * are priced the way the prompt cache bills (reads 0.1x, writes 1.25x, a
 * cold cache after an idle gap longer than the request's own TTL). The
 * difference between the arms is the saving. The baseline shown to the user
 * is not an estimate: it is the input the sessions were actually billed for,
 * read from the usage every transcript records.
 */
import { type AutoClearOptions } from "./autoclear.js";
export interface SessionSavings {
    path: string;
    project: string;
    model?: string;
    requests: number;
    /** Cache-weighted input actually billed (usage in the transcript), in base-input-token units. */
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
    sessions: SessionSavings[];
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
/** Replay one Claude Code transcript. Undefined when it holds too few requests to mean anything. */
export declare function replaySession(path: string, options?: AutoClearOptions, since?: number): SessionSavings | undefined;
export declare function estimateSavings(days?: number, options?: AutoClearOptions, paths?: string[], onProgress?: (done: number, total: number) => void): SavingsReport;
export declare function renderSavings(r: SavingsReport, autopilotOn?: boolean): string;
