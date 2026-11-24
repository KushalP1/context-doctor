/**
 * context-doctor's mod: the status line's measurements and `fix`'s plan where
 * the status line never runs (Claude Code's Desktop app, the VS Code
 * extension), and in the terminal too.
 *
 * Shipped inside the plugin: hooks/hooks.json names this file under
 * `modules`. Claude Code runs mods from 2.1.287 (terminal), 2.1.286 (the
 * Desktop app's Code tab) and 2.1.299 (VS Code); an older one never loads
 * it and keeps the rest of the plugin.
 *
 *  - After each turn (`session.measure`) it runs `context-doctor mod measure`
 *    with Claude Code's rate-limit windows and session cost: the CLI keeps
 *    them (the limits ledger; Claude Code's cost beside ours) and answers
 *    with the band's figures.
 *  - A band above the prompt, only when it pays: the cache about to go cold
 *    or gone cold on a big context (with the re-write's price), the session
 *    past a price threshold. On a cold return a "Compact first" button calls
 *    `$.session.compact()`, between turns, on the press alone.
 *  - `/context-doctor-fix` opens a pane with `fix`'s plan and an Apply / Undo
 *    button per lever. Each press runs the CLI's own `fix --apply <id>` /
 *    `fix undo <id>`: the same lock, backup and record as in a terminal.
 *  - `/context-doctor-keep-warm 2h [$5]` keeps the prompt cache warm while
 *    the person is away: `$.model.fork` (a cache read of the main thread's
 *    last request, nothing in the transcript) a tick before every 55 minutes
 *    idle (4.5 on a 5-minute cache), until the hours or the dollars run out,
 *    a ping finds the cache cold, the session ends, or Stop. Never armed but
 *    by that command, never again by itself; the band shows it while it runs.
 *  - `/context-doctor-usage` opens the usage view the Desktop app dropped:
 *    the context ring and the limit windows from Claude Code's own figures,
 *    tokens and dollars by model for today, 7 and 30 days, and the running
 *    subagents with their model, context and cost so far, and under Context
 *    how long the prompt cache stays warm with the next message's price now
 *    and after it expires (the $.clock tick redraws it). Drawing only reads
 *    what the mod holds; `context-doctor mod usage` refreshes it on the
 *    timer, only while the pane is open (usageDue).
 *  - `tool.describe` (2.1.326+): once `fix --apply desktop-tools-defer`
 *    named the Desktop app's own MCP servers in CONTEXT_DOCTOR_DEFER_MCP,
 *    their tools go behind tool search from the next new conversation; never
 *    ccd_turn, never with `breakPromptCache`. Unset, nothing moves. Set or
 *    not, it notes each MCP server's transport, tool count and placement,
 *    and the next `mod measure` keeps them (changes only) for `fix` and
 *    `doctor`: proof the lever reaches the app before anyone applies it.
 *
 * Nothing happens without a press or a command: no auto-compaction, no auto-apply, no ping. The
 * mod writes no file itself; the CLI writes ours. Off: CONTEXT_DOCTOR_NO_MOD=1.
 *
 * The mods runtime has no Node, so this file imports only ./logic.js (no
 * imports of its own) and reaches everything else through `$`. Claude Code
 * reads which calls a module makes from its source: `$` is passed only to
 * functions declared at the top of this file.
 */
import { type AgentLike, type BandData, type KeepWarm, type LiveUsage, type PeriodUse, type PlanJson, type SeenServer, type UsagePaneData } from "./logic.js";
import type { On } from "./api.js";
export declare const COMMAND = "context-doctor-fix";
export declare const PANE = "context-doctor-fix";
export declare const USAGE_COMMAND = "context-doctor-usage";
export declare const USAGE_PANE = "context-doctor-usage";
/** The mod's state for this load (a reload starts it over; the next turn measures again). */
interface State {
    off: boolean;
    /** CONTEXT_DOCTOR_MOD_BAND: the band is off unless it says `cold` or `always`. */
    cold: boolean;
    always: boolean;
    /** The session price thresholds in force, for when the CLI cannot say them (no Node). */
    thresholds: number[];
    data?: BandData;
    hidden: Set<string>;
    drawn: string;
    compacting: boolean;
    plan?: PlanJson;
    planError?: string;
    loading: boolean;
    /** A press in flight ("apply:<id>"): never two at once. */
    busy?: string;
    last?: {
        id: string;
        ok: boolean;
        lines: string[];
    };
    presses: Map<string, "applied" | "undone">;
    /** The one keep-warm yes in force (or the last, stopped): never armed but by the command. */
    kw?: KeepWarm;
    /** A ping in flight: never two at once. */
    pinging: boolean;
    /** CONTEXT_DOCTOR_KEEP_WARM_PING_MS (the canary's): a ping this often instead of every 55 minutes. */
    pingEveryMs?: number;
    /** The usage pane: what `mod usage` said last, and when it is asked again. */
    usage?: UsagePaneData;
    usageOpen: boolean;
    usageLoading: boolean;
    usageError?: string;
    usageLastAt?: number;
    /** Claude Code's own figures from the last `session.measure`: the context ring and the windows. */
    live?: LiveUsage;
    /** `$.agent.list()`'s rows; undefined on a Claude Code without it. */
    agents?: AgentLike[];
    period: PeriodUse["key"];
    /** What the pane last said, so the timer redraws only when its words change. */
    usageDrawn: string;
    /** `session.start`'s surface, for the tools ledger. */
    surface?: string;
    /** The MCP servers `tool.describe` showed this session, and what `mod measure` was last handed of them. */
    tools: Map<string, SeenServer>;
    toolsSent: string;
}
/** For tests: the state the hooks share. */
export declare const state: () => State;
export declare function register(on: On): void;
export {};
