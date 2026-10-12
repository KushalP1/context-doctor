/**
 * `context-doctor tasks`: what a unit of finished work costs, per project.
 *
 * Tokens and dollars per session say little on their own; a session that
 * shipped five commits and one that shipped none can cost the same. This
 * prices each recent Claude Code session from the usage its transcript
 * records (input, cache writes by TTL, cache reads, output; each request at
 * its own model's price), counts the commits the session itself made
 * (successful `git commit` calls in its shell tool, in whichever
 * repository), and reports per project: sessions, cost, commits, cost per
 * commit, and how much went to sessions that committed nothing. Only
 * requests and commits inside the period count, and a forked session's
 * copy of its parent's history counts once.
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
/** What one report has already counted, shared by every transcript it reads. */
export interface Counted {
    /** Row uuids of replies counted (see replyCounter). */
    rows: Set<string>;
    /** tool_use ids of commits counted. */
    commits: Set<string>;
}
/**
 * One session's bill, priced as the prompt cache bills it, from the usage the
 * transcript records. `since` counts only requests and commits from then on,
 * each by its own timestamp: a month-old session touched today is not a
 * month of today's spend (`tasks --days 1` reported $760 where $244 fell in
 * the day). Rows without a timestamp count with their file.
 */
export declare function sessionCost(path: string, since?: number, counted?: Counted): SessionCost | undefined;
/** `git commit` invocations in a shell command (not --amend, --dry-run or commit-tree). */
export declare function commitCount(cmd: string): number;
export declare function costPerTask(days?: number, paths?: string[]): TasksReport;
export declare function renderTasks(r: TasksReport, limit?: number): string;
