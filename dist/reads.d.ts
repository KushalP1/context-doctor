/**
 * `context-doctor reads`: the same files, read into session after session.
 *
 * Agents orient themselves by reading the same files at the start of most
 * sessions: the README, the main module, a config. Each read is written into
 * that session's context and re-read on every later request, and the next
 * session pays for it again. This counts Read calls across recent Claude Code
 * transcripts, groups them by file, and says per file whether a short summary
 * in the project's CLAUDE.md would pay (read in most of the project's
 * sessions) or not (CLAUDE.md is paid on every request, so an occasional read
 * is cheaper left as a read; `pack` can cut it to the part a question needs).
 */
export interface RepeatedRead {
    path: string;
    project: string;
    /** Sessions that read it at least once. */
    sessions: number;
    /** Sessions of that project in the period. */
    projectSessions: number;
    reads: number;
    /** Tokens of all its results, summed over every read. */
    tokens: number;
    /** Floor of the cost: each read written to the prompt cache once (1.25x input). */
    usd?: number;
    advice: "summarize" | "pack";
}
export interface ReadsReport {
    days: number;
    sessions: number;
    reads: number;
    readTokens: number;
    files: RepeatedRead[];
}
export declare function repeatedReads(days?: number, paths?: string[], minSessions?: number): ReadsReport;
export declare function renderReads(r: ReadsReport, limit?: number, home?: string): string;
