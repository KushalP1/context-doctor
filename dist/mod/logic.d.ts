/**
 * What the context-doctor mod shows and runs, as plain functions.
 *
 * The mod (register.ts) runs inside Claude Code's mods runtime, which has no
 * Node: no fs, no child_process, no imports of the rest of context-doctor.
 * So everything it decides is here, with no imports at all, and the measuring
 * and the writing are done by the CLI it runs (`context-doctor mod measure`,
 * `fix --apply`, `fix undo`), the same code as in a terminal. The node test
 * suite exercises these functions directly.
 */
/** What `context-doctor mod measure` prints after a turn: the band's inputs. */
export interface BandData {
    /** When it was measured, ms. */
    at: number;
    /** context-doctor's price of the session so far, subagents included. */
    usd?: number;
    /** Claude Code's own cost of the session so far (`session.measure`'s `cost.usd`). */
    ccUsd?: number;
    /** The main conversation's context at its last reply, and its model. */
    tokens?: number;
    model?: string;
    /** When that reply was written, ms, and how long the cache it left lives. */
    lastReplyAt?: number;
    ttlMs?: number;
    /** Past the cache's lifetime by this much, a return counts as cold (coldresume.ts). */
    coldMarginMs?: number;
    /** What the next message pays to write the context again once the cache is cold. */
    rewriteUsd?: number;
    /** What each later message pays to re-read it, and what it would after a compaction. */
    perMessageUsd?: number;
    afterCompactPerMessageUsd?: number;
    /** The context Claude Code compacts at by itself: no offer at or past it. */
    autoCompactAt?: number;
    /** Below this context, a cold return is cheap: no offer. */
    coldMinTokens: number;
    /** Session price thresholds in force (CONTEXT_DOCTOR_SESSION_PRICE), ascending. */
    thresholds: number[];
}
export type Surface = "terminal" | "desktop" | "vscode" | "mobile" | string;
/** One band, or none. `key` names what Hide hides, so the next state shows again. */
export type Band = {
    kind: "none";
} | {
    kind: "warm" | "expired" | "price";
    key: string;
    text: string;
} | {
    kind: "cold";
    key: string;
    text: string;
    compact: string;
};
/** The band shows within this long of the cache going cold. */
export declare const WARN_BEFORE_MS: number;
/** "$0.42", "$3.10", "$112", "$1,240". */
export declare function money(n: number): string;
/** "820", "45k", "520k", "1.2M". */
export declare function tokens(n: number): string;
/** "3 min", "1h 20m", "2 days". */
export declare function duration(ms: number): string;
/** The highest session price threshold `usd` has passed, or undefined. */
export declare function passedThreshold(usd: number | undefined, thresholds: number[]): number | undefined;
/** The session's price as the band says it, with Claude Code's own figure beside ours when both are known. */
export declare function priceText(d: Pick<BandData, "usd" | "ccUsd">): string | undefined;
export interface BandOptions {
    /** Keys the person hid this session. */
    hidden?: ReadonlySet<string>;
    /** CONTEXT_DOCTOR_MOD_BAND=always: show the cache clock and the price at all times, not only when they pay. */
    always?: boolean;
}
/**
 * The band above the prompt at `now`. Quiet unless it pays (the cache about
 * to go cold, or gone cold, on a context worth caring about; the session
 * past a price threshold), except with `always`. The terminal has the
 * status line for the clock and the price, so there the band shows only the
 * cold return, the one thing with a button. Nothing on mobile.
 */
export declare function band(d: BandData | undefined, now: number, surface: Surface, opts?: BandOptions): Band;
/** A lever as `context-doctor fix --json` prints it (the fields the pane reads). */
export interface PlanFix {
    id: string;
    title: string;
    savedUsd?: number;
    savedShare?: number;
    shareOf?: string;
    basis?: string;
    quality?: string;
    change?: string;
    state: "available" | "applied" | "not-here";
    note?: string;
    overriddenBy?: string[];
    tooOld?: string;
}
export interface PlanJson {
    days: number;
    billedUsd: number;
    fixes: PlanFix[];
    since?: Array<{
        id: string;
        at: number;
        savedUsd?: number;
        detail?: string;
    }>;
    recordProblem?: string;
}
/** One row of the pane: what it says, and which buttons it has. */
export interface PaneRow {
    id: string;
    head: string;
    lines: string[];
    /** The subagents' model: a model change, said on the row and on its button. */
    modelChange: boolean;
    apply?: string;
    undo?: string;
}
/** The lever that changes which model runs: never applied by `--apply all`, and marked as such here. */
export declare const MODEL_CHANGE = "subagent-model";
/** Parse `fix --json`'s output; undefined when it is not a plan. */
export declare function parsePlan(stdout: string): PlanJson | undefined;
/**
 * The pane's rows: every lever the plan names, available ones first (the
 * plan's own order), each with Apply when it is available and Undo when
 * `fix` applied it (it is in the record, which is what `fix undo` reverts).
 */
export declare function paneRows(plan: PlanJson): PaneRow[];
/**
 * The rows after presses made since the plan was measured: an applied lever
 * offers Undo, an undone one nothing until the plan is measured again (its
 * figures are the old plan's). Measuring takes a while, so a press does not
 * re-measure by itself; the pane offers Refresh.
 */
export declare function withPresses(rows: PaneRow[], presses: ReadonlyMap<string, "applied" | "undone">): PaneRow[];
/** A lever id the CLI accepts: letters, digits and hyphens (never an option, never a path). */
export declare function isFixId(id: string): boolean;
/** The command a button runs: the CLI's own, so the files it writes are the CLI's. */
export declare function fixArgv(node: string, cli: string, op: "plan" | "apply" | "undo", id?: string): string[];
/** What `fix --apply <id> --json` did, from its `applied` list; the text form's lines otherwise. */
export declare function applyOutcome(stdout: string, stderr: string, exitCode: number): {
    ok: boolean;
    lines: string[];
};
/** The CLI's lines, without the plan it prints first: what the press did. */
export declare function outcome(stdout: string, stderr: string, exitCode: number): {
    ok: boolean;
    lines: string[];
};
