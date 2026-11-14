/**
 * The model comparisons `ab --via claude-code` finished, kept beside the
 * other state files (~/.claude/.context-doctor-ab.json, or the fallback
 * state folder), the newest 20. `fix` quotes the newest one that compared
 * the subagent lever's model with another on its subagent-model line. Kept
 * apart from abclaude.ts so `fix` reads it without loading the harness.
 */
/** What is kept of a finished comparison: enough for `fix` to quote. */
export interface AbStoredResult {
    at: string;
    via: "claude-code";
    claudeCodeVersion?: string;
    authMethod?: string;
    subscriptionType?: string;
    repeat: number;
    tasks: number;
    models: Array<{
        model: string;
        passed: number;
        completed: number;
        runs: number;
        costUsd: number;
    }>;
}
export declare function abResultsPath(): string;
/** Whether Claude Code drew on a claude.ai plan's limits (true) or billed money (an API key, a console sign-in). */
export declare function onPlan(info: {
    authMethod?: string;
}): boolean;
/** "Sonnet 5.5 passed 7/8, Opus 5.5 8/8": in the order given, over the completed runs. */
export declare function passLine(totals: Array<{
    model: string;
    passed: number;
    completed: number;
}>): string;
/** The kept comparisons; an unreadable file reads as none. */
export declare function readAbResults(path?: string): AbStoredResult[];
/** Add one (the newest 20 are kept), written atomically. */
export declare function appendAbResult(entry: AbStoredResult, path?: string): void;
/**
 * The newest kept comparison of `candidate` (the subagent lever's model)
 * with another model, both with completed runs: what `fix` quotes.
 */
export declare function latestModelComparison(candidate?: string, path?: string): AbStoredResult | undefined;
/** fix's words for a kept comparison: "on your plan: Sonnet 5.5 passed 7/8, Opus 5.5 8/8, 2026-11-14". */
export declare function comparisonLine(r: AbStoredResult, candidate?: string): string;
