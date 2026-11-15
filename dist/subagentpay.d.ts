/**
 * `context-doctor subagents`: which subagent tasks pay for themselves.
 *
 * The work costs money either way; the question is where it is cheaper. Done
 * in a subagent it costs the subagent's bill. Done in the parent, the same
 * steps would have run (at the parent's model price) with the parent's whole
 * context re-read on every step, and what they read would have stayed in the
 * parent for its later requests. Per subagent, all measured:
 *
 *   in a subagent = its bill
 *   in the parent = (bill - its own startup context) x parent/subagent price
 *                 + parent context at launch x steps x parent cache-read price
 *                 + (read - returned) x (W + 0.1 x later parent requests) x parent input price
 *
 * W is the parent's own cache-write price (1.25x input at the 5-minute TTL,
 * 2x at 1 hour, weighted by what the parent's usage records it wrote).
 *
 * "Read" is the tool output the subagent pulled in; "returned" is what the
 * parent received (tool result, or a background agent's task notification);
 * "later requests" run to the next compaction. Measured from transcripts and
 * subagents/<agent>.meta.json; nothing is sent anywhere.
 *
 * It ignores what a subagent buys besides context (parallel time, a clean
 * window for a hard task) and what the parent would have spent on its own tool
 * calls, so "did not pay" means "did not pay in context", not "was a mistake".
 */
import { type Extractor } from "./scan.js";
import { type ModelPricing } from "./pricing.js";
/**
 * The model `fix` offers the subagents (subagentmodel.ts): the id the price
 * table knows, which Claude Code's model catalog maps to every provider's
 * id. Kept here: the every-prompt hook loads this file, and should not load
 * the replay's.
 */
export declare const SUBAGENT_CANDIDATE = "claude-sonnet-5-5";
export declare const SUBAGENT_CANDIDATE_NAME = "Sonnet 5.5";
export interface SubagentPayback {
    id: string;
    type: string;
    task: string;
    costUsd: number;
    /** The same requests at Sonnet 5.5 where they ran on a pricier model, token counts as recorded (an estimate). */
    atSonnetUsd: number;
    /** What the same work would have cost in the parent. */
    inParentUsd: number;
    steps: number;
    parentContextTokens: number;
    readTokens: number;
    returnedTokens: number;
    laterRequests: number;
    /** What carrying (read - returned) would have cost the parent. */
    avoidedUsd: number;
    netUsd: number;
}
export interface PaybackReport {
    days: number;
    sessions: number;
    subagents: SubagentPayback[];
    /**
     * Workflow agents (subagents/workflows/<run>/): their bill, by run. Not
     * weighed against the parent: a workflow is work the parent hands off
     * whole, not a read it would otherwise do itself.
     */
    workflows?: {
        runs: number;
        agents: number;
        costUsd: number;
        atSonnetUsd: number;
        byRun: Array<{
            name: string;
            agents: number;
            costUsd: number;
            start: number;
        }>;
    };
}
/** A subagent's tokens by what they bill as: uncached input, cache reads, cache writes, output (settled). */
export interface SubagentTokens {
    input: number;
    read: number;
    write: number;
    output: number;
}
/**
 * What `subagents` takes from a subagent's transcript, through the shared
 * scan (scan.ts), so a second run reads only what was appended: each reply's
 * id, model, time and usage (every row, for the output a streamed reply
 * settles on its last: a later row keeps only that), and the tool output
 * each user row hands it, as tokens. The task is read from the transcript's
 * head when needed (subagentTask): the cache keeps no message text.
 */
export declare const SUBAGENT_ROWS: Extractor<{
    ids: Record<string, 1>;
}>;
/**
 * A subagent's task: the first user row with text, read from the
 * transcript's head (16 KB at a time, at most 1 MB): only for a subagent
 * whose meta file gives no description.
 */
export declare function subagentTask(path: string): string;
/**
 * What `subagents` takes from a parent transcript, through the shared scan:
 * its main-thread replies (time, model, prompt size, what changes their
 * rates, cache writes by lifetime), its compactions, and every row that
 * mentions one of its subagents (the Agent tool's result for that call, a
 * background agent's task notification), as tokens and the ids it names:
 * the calls of the Agent tool it made (kept in the state), and the ids a
 * notification names (`<task-id>`, `<tool-use-id>`, `agentId:`).
 */
export declare const PARENT_ROWS: Extractor<{
    calls: string[];
}>;
/**
 * A subagent's bill (each request as billed, requestCost), steps, startup
 * context, start time, the tool output it read, and the rates its first
 * request billed at. Read through the shared scan (SUBAGENT_ROWS).
 */
export declare function scanSubagent(path: string): {
    costUsd: number;
    atSonnetUsd: number;
    readTokens: number;
    steps: number;
    startup: number;
    start: number;
    model?: string;
    writeMult: number;
    rates?: ModelPricing;
    tokens: SubagentTokens;
};
export declare function subagentPayback(days?: number, paths?: string[], onProgress?: (done: number, total: number) => void): PaybackReport;
export declare function renderPayback(r: PaybackReport, top?: number): string;
