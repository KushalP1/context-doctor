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
export interface FanoutState {
    /** Launch times this session, newest last (the last ten minutes). */
    spawns: number[];
    /** Types already priced for the user this session. */
    shown: string[];
    /** The model has had its one note this session. */
    told?: boolean;
}
/**
 * What to say before this subagent starts, and the session state after it.
 * The user sees the price the first time a type starts in a session and when
 * launches bunch up (3 within two minutes, then every 5th); the model gets
 * one short note per session, only where a cheaper model exists.
 */
export declare function fanoutMessage(input: FanoutInput, costs: SubagentCosts | undefined, state: FanoutState, now?: number): {
    systemMessage?: string;
    additionalContext?: string;
    state: FanoutState;
};
/** For `doctor` and the docs: where the medians come from. */
export declare function describeCosts(c: SubagentCosts | undefined): string;
/** The medians the subagent price quotes, for `context-doctor subagents`. */
export declare function renderCostMedians(c: SubagentCosts): string[];
