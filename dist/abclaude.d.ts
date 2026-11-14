/**
 * `context-doctor ab --via claude-code`: the A/B suite's tasks run through
 * the person's own Claude Code (`claude -p`), on the person's own sign-in,
 * one arm per model. No API key: on a claude.ai plan the runs draw on the
 * plan's usage limits, not dollars. It answers the question the subagent
 * lever (`fix`'s subagent-model) could not: does Sonnet 5.5 do the work Opus
 * 5.5 did, here, on this plan?
 *
 * Each run gets a fresh temporary copy of the task's tiny repository and one
 * `claude -p` in it, with every flag verified on Claude Code 2.1.311, 2.1.321
 * and 2.1.325 against a local mock Messages API (docs/ab.md):
 *
 *   --print, the prompt on stdin       (no positional after a variadic flag)
 *   --model <id>                       the arm
 *   --output-format stream-json --verbose
 *                                      the init event (version, tools, auth
 *                                      source), rate_limit_event, and the
 *                                      result: total_cost_usd, usage, num_turns
 *   --max-turns <n>                    (hidden; result subtype error_max_turns)
 *   --restricted                       file tools confined to the working
 *                                      directory; user, project and local
 *                                      settings ignored (their hooks and
 *                                      permission rules too)
 *   --safe-mode                        no CLAUDE.md, skills, plugins, hooks,
 *                                      MCP servers, agents or output styles
 *   --strict-mcp-config                no MCP server at all
 *   --disable-slash-commands
 *   --no-session-persistence           no transcript in ~/.claude/projects
 *                                      (nothing for the reports to count)
 *   --tools Read,Edit,Write,Glob,Grep,Bash
 *   --allowedTools "Read Edit Write Glob Grep Bash(node test.mjs)"
 *   --disallowedTools "Edit(test.mjs) Write(test.mjs)"
 *   --permission-mode dontAsk --permission-prompts none
 *                                      anything not allowed above is denied,
 *                                      nobody is asked
 *   --settings {"sandbox":{...}}       Claude Code's sandbox on, failing
 *                                      closed: the code `node test.mjs` runs
 *                                      cannot write outside the run folder
 *                                      and temp, or reach the network
 *   --max-budget-usd <usd>             only with --budget
 *
 * The hidden check scores the run as the Messages API arms are scored. The
 * tokens and cost are Claude Code's own (the result's usage and
 * total_cost_usd: on a plan, the list-price equivalent). A run past its time
 * limit is killed with its process group; Ctrl-C kills every run and removes
 * every folder. A usage limit reached mid-run (a rejected rate_limit_event,
 * or a result with API status 429) or a refused sign-in stops the suite: no
 * further run starts.
 *
 * A finished comparison is kept (the newest 20) beside the other state
 * files, so `fix` can quote it on the subagent-model line.
 */
import { type AbTask } from "./abtasks.js";
import { type AbStoredResult } from "./abstore.js";
/** The arms when none are named: the subagent lever's question. */
export declare const DEFAULT_CC_MODEL = "claude-sonnet-5-5";
export declare const DEFAULT_CC_COMPARE = "claude-opus-5-5";
/** Claude Code turns a run may take (it reads, edits and runs the check one tool at a time). */
export declare const DEFAULT_CC_MAX_TURNS = 30;
/** A run still going after this long is killed. */
export declare const DEFAULT_CC_TIMEOUT_S = 600;
/** The flags ab needs, as `claude --help` lists them (--max-turns is accepted but not listed). */
export declare const REQUIRED_FLAGS: string[];
/** The arguments of one run's `claude -p` (the prompt goes on stdin). */
export declare function claudeArgs(model: string, maxTurns: number, maxBudgetUsd?: number): string[];
export declare function claudeCodePrompt(task: AbTask): string;
/** The Claude Code ab runs: CONTEXT_DOCTOR_CLAUDE_BIN, else `claude` on PATH. */
export declare function claudeBin(): string;
export interface ClaudeCodeInfo {
    bin: string;
    version?: string;
    /** Flags ab needs that this Claude Code does not list. */
    missing: string[];
    loggedIn: boolean;
    /** `claude auth status`: claude.ai, api_key, oauth_token, ... */
    authMethod?: string;
    subscriptionType?: string;
    apiKeySource?: string;
    /** Why it cannot be used at all (not found, not runnable). */
    problem?: string;
}
/** `claude --version`, `--help` and `auth status --json`: all local, nothing sent to a model. */
export declare function inspectClaudeCode(bin?: string): ClaudeCodeInfo;
export interface AbModelRun {
    task: string;
    model: string;
    rep: number;
    /** The hidden check, run by the harness after Claude Code stopped. */
    pass: boolean;
    /** end_turn, turns (--max-turns), budget, limit (the plan's usage limit), timeout, or error. */
    stop: string;
    error?: string;
    /** Claude Code's num_turns. */
    turns: number;
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    /** Claude Code's total_cost_usd: on a plan, what the run would cost at list prices. */
    costUsd: number;
    wallMs: number;
    /** Tool calls Claude Code's permissions refused (outside the folder, the smoke test, other commands). */
    denied: number;
}
export interface AbModelOptions {
    models: string[];
    tasks?: AbTask[];
    repeat?: number;
    maxTurns?: number;
    /** Per run, ms. */
    timeoutMs?: number;
    /** No run starts once Claude Code's own costs reach this (each run gets its share as --max-budget-usd). */
    budgetUsd?: number;
    concurrency?: number;
    bin?: string;
    onRun?: (run: AbModelRun, done: number, total: number) => void;
}
export interface AbModelResult {
    via: "claude-code";
    /** ISO time the suite finished. */
    at: string;
    claudeCode: {
        version?: string;
        authMethod?: string;
        subscriptionType?: string;
    };
    models: string[];
    tasks: string[];
    repeat: number;
    runs: AbModelRun[];
    /** Claude Code's own total_cost_usd, summed: on a plan, list-price equivalent. */
    costUsd: number;
    /** Why the suite stopped before every run (a usage limit, a refused sign-in, Claude Code not starting). */
    aborted?: string;
}
export declare function runClaudeCodeAb(options: AbModelOptions, info?: Pick<ClaudeCodeInfo, "version" | "authMethod" | "subscriptionType">): Promise<AbModelResult>;
export interface ModelTotals {
    model: string;
    runs: number;
    /** Runs that ended on their own: the ones a pass rate is about. */
    completed: number;
    passed: number;
    stoppedEarly: number;
    tokens: number;
    costUsd: number;
}
export declare function modelTotals(result: Pick<AbModelResult, "models" | "runs">): ModelTotals[];
export declare function renderClaudeCodeAb(result: AbModelResult): string;
/** Keep a finished comparison for fix (the newest 20). */
export declare function storeAbResult(result: AbModelResult, path?: string): AbStoredResult;
export interface AbClaudeCodeCommandOptions {
    model?: string;
    compare?: string[];
    tasks: AbTask[];
    repeat?: number;
    maxTurns?: number;
    timeoutS?: number;
    concurrency?: number;
    budgetUsd?: number;
    yes: boolean;
    json: boolean;
    out?: string;
}
/** The arms: --model (default Sonnet 5.5), then each --compare (default Opus 5.5; "none" for none). */
export declare function modelsFor(model: string | undefined, compare: string[] | undefined): string[];
/** `context-doctor ab --via claude-code`: the exit code. */
export declare function abClaudeCodeCommand(o: AbClaudeCodeCommandOptions): Promise<number>;
