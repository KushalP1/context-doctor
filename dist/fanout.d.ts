/**
 * The fan-out guard: a price on a subagent before it starts.
 *
 * Claude Code launches subagents with its Agent tool (named Task before
 * 2.1.63; 2.1.308 still maps a "Task" matcher to it, 2.1.62 knows only
 * "Task", so the matcher is "Agent|Task"). Each one has its own context and
 * its own bill, and a fan-out of five is five bills, with nothing shown
 * before they start. A PreToolUse hook on that tool runs first: it answers
 * with a `systemMessage` the user sees, and once per session an
 * `additionalContext` note the model reads, and never a permission decision,
 * so the subagent always starts (verified in the hooks docs and both
 * binaries: no decision means the normal permission flow; a hook that fails
 * or times out does not block a PreToolUse call; only exit 2 would, and this
 * never exits 2). PreToolUse is in 2.1.62's event list, so it needs none of
 * PreModelSwitch's version guard.
 *
 * The price is the user's own: the median cost of the subagents of that
 * type (and model) in their transcripts, the same reading `context-doctor
 * subagents` does, cached for a day. Where the subagent would run on Opus or
 * Fable, the note gives the Sonnet price too: the Agent tool takes
 * `model: "sonnet"`.
 */
/** The subagent tool, by its current name and its pre-2.1.63 alias. */
export declare const FANOUT_MATCHER = "Agent|Task";
export interface CostStat {
    n: number;
    median: number;
    p90: number;
    /** The model most of these ran on. */
    model?: string;
}
export interface SubagentCosts {
    computedAt: number;
    days: number;
    /** Subagents measured (each priced at list price, as `subagents` does). */
    n: number;
    all?: CostStat;
    byType: Record<string, CostStat>;
    /** "<type>|<model>" */
    byTypeModel: Record<string, CostStat>;
    byModel: Record<string, CostStat>;
}
export declare function subagentCostsPath(): string;
/**
 * Each subagent's bill in the last `days`, newest transcripts first, by
 * type and model. `limit` and `budgetMs` bound the work when the hook has
 * to measure (the cache is a day old): the newest subagents are the best
 * guide anyway.
 */
export declare function measureSubagentCosts(days?: number, opts?: {
    limit?: number;
    budgetMs?: number;
    sessions?: string[];
    now?: number;
}): SubagentCosts;
export declare function saveSubagentCosts(c: SubagentCosts, path?: string): void;
/** The cached medians when under a day old, else measured now (bounded) and cached. */
export declare function subagentCosts(now?: number, path?: string): SubagentCosts | undefined;
export interface FanoutEstimate {
    type: string;
    model?: string;
    median: number;
    p90: number;
    runs: number;
    /** The Sonnet option, when the subagent would run on Opus or Fable. */
    cheaper?: {
        model: string;
        median: number;
        measured: boolean;
    };
}
/** What a subagent of this type on this model costs, from the user's own runs. Undefined with too few. */
export declare function estimateSubagent(costs: SubagentCosts, type: string, modelAlias?: string, parentModel?: string): FanoutEstimate | undefined;
/** PreToolUse input for the Agent tool, as far as this reads it. */
export interface FanoutInput {
    session_id?: string;
    transcript_path?: string;
    tool_name?: string;
    tool_input?: {
        subagent_type?: unknown;
        model?: unknown;
        description?: unknown;
        run_in_background?: unknown;
    };
}
/**
 * One launch, as the session's launch log records it. The log is appended
 * to before it is read, so hooks that run at once for a fan-out (one per
 * subagent) each see the launches before their own and decide alone:
 * exactly one is the first of its type, the third is the burst. A shared
 * state file read and written back by each would lose all but one write.
 */
export interface SpawnLine {
    t: number;
    type: string;
    /** Unique per launch. */
    id: string;
    /** This launch was quoted a cheaper model (the model gets one note, on the first such launch). */
    c: boolean;
}
/** The session's launch log, beside the hook's per-session state. */
export declare function spawnLogPath(sessionId: string): string;
/** Append this launch, then read the log back (its last 64 KB: hundreds of launches). */
export declare function recordSpawn(path: string, line: SpawnLine): SpawnLine[];
/** What a launch's input says: its type and the model alias it asks for. */
export declare function launchOf(input: FanoutInput): {
    type: string;
    alias?: string;
} | undefined;
/**
 * What to say before this launch, from the session's launch log (this one
 * included, as `own`). The user sees the price on the first launch of a type
 * in the session and when launches bunch up (3 within two minutes, then
 * every 5th); the model gets one short note a session, on the first launch
 * that was quoted a cheaper model.
 */
export declare function fanoutMessage(est: FanoutEstimate | undefined, alias: string | undefined, log: SpawnLine[], own: SpawnLine): {
    systemMessage?: string;
    additionalContext?: string;
};
/** The whole PreToolUse answer: estimate, log, decide. Silent (an empty object) for anything else. */
export declare function fanoutHook(input: FanoutInput, costs: SubagentCosts | undefined, sessionId: string, now?: number): {
    systemMessage?: string;
    additionalContext?: string;
};
/** For `doctor` and the docs: where the medians come from. */
export declare function describeCosts(c: SubagentCosts | undefined): string;
/** The medians the subagent price quotes, for `context-doctor subagents`. */
export declare function renderCostMedians(c: SubagentCosts): string[];
