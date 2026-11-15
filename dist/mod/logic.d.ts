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
/** The band shows within this long of the cache going cold... */
export declare const WARN_BEFORE_MS: number;
/**
 * ...or within this share of the cache's life, when that is shorter: the last
 * minute of a 5-minute cache (WARN_BEFORE_MS would be all of it, the band
 * after every turn), the last five of the 1-hour cache.
 */
export declare const WARN_SHARE: number;
/** How long before the cache goes cold the band warns, for a cache that lives `ttlMs`. */
export declare function warnBeforeMs(ttlMs: number): number;
/** The session price thresholds when the CLI cannot say them (no Node): the defaults, the environment's own, or none. */
export declare const DEFAULT_THRESHOLDS: number[];
/** CONTEXT_DOCTOR_SESSION_PRICE and CONTEXT_DOCTOR_NO_SESSION_PRICE read as sessionprice.ts reads them. */
export declare function thresholdsFrom(raw: string | undefined, off: string | undefined): number[];
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
/**
 * `/context-doctor-keep-warm <hours> [$cap]`: while the person is away, a
 * cache read of the session's whole context every 55 minutes (4.5 on a
 * 5-minute cache), through Claude Code's `$.model.fork`: the main thread's
 * last request again with one short message after it, the reply kept out of
 * the transcript, so the return reads the context instead of writing it
 * again. Only on that command (the yes), capped in hours and dollars, never
 * armed by itself or again after it stops.
 *
 * On the author's 30 days (2026-11-15) a 2-hour cap would have sent 918
 * pings ($87) and kept 56 of 183 cold returns warm ($275 of re-writes): $188
 * net. `cache-misses` prices it on your own history.
 */
export declare const KEEP_WARM_COMMAND = "context-doctor-keep-warm";
export declare const KEEP_WARM_MAX_HOURS = 8;
export declare const KEEP_WARM_DEFAULT_CAP_USD = 2;
export declare const KEEP_WARM_MAX_CAP_USD = 20;
/** A ping every this long keeps a 1-hour cache warm, and a 5-minute one (coldreturns.ts prices the same). */
export declare const PING_EVERY_1H_MS: number;
export declare const PING_EVERY_5M_MS = 270000;
/** The band's clock ticks this often: a ping goes out within one tick before its time, never after it. */
export declare const KEEP_WARM_TICK_MS = 30000;
/** Asks for haste in the prompt, not with `effort`: a level other than the session's could write the whole context again. */
export declare const PING_PROMPT = "context-doctor keep-warm: an automated cache refresh while the person is away, not a request. Reply with the single word ok, straight away, with no tools and without thinking it over.";
export type KeepWarmRequest = {
    kind: "off";
} | {
    kind: "status";
} | {
    kind: "arm";
    hours: number;
    capUsd: number;
} | {
    kind: "error";
    text: string;
};
/** The command's arguments: `2h`, `90m`, `2h $5`, `off`. None is a question, not a yes. */
export declare function parseKeepWarm(args: string | undefined): KeepWarmRequest;
/** One yes: its limits, what it has spent, and why it stopped. */
export interface KeepWarm {
    armedAt: number;
    until: number;
    capUsd: number;
    spentUsd: number;
    pings: number;
    lastPingAt?: number;
    stopped?: string;
}
export declare const pingEvery: (ttlMs: number) => number;
/** What a ping should cost: one read of the context (the band's per-message figure), and a little more for the prompt and reply. */
export declare function pingEstimateUsd(d: BandData): number | undefined;
/** Why keeping warm cannot start now, or undefined when it can. */
export declare function keepWarmRefusal(d: BandData | undefined, now: number): string | undefined;
export type KeepWarmStep = {
    do: "wait";
} | {
    do: "ping";
} | {
    do: "stop";
    why: string;
};
/**
 * What the timer does at `now`: wait, ping, or stop for good. A ping is due
 * a tick before its interval is up after the last request or ping, so it
 * lands inside the cache's life; a cache that lapsed anyway (Claude Code
 * closed, the machine asleep) is not pinged, since that ping would write the
 * whole context.
 */
export declare function keepWarmStep(kw: KeepWarm | undefined, d: BandData | undefined, now: number): KeepWarmStep;
/** A ping's usage as `$.model.fork` reports it. */
export interface PingUsage {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
}
/**
 * What a ping read and cost. Warm: it read the context and wrote little
 * (the fork's own tail is never cached). Priced from the band's figures: a
 * read at the per-message rate, a write at the session's re-write rate,
 * uncached input at that over the TTL's multiple (2x for 1 hour, 1.25x for
 * 5 minutes), output at 5x input (every current Claude model). An estimate.
 */
