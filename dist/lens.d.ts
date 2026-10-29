/**
 * Two costs the other reports do not show: the output side of the bill, and
 * polling.
 *
 *  - Output and reasoning: what share of a session's (or a period's) cost is
 *    output tokens, and of those the reasoning (Claude's
 *    `output_tokens_details.thinking_tokens`, Codex's
 *    `reasoning_output_tokens`), per model. Only shown: whether shorter output
 *    keeps quality is a question for `context-doctor ab`, so no saving is
 *    claimed here.
 *  - Polling: a tool call identical to the one before it (same tool, same
 *    input), as a wait-and-check loop makes (BashOutput on one shell, Codex's
 *    `wait` or `write_stdin` with nothing to write, `sleep 30 && tail log`).
 *    Each repeat is a whole request that re-reads the context; it is priced
 *    at that request's billed cost.
 */
import { type Extractor } from "./scan.js";
export interface ModelOutput {
    model: string;
    requests: number;
    outputTokens: number;
    /** Reasoning (thinking) tokens within the output, where the usage records them. */
    reasoningTokens: number;
    outputUsd: number;
    totalUsd: number;
}
export interface PollStats {
    /** Calls identical to the call before them. */
    repeats: number;
    /** The requests that issued them, at list price. */
    usd: number;
    /** Context those requests re-read. */
    contextTokens: number;
    byTool: Array<{
        tool: string;
        repeats: number;
        usd: number;
    }>;
}
export interface Lens {
    sessions: number;
    byModel: ModelOutput[];
    polls: PollStats;
    totalUsd: number;
}
export declare const LENS_ROWS: Extractor<null>;
/** One session transcript (Claude Code or Codex). */
export declare function sessionLens(path: string, since?: number): Lens;
/** Every Claude Code (and, unless `claudeOnly`, Codex) session touched in the last `days`. */
export declare function lensOverSessions(days?: number, opts?: {
    claudeOnly?: boolean;
    paths?: string[];
    now?: number;
}): Lens;
/** Lines for `session` and `savings` (within 60 columns), or none when nothing is priced. */
export declare function renderLens(l: Lens, opts?: {
    heading?: boolean;
}): string[];
