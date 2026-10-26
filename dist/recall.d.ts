/**
 * Recall: search this session's own transcript on disk.
 *
 * What leaves the context does not leave the disk. Claude Code writes every
 * turn to its transcript, the ones a compaction summarised away and the
 * tool output autopilot cleared in flight included (the transcript keeps the
 * original), and Codex writes its rollout the same way. So when the model
 * needs a detail from before a compaction (an error message, a path, a
 * decision), it can get the few lines that matter back instead of asking the
 * user or re-running a command.
 *
 * Ranking is pack's (BM25 over structural chunks); each excerpt comes back
 * with its time, its position in the session and whether it is still in the
 * context or was compacted away. Secret-looking strings are masked with the
 * handoff masker before anything is ranked or returned. Only the session
 * itself is read: by default the one named by CLAUDE_CODE_SESSION_ID, else the
 * newest transcript of the current folder's project (or Codex rollout started
 * in this folder), never another project's; any other session only when it
 * is named.
 */
/** One transcript entry, flattened to text: what a chunk points back to. */
interface Entry {
    /** 1-based position among the session's entries. */
    n: number;
    at?: string;
    kind: string;
    text: string;
    /** Compactions after this entry: 0 means it is in the current context. */
    compactedBy: number;
}
export interface RecallHit {
    id: string;
    /** Position in the session: entry n of total. */
    n: number;
    at?: string;
    kind: string;
    /** "in context" or "before compaction k of m". */
    where: string;
    tokens: number;
    score: number;
    text: string;
}
export interface RecallResult {
    path: string;
    /** How the session was chosen, in words. */
    how: string;
    query: string;
    entries: number;
    compactions: number;
    totalTokens: number;
    hits: RecallHit[];
    /** Secret-looking strings masked across the hits. */
    masked: number;
    /** Matching excerpts that did not fit the budget. */
    more: number;
}
/** Claude Code transcript rows, or Codex rollout lines, as entries in order. */
export declare function transcriptEntries(path: string): Entry[];
/**
 * This session's transcript, never another project's: CLAUDE_CODE_SESSION_ID,
 * then the newest transcript in this folder's Claude Code project, then the
 * newest Codex rollout of the last week started in this folder.
 */
export declare function currentTranscript(env?: NodeJS.ProcessEnv, cwd?: string, home?: string): {
    path: string;
    how: string;
} | undefined;
/** A session named by id (Claude Code `<id>.jsonl` in any project, or a Codex rollout whose name holds it) or by path. */
export declare function findSession(idOrPath: string, home?: string): string | undefined;
/**
 * The excerpts of a transcript that best answer `query`, within `budget`
 * tokens, best first. Masked before ranking, so a secret is never returned.
 */
export declare function recall(path: string, query: string, opts?: {
    budget?: number;
    how?: string;
}): RecallResult;
export declare function renderRecall(r: RecallResult, home?: string): string;
export {};