export declare function pingOutcome(u: PingUsage, d: BandData): {
    warm: boolean;
    usd: number;
};
/** The band while keeping warm: for how long more, what it has spent, against its limit. */
export declare function keepWarmText(kw: KeepWarm, now: number): string;
/** What the command says when it arms. */
export declare function keepWarmArmedText(kw: KeepWarm, d: BandData): string;
/** The command with no arguments: the price of a yes, or how the one in force stands. Arms nothing. */
export declare function keepWarmStatusText(kw: KeepWarm | undefined, d: BandData | undefined, now: number): string;
/** `mod usage`'s answer (usagepane.ts prints exactly this shape). */
export interface ModelUse {
    model: string;
    usd: number;
    tokens: number;
    requests: number;
}
export interface PeriodUse {
    key: "today" | "7d" | "30d";
    label: string;
    usd: number;
    tokens: number;
    requests: number;
    models: ModelUse[];
}
export interface HistoryUse {
    at: number;
    periods: PeriodUse[];
    unpriced?: number;
    usdPerPct?: Partial<Record<string, number>>;
}
export interface LimitWindow {
    window: string;
    label: string;
    pct: number;
    at: number;
    resetsAt?: number;
    resetSince: boolean;
    perHour?: number;
    runsOutAt?: number;
    beforeReset?: boolean;
    usdPerPct?: number;
}
export interface AgentUse {
    id: string;
    model?: string;
    contextTokens?: number;
    window?: number;
    usd?: number;
    requests?: number;
}
export interface UsagePaneData {
    at: number;
    history?: HistoryUse;
    historyFrom?: "cache" | "measured";
    historyMs?: number;
    limits: LimitWindow[];
    agents: AgentUse[];
}
/** What Claude Code said last (`session.measure`, or `$.session.usage()` when the pane opened). */
export interface LiveUsage {
    at: number;
    context?: {
        tokens?: number;
        window: number;
        percent?: number;
    };
    rateLimits?: RateLimitLike[];
    model?: string;
}
export interface RateLimitLike {
    kind: string;
    percentUsed: number;
    resetsAt?: string;
}
/** A subagent as `$.agent.list()` names it (the fields the pane reads). */
export interface AgentLike {
    id: string;
    type?: string;
    description?: string;
    status?: string;
    name?: string;
}
/** The agent statuses that count as running: started and not settled. */
export declare const RUNNING: Set<string>;
/** "claude-opus-5-5" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5"; anything else as it is. */
export declare function shortModel(id: string | undefined): string;
/** A bar of `width` cells, filled to `pct`: "██████░░░░". */
export declare function bar(pct: number, width?: number): string;
/** "41%", "0.4%", "100%". */
export declare function pctText(pct: number): string;
/** The context ring, for the surfaces that draw `Svg`: a circle filled to `pct`, the percent in its middle. */
export declare function ringSvg(pct: number, size?: number): string;
export interface UsageView {
    /** The context ring: its percent and its words. */
    context: {
        pct?: number;
        text: string;
    };
    limits: Array<{
        key: string;
        label: string;
        pct: number;
        text: string;
        sub?: string;
    }>;
    limitsNote?: string;
    /** One line per period: "Today $42.10 · 3.1M tokens". */
    periods: Array<{
        key: string;
        text: string;
    }>;
    /** The chosen period, by model. */
    period?: {
        key: string;
        label: string;
        rows: Array<{
            model: string;
            text: string;
        }>;
    };
    historyNote?: string;
    agents: Array<{
        key: string;
        head: string;
        text: string;
    }>;
    agentsNote?: string;
    /** For a minimized pane (the Desktop app's widget): one line. */
    glance: string;
    footer: string;
}
export interface UsageViewInput {
    data?: UsagePaneData;
    live?: LiveUsage;
    /** `$.agent.list()`'s rows; undefined when this Claude Code has no such call. */
    agents?: AgentLike[];
    /** Which period the by-model rows are for. */
    period?: PeriodUse["key"];
    loading?: boolean;
    error?: string;
    now: number;
}
/** The limit windows to show: the ledger's, each overlaid by Claude Code's own newer reading; a window only Claude Code has, from it alone. */
export declare function mergeLimits(ledger: LimitWindow[], live: LiveUsage | undefined): LimitWindow[];
/** Everything the usage pane says, as words; register.ts lays it out. */
export declare function usageView(v: UsageViewInput): UsageView;
/** The pane as lines of text: the command's answer where no surface draws the pane (`claude -p`, a headless host). */
export declare function usageText(view: UsageView): string;
/** How often the pane asks `mod usage` again: the history (cached by the CLI for as long) and the subagents while any runs. */
export declare const USAGE_HISTORY_EVERY_MS: number;
export declare const USAGE_AGENTS_EVERY_MS = 30000;
/**
 * Whether the pane asks `mod usage` now, and for what. Never while closed or
 * while a run is in flight; the history at most every 5 minutes; the
 * subagents and the limits every 30 s while a subagent runs or after a turn
 * moved them. Nothing on a draw: drawing only reads.
 */
export declare function usageDue(s: {
    open: boolean;
    loading: boolean;
    lastAt?: number;
    historyAt?: number;
    measuredAt?: number;
    agentsRunning: number;
}, now: number): false | {
    history: boolean;
};
/** The command the pane runs: the CLI's own. */
export declare function usageArgv(node: string, cli: string): string[];
/** Parse `mod usage`'s output; undefined when it is not one. */
export declare function parseUsage(stdout: string): UsagePaneData | undefined;
