/**
 * A session's own price, said once while it runs.
 *
 * The budget counts a day across tools; one session can cost $2,000 on its
 * own without anyone noticing that each message now re-reads ~470k tokens
 * (the author's `gantry-ai` audit: 2,795 requests, 1.3B cached tokens read).
 * So before each prompt (Claude Code's and Codex's UserPromptSubmit, Gemini
 * CLI's BeforeAgent) the hook adds up what this session has cost, subagents
 * included (they bill to it), and when it passes $25, $100 and $500 says so
 * to the user once: the cost so far, what each message of the main
 * conversation now costs at the model's cache-read rate (or, after an idle
 * that expired the cache, the re-write this message pays), and that
 * /compact or a handoff to a new session cuts it.
 *
 * To the user, not the model: compacting or moving to a new session is the
 * person's decision about their money, and only they can run /compact. The
 * cold-resume offer measured how a model-delivered offer fares (acted on 1
 * time in 33 before it got a line of its own), and a note in the model's
 * context costs every later request and can pull it off the task. The
 * heavy-context note already asks the model to offer a compaction.
 *
 * Fast and quiet. The cost is the budget ledger's per-transcript entry
 * (budget.ts refreshEntry), with the period starting at 0: a prompt reads
 * only what was appended since the last read. The entries are kept beside
 * the hook's per-session state, but written only once enough was read to be
 * worth keeping (SAVE_BYTES) or a threshold was said, so a session below
 * the first threshold costs a read of its last turns and writes nothing.
 * Each threshold is claimed by creating a file that must not exist yet
 * (`wx`), which exactly one of several hooks running at once can do. Once
 * the top threshold is said, the check is one stat.
 *
 * Thresholds: CONTEXT_DOCTOR_SESSION_PRICE (dollars, e.g. "50,200");
 * off: CONTEXT_DOCTOR_NO_SESSION_PRICE=1.
 */
import { type Tool } from "./spend.js";
import { type ResumeVerdict } from "./coldresume.js";
/** Where the hook speaks unless CONTEXT_DOCTOR_SESSION_PRICE says otherwise. */
export declare const SESSION_PRICE_THRESHOLDS: number[];
/** The thresholds in force, ascending; none when switched off. */
export declare function sessionPriceThresholds(env?: NodeJS.ProcessEnv): number[];
export interface SessionPrice {
    app: Tool;
    /** The threshold just passed. */
    threshold: number;
    usd: number;
    /** Subagents' part of `usd` (the Agent tool's). */
    subagentUsd: number;
    /** Workflow agents' part of `usd`. */
    workflowUsd?: number;
    /** Requests on a model with no list price, not in `usd`. */
    unpriced?: number;
    /** The part of `usd` priced at its model's family's row (an estimate). */
    estimatedUsd?: number;
    /** The main conversation's context at its last request, and its model. */
    tokens?: number;
    model?: string;
    /** What the next message pays to re-read that context from the cache. */
    readUsd?: number;
    /** The cache expired while idle: what this message pays to write it again. */
    coldUsd?: number;
}
export interface SessionPriceInput {
    sessionId: string;
    transcript: string;
    event?: string;
    model?: string;
    /** Claude Code's SessionStart verdict on a resumed cache, from the hook's state (read only when a threshold is due). */
    rv?: () => ResumeVerdict | undefined;
}
/**
 * The threshold this prompt is the first to pass, with what to say about
 * it, or undefined (below the first, said already, or anything unreadable).
 * Claims the threshold: a second call for the same one gets undefined.
 */
export declare function sessionPriceDue(input: SessionPriceInput, now?: number, env?: NodeJS.ProcessEnv): SessionPrice | undefined;
/** The line for the user (the hook's systemMessage). */
export declare function renderSessionPrice(p: SessionPrice): string;
