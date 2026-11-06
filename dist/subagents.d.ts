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
    /** API calls the subagent made (replies carrying usage, each counted once). */
    calls: number;
    /** Context size on its last call: what each further turn would have cost. */
    finalContextTokens: number;
    /** Input billed across all its calls, including cache reads and writes. */
    inputBilledTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    /** Cost across all calls at list price: cache reads discounted, writes priced by TTL. */
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
    /** How many of `agents` are workflow agents (subagents/workflows/<run>/), in how many runs. */
    workflowAgents?: number;
    workflowRuns?: number;
}
/** Where Claude Code keeps a session's subagents: beside the transcript, under its id. */
export declare function subagentDir(transcriptPath: string): string;
/**
 * Every subagent transcript of a session: the Agent tool's
 * (`subagents/agent-*.jsonl`) and the workflow agents'
 * (`subagents/workflows/<run>/agent-*.jsonl`, one folder per workflow run,
 * the run's own record in `<session>/workflows/<run>.json`). Workflow agents
 * bill to the session like any subagent, and every reader skipped their
 * folder: on the author's machine, 804 transcripts and ~$1,354 in 30 days.
 * `since`: only files written since then. `run`: the workflow run's id.
 */
export declare function subagentFiles(transcriptPath: string, since?: number): Array<{
    file: string;
    run?: string;
}>;
/** The workflow run a subagent transcript belongs to (its folder under subagents/workflows), or undefined. */
export declare function workflowRunOf(file: string): string | undefined;
/** A workflow run's own record, `<session>/workflows/<run>.json`: its name and default model, when Claude Code wrote one. */
export declare function workflowRunInfo(transcriptPath: string, run: string): {
    name?: string;
    model?: string;
    status?: string;
};
/** Account for every subagent of a session, or null when there are none. */
export declare function subagentReport(transcriptPath: string): SubagentReport | null;
export interface SubagentRenderOptions {
    /** Hide each subagent's brief: it quotes the conversation, as previews do. */
    redact?: boolean;
}
/**
 * @param parentInputUsd what the PARENT session's input actually cost across
 *   all its calls (from the cache analysis), so the comparison is total against
 *   total. Comparing against a per-call figure produced nonsense like "159x".
 */
export declare function renderSubagents(report: SubagentReport | null, parentInputUsd?: number, top?: number, options?: SubagentRenderOptions): string | null;
