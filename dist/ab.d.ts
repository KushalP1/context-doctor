/**
 * `context-doctor ab`: does a lever cost quality? Each task of a small suite
 * (abtasks.ts) runs with and without the lever, through the Messages API,
 * with a minimal agent loop (read_file, write_file, run_check), and is
 * scored by a hidden check the harness runs after the agent stops. Pass
 * counts, tokens and cost per arm, side by side: "no quality loss" as a
 * number rather than a proxy (re-reads, tool errors, corrections).
 *
 * Arms:
 *   none             the baseline: a plain system prompt and the three tools
 *   rules            + the standing context rules (what MCP clients and the
 *                    Copilot hook inject) in the system prompt
 *   autoclear        the client wrapped with withContextDoctor (autopilot in
 *                    process), every request treated as after an idle gap so
 *                    clearing is allowed on each one: the worst case for
 *                    quality, not autopilot's real cost
 *   pack             + a pack_context tool and the rule to use it for big
 *                    files instead of reading them whole
 *   compact-generic  one compaction mid-task with generic instructions; the
 *                    session then continues from the summary alone
 *   compact          the same compaction with the PreCompact hook's
 *                    instructions (files changed, failing checks, the user's
 *                    own instructions) added, as Claude Code merges them
 *
 * The agent's code runs (in the smoke test and the hidden check) with a
 * minimal environment (no API key, a throwaway HOME), in its own process
 * group, under a time limit; whatever it leaves running is killed and every
 * temporary folder is removed, on errors and Ctrl-C too. It is a quality
 * test, not a sandbox: the code runs as the user.
 *
 * It spends the caller's API budget, so the CLI prints the estimate first,
 * needs --yes to send anything, and sends no request whose worst case
 * (prompt as cache writes, max_tokens of output) would pass --budget. The
 * provider is an interface: anthropicProvider() speaks the Messages API over
 * fetch (this package has no runtime dependencies), and tests plug in a
 * local mock server through ANTHROPIC_BASE_URL.
 */
import { type AbTask } from "./abtasks.js";
import { type ModelPricing, type RecordedUsage } from "./pricing.js";
export declare const AB_LEVERS: readonly ["rules", "autoclear", "pack", "compact"];
export type AbLever = (typeof AB_LEVERS)[number];
export type AbArm = "none" | "rules" | "autoclear" | "pack" | "compact-generic" | "compact";
export declare const DEFAULT_AB_MODEL = "claude-opus-5-5";
/** The Messages API version the harness sends (sampling parameters are not sent). */
export declare const AB_API_VERSION = "2026-10-21";
export interface AbContentBlock {
    type: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    text?: string;
    [key: string]: unknown;
}
export interface AbResponse {
    content: AbContentBlock[];
    stop_reason?: string;
    usage?: RecordedUsage;
}
/** Anything that can answer a Messages API request. */
export interface AbProvider {
    readonly name: string;
    /** One request; rejects with an Error carrying `status` on an HTTP error. */
    create(body: Record<string, unknown>): Promise<AbResponse>;
}
/**
 * The Messages API over fetch. Retries what the API asks to be retried
 * (429, 5xx, 529 overloaded) and what the network breaks (a refused
 * connection, a body cut short, a 200 whose body is not the message), with
 * backoff, honouring retry-after. Anything else is the caller's error and
 * is thrown with its status, so the SDK wrapper can recognise a refused
 * history edit and the suite can stop on a refused key.
 */
export declare function anthropicProvider(options: {
    apiKey: string;
    baseUrl?: string;
    retries?: number;
    timeoutMs?: number;
}): AbProvider;
export interface AbRun {
    task: string;
    arm: AbArm;
    rep: number;
    /** The hidden check, run by the harness after the agent stopped. */
    pass: boolean;
    /** Why the loop ended: end_turn, turns (the cap), budget, error, or the API's stop_reason. */
    stop: string;
    error?: string;
    requests: number;
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    costUsd: number;
    wallMs: number;
    /** What the lever did: requests autopilot changed, pack_context calls, or compactions. */
    leverUses: number;
    /** autoclear: tokens it kept off the wire, over all requests. */
    leverTokens: number;
}
/** Ends that say nothing about the lever: the API failed or declined, or the harness's own caps cut the run. */
export declare const STOPPED_EARLY: Set<string>;
export interface AbOptions {
    provider: AbProvider;
    model?: string;
    tasks?: AbTask[];
    levers?: readonly AbLever[];
    repeat?: number;
    /** Requests per run, the compaction's included, before the loop is stopped (default 16). */
    maxTurns?: number;
    /** No request is sent whose worst case would take the spend past this, USD. */
    budgetUsd?: number;
    /** Runs in flight at once (default 4). */
    concurrency?: number;
    /** compact arms: compact after this many requests (default 2). */
    compactAfter?: number;
    /** Time limit for each smoke test and hidden check, ms (default 30,000). */
    checkTimeoutMs?: number;
    /** Called as each run finishes. */
    onRun?: (run: AbRun, done: number, total: number) => void;
}
/**
 * The verdict on files as they stand, for the tests and the self-check:
 * a fresh run folder with `files`, the hidden check, everything removed.
 */
export declare function abVerify(task: AbTask, files?: Record<string, string>): Promise<boolean>;
/** The arms a set of levers needs: one shared baseline for rules, autoclear and pack; compact brings its own. */
export declare function armsFor(levers: readonly AbLever[]): AbArm[];
export interface AbEstimate {
    runs: number;
    /** With prompt caching: each token written once, then read at the cache rate. */
    expectedUsd: number;
    /** As if nothing cached: every request's whole prompt at the input rate. */
    upperUsd: number;
}
/**
 * A planning figure, not a quote: six requests a run, the task's files in
 * context from the second request on, ~800 output tokens a request (thinking,
 * tool calls, the files the agent writes).
 */
export declare function estimateAb(tasks: AbTask[], arms: AbArm[], repeat: number, pricing: ModelPricing): AbEstimate;
export interface AbResult {
    model: string;
    provider: string;
    tasks: string[];
    levers: AbLever[];
    arms: AbArm[];
    repeat: number;
    runs: AbRun[];
    spentUsd: number;
    /** Why the suite stopped before every run (the API refused the key). */
    aborted?: string;
}
export declare function runAbSuite(options: AbOptions): Promise<AbResult>;
export interface ArmTotals {
    runs: number;
    /** Runs that ended on their own: the ones a pass rate is about. */
    completed: number;
    passed: number;
    stoppedEarly: number;
    tokens: number;
    costUsd: number;
    leverUses: number;
    leverTokens: number;
}
/** Per arm: runs, completed runs and their passes, runs stopped early, billed tokens, cost. */
export declare function summarizeAb(result: AbResult): Record<string, ArmTotals>;
/** Arms every one of whose runs ended on an API error: nothing was measured there. */
export declare function erroredArms(result: AbResult): AbArm[];
export declare function renderAb(result: AbResult): string;
export interface AbCommandOptions {
    levers?: string[];
    tasks?: string[];
    model?: string;
    repeat?: number;
    maxTurns?: number;
    concurrency?: number;
    budgetUsd?: number;
    /** Spend: without it the plan and estimate are printed and nothing is sent. */
    yes: boolean;
    json: boolean;
    out?: string;
    list: boolean;
}
/**
 * `context-doctor ab`: the exit code. 1 for a refusal, a bad argument, a key
 * the API refused, or an arm all of whose runs ended on an API error.
 */
export declare function abCommand(o: AbCommandOptions): Promise<number>;
