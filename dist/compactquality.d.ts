/**
 * `context-doctor compactions`: does a session work worse right after it
 * compacts? Measured on the user's own history, so the decision to compact
 * earlier (compact-window) rests on evidence about quality, not only cost.
 *
 * For every compaction in recent Claude Code transcripts, the requests just
 * before it are compared with the same number just after, on three signals a
 * transcript records:
 *  - re-reads: Read of a file the session had already read before the
 *    compaction (the summary lost it, so the model goes back for it);
 *  - tool errors: tool results marked as errors, per tool call;
 *  - corrections: user messages that push back ("no", "wrong", "revert",
 *    "you forgot", "I said"), per user message.
 * A compaction that costs quality shows up as all three rising after it.
 * Compactions shaped by context-doctor's PreCompact hook are reported apart,
 * so its effect can be seen as it accumulates.
 */
interface Signals {
    requests: number;
    rereads: number;
    /** Tokens of the re-reads: what forgetting a file costs to fetch again. */
    rereadTokens: number;
    reads: number;
    calls: number;
    errors: number;
    userMsgs: number;
    corrections: number;
}
export interface CompactionQuality {
    compactions: number;
    /** Tokens re-read after a compaction beyond the before-window rate, per compaction. */
    extraRereadTokensPerCompaction: number;
    sessions: number;
    before: Signals;
    after: Signals;
    /** The same, for compactions context-doctor's PreCompact hook shaped. */
    shaped?: {
        compactions: number;
        before: Signals;
        after: Signals;
    };
}
export declare function compactionQuality(days?: number, paths?: string[]): CompactionQuality;
export declare function renderCompactionQuality(q: CompactionQuality, days?: number): string;
export {};
