/**
 * The subagents' model: what they cost as billed, and what the same requests
 * would cost on a cheaper model, per agent type. The `subagent-model` lever
 * of `fix`.
 *
 * Claude Code reads `CLAUDE_CODE_SUBAGENT_MODEL` ("inherit" by default: a
 * subagent runs on the main conversation's model). Read from the 2.1.309
 * binary (the function that picks a subagent's model), highest first:
 *  1. the Agent call's own `model` parameter;
 *  2. the agent definition's `model` (an agent file's frontmatter; the
 *     built-ins: Explore, Plan and fork say "inherit", claude-code-guide
 *     "haiku", statusline-setup "sonnet"; general-purpose and claude name
 *     none);
 *  3. CLAUDE_CODE_SUBAGENT_MODEL, unless it is empty or "inherit" (this
 *     function treats "default" as a model name; Claude Code's fallback
 *     chain treats it like "inherit");
 *  4. the main conversation's model.
 * So the variable moves only the agents whose definition names no model
 * (general-purpose, claude, agents of your own without `model:`).
 * CLAUDE_CODE_SUBAGENT_MODEL_FORCE makes it win over 1 and 2 as well (forks
 * still inherit). 2.1.62 read the variable too, ahead of everything. Claude
 * Code applies every settings file's `env` block to its own process at
 * start, so the variable can live in ~/.claude/settings.json.
 *
 * The replay prices each subagent request twice: as billed (its recorded
 * usage at its model's list price, cache writes at each TTL's multiplier,
 * output as settled on the reply's last row), and at the candidate model,
 * for the requests the variable would move that ran on a pricier model.
 * The token counts stay as they were: an estimate, since another model
 * tokenizes differently and may take more or fewer steps for the same task.
 * Requests on a model no pricier than the candidate stay as billed.
 */
import { type Extractor } from "./scan.js";
import { SUBAGENT_CANDIDATE, SUBAGENT_CANDIDATE_NAME } from "./subagentpay.js";
export { SUBAGENT_CANDIDATE, SUBAGENT_CANDIDATE_NAME };
/** The environment variable the lever writes. */
export declare const SUBAGENT_MODEL_ENV = "CLAUDE_CODE_SUBAGENT_MODEL";
export declare const SUBAGENT_MODEL_FORCE_ENV = "CLAUDE_CODE_SUBAGENT_MODEL_FORCE";
/**
 * One record per reply: its usage, time and model when first met; a top-up
 * of its output count when a later row of the same reply carries more
 * (subagent replies are written as they stream; output is final only on the
 * last row); the working folder once, to find the project's agent files.
 */
export declare const SUBAGENT_ROWS: Extractor<{
    out: Record<string, number>;
    cwd: boolean;
}>;
/** An agent's definition as far as the model goes: undefined when it names none. */
export interface AgentDefinition {
    model?: string;
    where: string;
}
/**
 * The agent definitions Claude Code uses in `cwd`, as 2.1.309 merges them,
 * lowest first: the user's (~/.claude/agents), the project's (outer folders
 * first), then managed. Plugin agents are not read.
 */
export declare function agentDefinitions(cwd: string | undefined, home?: string, env?: NodeJS.ProcessEnv): Map<string, AgentDefinition>;
/** How a type's model is chosen: whether CLAUDE_CODE_SUBAGENT_MODEL moves it, and why not. */
export declare function variableMoves(type: string, defs: Map<string, AgentDefinition>, force?: boolean): {
    moves: boolean;
    why?: string;
};
export interface TypeReplay {
    type: string;
    agents: number;
    requests: number;
    billedUsd: number;
    /** The same requests with the ones the variable moves at the candidate model. */
    atCandidateUsd: number;
    /** Every request of this type at Haiku 5.5's base rates (a floor: see over100k). */
    atHaikuUsd: number;
    /** Requests whose prompt was over 100k tokens, which Haiku 5.5 bills at a higher rate not priced here. */
    over100k: number;
    moves: boolean;
    why?: string;
    readOnly: boolean;
}
export interface SubagentModelReplay {
    candidate: string;
    agents: number;
    requests: number;
    billedUsd: number;
    atCandidateUsd: number;
    /** billed - at candidate. */
    savedUsd: number;
    /** The moved requests' bill by the model they ran on (the names in the plan's title). */
    movedFrom: Record<string, number>;
    /**
     * Every request of the types the variable moves, Sonnet-or-cheaper ones
     * included, by the model it ran on, weighted by its tokens (priced at the
     * candidate's rates): the mix "saved since" prices those types at after
     * the change, when every one of them is on the candidate.
     */
    before: Record<string, number>;
    /** Requests on models with no price (left out of the dollars). */
    unpriced: number;
    byType: TypeReplay[];
}
export interface SubagentModelOptions {
    since: number;
    until?: number;
    /** Subagent transcripts (default: those written since `since`). */
    paths?: string[];
    candidate?: string;
    /** CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on: the variable moves every type but forks. */
    force?: boolean;
    /** Agent definitions for every subagent (default: per subagent's folder, as agentDefinitions merges them). */
    definitions?: Map<string, AgentDefinition>;
    home?: string;
    /** Price every moved request at this mix of models (shares adding to 1) instead of the candidate: "saved since". */
    baseline?: Record<string, number>;
}
/** The agent type Claude Code recorded beside a subagent's transcript ("unknown" for an older one without it). */
export declare function agentTypeOf(transcript: string): string;
/**
 * Replay every subagent request in [since, until): as billed, and with the
 * requests CLAUDE_CODE_SUBAGENT_MODEL would move at the candidate model.
 * With `baseline`, the other arm prices the moved requests at the mix of
 * models they ran on before the change (prices are linear in each rate, so
 * a request at the blended rates costs the blend of its costs).
 */
export declare function replaySubagentModels(opts: SubagentModelOptions): SubagentModelReplay;
/** The models the moved requests ran on, for people: the one or two that carry 10%+ of the bill ("Fable 5.1 or Opus 5.5"). */
export declare function movedFromNames(movedFrom: Record<string, number>): string | undefined;
/** Each model's share of a total by model (a fix record keeps the shares of `before` as the baseline). */
export declare function shares(byModel: Record<string, number>): Record<string, number>;
/** A model id for people: "claude-opus-5-5" as "Opus 5.5". */
export declare function modelName(model: string | undefined): string;
/** The per-type lines under the lever in `fix`. */
export declare function renderSubagentTypes(r: SubagentModelReplay): string[];
/**
 * What the change saved since `since`: the moved types' requests priced at
 * the model they ran on before it, against as billed (an estimate, the same
 * token counts either way).
 */
export declare function subagentModelSavedSince(since: number, before: Record<string, number> | undefined, paths?: string[]): {
    usd: number;
    requests: number;
};
