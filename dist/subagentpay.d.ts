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
}
/** A subagent's bill (usage priced as the cache bills it), steps, startup context, start time and the tool output it read. */
export declare function scanSubagent(path: string): {
    costUsd: number;
    atSonnetUsd: number;
    readTokens: number;
    task: string;
    steps: number;
    startup: number;
    start: number;
    model?: string;
    writeMult: number;
};
export declare function subagentPayback(days?: number, paths?: string[], onProgress?: (done: number, total: number) => void): PaybackReport;
export declare function renderPayback(r: PaybackReport, top?: number): string;
