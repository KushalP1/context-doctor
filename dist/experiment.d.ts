/**
 * `context-doctor experiment` — the fresh-vs-existing session harness.
 *
 * Everything else in this tool measures what is IN the context. None of it can
 * say whether the task succeeded, so a smaller transcript can be a cheaper
 * failure. This runs the same task twice against the same starting commit —
 * once in a fresh session, once forked from an existing one — with the same
 * model and tools, records what each was billed and how long it took, runs the
 * same check command against each result, and puts the two side by side.
 *
 * It spends the user's Claude budget, so it refuses to start on a dirty tree,
 * caps spend per arm, forks the existing session rather than mutating it, and
 * resets the tree between arms only because it verified the tree was clean.
 */
export interface ExperimentOptions {
    task: string;
    /** Shell command whose exit code decides pass/fail, e.g. "npm test". */
    check?: string;
    /** Session id to fork the "existing" arm from. Omit to run the fresh arm only. */
    existing?: string;
    model?: string;
    /** Spend cap per arm, USD. */
    budgetUsd?: number;
    cwd?: string;
    /** Print the commands and stop. */
    dryRun?: boolean;
    /** Skip the clean-tree requirement (you accept the reset that follows). */
    allowDirty?: boolean;
}
export interface ArmResult {
    arm: "fresh" | "existing";
    sessionId?: string;
    costUsd: number;
    durationMs: number;
    turns: number;
    inputTokens: number;
    cacheRead: number;
    cacheWrite: number;
    outputTokens: number;
    /** Billed input the transcript reports on the last request, when found. */
    liveContextTokens?: number;
    check?: {
        command: string;
        passed: boolean;
        exitCode: number;
    };
    diffStat?: string;
    error?: string;
}
/** Build the argv for one arm — exported so the dry run and the tests see exactly what runs. */
export declare function claudeArgs(opts: ExperimentOptions, arm: "fresh" | "existing"): string[];
export declare function runExperiment(opts: ExperimentOptions): {
    arms: ArmResult[];
    startCommit?: string;
    refused?: string;
    treeClean?: boolean;
};
export declare function renderExperiment(result: ReturnType<typeof runExperiment>, opts: ExperimentOptions): string;
