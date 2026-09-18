/**
 * Subagent accounting.
 *
 * Every session profile here excludes subagent traffic, correctly: a subagent
 * has its own context window, so its tokens are not in the parent's context.
 * But they are on the parent's bill. Claude Code writes each subagent to its
 * own transcript under `<session>/subagents/agent-<id>.jsonl`, next to the
 * parent's `<session>.jsonl` — which is why scanning the parent for
 * `isSidechain` entries found nothing for weeks. On this machine: 195
 * subagents across 19 sessions whose final contexts sum to 28 million tokens,
 * none of it ever shown.
 *
 * Reads only the lines that matter (usage, first user turn, timestamps) and
 * never the whole content, so a session with 49 subagents stays fast.
 */
export interface SubagentSummary {
    id: string;
    model?: string;
    /** What the parent asked it to do: first user message, trimmed. */
    task: string;
    /** API calls the subagent made (assistant turns carrying usage). */
    calls: number;
    /** Context size on its last call: what each further turn would have cost. */
    finalContextTokens: number;
    /** Input billed across all its calls, including cache reads and writes. */
    inputBilledTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    /** Cost across all calls at list price with cache-read discount. */
    estCostUsd?: number;
    durationMs?: number;
}
export interface SubagentReport {
    agents: SubagentSummary[];
    totalInputBilled: number;
    totalOutput: number;
    totalCostUsd: number;
    /** Agents whose model has no price on file, so the total undercounts. */
    unpriced: number;
}
/** Where Claude Code keeps a session's subagents: beside the transcript, under its id. */
export declare function subagentDir(transcriptPath: string): string;
/** Account for every subagent of a session, or null when there are none. */
export declare function subagentReport(transcriptPath: string): SubagentReport | null;
/**
 * @param parentInputUsd what the PARENT session's input actually cost across
 *   all its calls (from the cache analysis), so the comparison is total against
 *   total. Comparing against a per-call figure produced nonsense like "159x".
 */
export declare function renderSubagents(report: SubagentReport | null, parentInputUsd?: number, top?: number): string | null;
