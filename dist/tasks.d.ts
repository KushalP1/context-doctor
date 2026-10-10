/**
 * `context-doctor tasks`: what a unit of finished work costs, per project.
 *
 * Tokens and dollars per session say little on their own; a session that
 * shipped five commits and one that shipped none can cost the same. This
 * prices each recent Claude Code session from the usage its transcript
 * records (input, cache writes at 1.25x, cache reads at 0.1x, output), counts
 * the commits the session itself made (successful `git commit` calls in its
 * shell tool, in whichever repository), and reports per project: sessions,
 * cost, commits, cost per commit, and how much went to sessions that
 * committed nothing.
 *
 * Counting from the transcript attributes each commit to exactly one session
 * and finds commits in nested repositories; a time window over `git log`
 * did neither (a parent folder's repo showed none, a busy repo's unrelated
 * history showed hundreds). Commits made by hand are not counted, nor is
 * subagent traffic.
 */
export interface SessionCost {
    path: string;
    cwd?: string;
    model?: string;
    start: number;
    end: number;
    usd: number;
    requests: number;
    /** Successful `git commit` calls the session made. */
    commits: number;
}
export interface ProjectTasks {
    project: string;
    sessions: number;
    usd: number;
    commits: number;
    /** Sessions in which the project's repository got no commit, and what they cost. */
    idleSessions: number;
    idleUsd: number;
    usdPerCommit?: number;
}
export interface TasksReport {
    days: number;
    projects: ProjectTasks[];
    usd: number;
    commits: number;
}
/** One session's bill, priced as the prompt cache bills it, from the usage the transcript records. */
export declare function sessionCost(path: string): SessionCost | undefined;
/** `git commit` invocations in a shell command (not --amend, --dry-run or commit-tree). */
export declare function commitCount(cmd: string): number;
export declare function costPerTask(days?: number, paths?: string[]): TasksReport;
export declare function renderTasks(r: TasksReport, limit?: number): string;
