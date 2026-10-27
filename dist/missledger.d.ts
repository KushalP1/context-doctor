/**
 * Claude Code's own diagnosis of each prompt-cache miss, kept by the status line.
 *
 * Since 2.1.251 Claude Code passes the status line a `prompt_cache` object,
 * and since 2.1.260 it says why the last miss happened (`last_miss_cause`):
 * it compares the request with the one before, on the client, where it can see
 * the system prompt, the tool definitions, the betas and the TTL, none of
 * which reach the transcript. `cache-misses` reads transcripts, so most of its
 * misses are "nothing visible"; this log is what explains them.
 *
 * The status line appends one line per new miss (a `last_miss_at` this
 * session has not logged yet) to ~/.claude/.context-doctor-misses.jsonl:
 * when, the session, the causes, and the session's running miss count and
 * re-cached tokens, from which a report takes each miss's share. Misses are
 * rare (a few a day), so the file stays small; it is byte-capped anyway.
 * Never throws: the status line must stay silent.
 */
/** Beside the limits log: ~/.claude/.context-doctor-misses.jsonl. */
export declare function missLogPath(): string;
/**
 * Claude Code's cause names (2.1.308's closed set, `PROMPT_CACHE_MISS_CAUSES`)
 * with what each means and what to do about it. A name not here is shown as it
 * is, with no advice: Claude Code may add causes.
 */
export declare const MISS_CAUSES: Record<string, {
    label: string;
    fix?: string;
}>;
/**
 * Append the session's newest miss when it is not in the log yet. `pc` is
 * Claude Code's `prompt_cache`. Each status line refresh re-sends the same
 * `last_miss_at` until the next miss, and parallel sessions write the same
 * file, so the identity is (session, last_miss_at), checked against the
 * log's tail. Returns 1 when a line was written.
 */
export declare function recordMiss(pc: unknown, sessionId: unknown, model: unknown, now?: number, path?: string): number;
export interface DiagnosedCause {
    cause: string;
    label: string;
    fix?: string;
    misses: number;
    /** Tokens these misses re-wrote (a miss with two causes counts for both). */
    tokens: number;
    /** Above cache-read price, on the models with a known price. */
    extraUsd: number;
}
export interface DiagnosedMisses {
    misses: number;
    sessions: number;
    tokens: number;
    extraUsd: number;
    /** The oldest line read, ms. */
    from?: number;
    byCause: DiagnosedCause[];
}
/**
 * The log since `since`, grouped by cause. A miss's tokens are the growth of
 * its session's running total since the session's previous line (the first
 * line of a session counts its whole total: the log may start mid-session).
 */
export declare function diagnosedMisses(since?: number, path?: string): DiagnosedMisses;
