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
 * its baseline came within 9% of the billed figure on the author's history
 * (on the low side, so savings are, if anything, understated).
 */
export declare const MIN_WINDOW = 100000;
export declare const MAX_WINDOW = 1000000;
export interface WindowEstimate {
    window: number;
    baselineUsd: number;
    withWindowUsd: number;
    savedUsd: number;
    savedPct: number;
    /** Compactions there would be over the period with this window. */
    compactions: number;
}
export interface CompactWindowReport {
    days: number;
    sessions: number;
    /** Compactions that actually happened over the period (Claude Code's own, or /compact). */
    actualCompactions: number;
    estimates: WindowEstimate[];
}
export declare function estimateCompactWindows(windows: number[], days?: number, paths?: string[]): CompactWindowReport;
export declare function settingsPath(home?: string): string;
/** The autoCompactWindow Claude Code will use from user settings, if set. */
export declare function currentCompactWindow(home?: string): number | undefined;
/** Set (or with undefined, remove) autoCompactWindow in ~/.claude/settings.json. A .backup is kept. */
export declare function setCompactWindow(window: number | undefined, home?: string): void;
/** "400k" / "400000" / "0.4m" -> 400000. Undefined when unparseable. */
export declare function parseWindow(raw: string): number | undefined;
export declare function renderCompactWindows(r: CompactWindowReport, current?: number): string;
