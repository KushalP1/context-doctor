/**
 * `context-doctor ci`: the memory-file check for pull requests.
 *
 * CLAUDE.md, AGENTS.md, GEMINI.md and always-applied rules are re-read on
 * every request of every session by everyone who works in the repository, so
 * a PR that grows them by 2k tokens is a standing cost nobody reviews. This
 * compares those files (and what they @import) at HEAD against a base commit,
 * prints a table, and exits 1 over a budget, so CI can comment and gate.
 *
 * Base contents come from `git show <base>:<path>`; nothing is checked out.
 */
export interface CiFile {
    path: string;
    agent: string;
    base: number;
    head: number;
    /** Loaded through an @import rather than directly. */
    imported?: boolean;
}
export interface CiReport {
    base?: string;
    files: CiFile[];
    baseTotal: number;
    headTotal: number;
    breaches: string[];
}
export declare function ciReport(opts?: {
    cwd?: string;
    base?: string;
    maxTokens?: number;
    maxIncrease?: number;
}): CiReport;
/** Markdown for a PR comment or a job summary. */
export declare function renderCiMarkdown(r: CiReport, opts?: {
    model?: string;
    requestsPerDay?: number;
}): string;
/** Plain-text rendering for a terminal. */
export declare function renderCiText(r: CiReport): string;
