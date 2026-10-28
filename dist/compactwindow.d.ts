/**
 * `context-doctor compact-window`: compact earlier, automatically, in every
 * Claude Code surface, including the desktop app.
 *
 * Claude Code auto-compacts near the model's window. With a 1M-token window
 * that is ~970k (measured: 31 compactions on the author's machine, median
 * preTokens 970,119), so long sessions spend most of their life re-reading
 * 400k-900k tokens on every message. Claude Code has a native setting for
 * this, `autoCompactWindow` in ~/.claude/settings.json ("Auto-compact window
 * size"): it compacts as if the window were that size. It is a settings key,
 * not an environment variable, so the desktop app (which filters settings env
 * it sets itself) honours it, and no proxy or hook is involved.
 *
 * The trade-off is real: more compactions, each replacing history with a
 * summary. So this measures both sides on the user's own history and changes
 * nothing until asked. The replay uses the usage every transcript records;
 * its baseline came within 9% of the billed figure on the author's history.
 * Like `savings`, the replay decides each session's SHARE saved, and that
 * share is applied to what the session was billed (its recorded usage at
 * list price): "as now" is the same billed figure `savings` shows, over the
 * same sessions (10+ requests in the window), so the two never disagree.
 */
export declare const MIN_WINDOW = 100000;
export declare const MAX_WINDOW = 1000000;
export interface WindowEstimate {
    window: number;
    /** Input billed as the sessions ran ("as now"): recorded usage at list price, as `savings` reports it. */
    baselineUsd: number;
    /** The replay's own model of the same baseline, from which each session's share saved is taken. */
    replayBaselineUsd: number;
    withWindowUsd: number;
    savedUsd: number;
    savedPct: number;
    /** Compactions there would be over the period with this window. */
    compactions: number;
}
export interface CompactWindowReport {
    days: number;
    /** Sessions with 10+ requests in the period: the ones replayed (the same rule as `savings`). */
    sessions: number;
    /** Claude Code transcripts written in the period, replayed or not. */
    transcripts: number;
    /** Compactions that actually happened over the period (Claude Code's own, or /compact). */
    actualCompactions: number;
    /** Of those, Claude Code's idle compactions (a quiet session compacted before its cache expired). */
    idleCompactions?: number;
    estimates: WindowEstimate[];
    /** Re-read tokens charged to each simulated compaction (0 when not measured). */
    rereadTokens?: number;
}
export declare function estimateCompactWindows(windows: number[], days?: number, paths?: string[], rereadTokens?: number, onProgress?: (done: number, total: number) => void): CompactWindowReport;
/** "37 sessions with 10+ requests (of 85 transcripts)": what the replayed reports count, said the same way. */
export declare function sessionsLabel(sessions: number, transcripts: number): string;
export declare function settingsPath(home?: string): string;
/**
 * The auto-compact window Claude Code will use, when it is a number: managed,
 * project and user settings merged, CLAUDE_CODE_AUTO_COMPACT_WINDOW first
 * (CLAUDE_CONFIG_DIR honoured). Undefined when none is set or it is "auto".
 */
export declare function currentCompactWindow(home?: string, env?: NodeJS.ProcessEnv, cwd?: string): number | undefined;
/** What keeps a user-level autoCompactWindow from taking effect: environment, project or managed settings, per-model windows. */
export declare function compactWindowBlockers(home?: string, env?: NodeJS.ProcessEnv, cwd?: string): string[];
/** What setCompactWindow did, so the CLI can say exactly that. */
export interface SetWindowResult {
    /** False when the setting already was what was asked (or, for off, was never set). */
    changed: boolean;
    /** settings.json did not exist and was created. */
    created: boolean;
    /** The copy of the previous settings.json, when there was one to copy. */
    backup?: string;
    /** The value before, as written (undefined: not set). */
    previous?: unknown;
}
/**
 * Set (or with undefined, remove) autoCompactWindow in the user's
 * settings.json, editing only that key. Nothing is written when nothing
 * changes: `off` with no window set used to create a settings.json of `{}`.
 * A .backup is kept when there was a file.
 */
export declare function setCompactWindow(window: number | undefined, home?: string): SetWindowResult;
/** "400k" / "400000" / "0.4m" -> 400000. Undefined when unparseable. */
export declare function parseWindow(raw: string): number | undefined;
export declare function renderCompactWindows(r: CompactWindowReport, current?: number, limitLines?: (estimates: WindowEstimate[]) => string[]): string;
