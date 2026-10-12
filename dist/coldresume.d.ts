/**
 * Cold resume: coming back to a large session after the prompt cache expired.
 *
 * Claude Code caches the conversation for an hour on a subscription (five
 * minutes on the API). Come back later and the next message re-sends the
 * whole context at the cache-WRITE rate (2x input for the 1-hour cache,
 * 1.25x for 5 minutes), and every message after it re-reads it (the model's
 * cache-read rate, 2.5-10% of input). On a 500k-token session that is the
 * most expensive moment of the day, and the one moment `/compact` is
 * cheapest to accept: the cache is being rebuilt anyway.
 *
 * Measured on the author's 133 days of Claude Code history: 401 returns to a
 * session over 150k tokens after more than 65 idle minutes (median context
 * 517k). Compacting right after the first reply, counting the compaction
 * request itself and only the messages up to the next such return, would have
 * saved $4,053 at list price, about $914 a month; it paid off in 296 of 401
 * cases, and the worst single loss was $2.30 (sessions left after a few more
 * messages). So this advises, with the numbers, and the user decides. (That
 * replay priced reads at 0.1x and writes at 1.25x of the session's first
 * model. At each model's own read rate, Opus 5.5 at 5% and Fable 5.1 at
 * 2.5%, the re-reads compaction avoids cost far less: the author's last 7
 * days went from $332 to $139.)
 *
 * It works where the proxy cannot: the desktop app's Code tab runs Claude Code
 * host-orchestrated and drops a settings-file ANTHROPIC_BASE_URL, but it runs
 * the every-prompt hook, which is where this is called from.
 */
/** Just past Claude Code's one-hour cache, as Claude Code's own idle clearing uses. */
export declare const COLD_IDLE_MS: number;
/** Below this, a rebuilt cache is cheap and compaction is not worth the interruption. */
export declare const COLD_MIN_TOKENS = 150000;
export interface ColdResume {
    idleMs: number;
    /** Context size at the last request, from the API's own usage. */
    tokens: number;
    model?: string;
    /** Timestamp of the last assistant reply: identifies this idle period. */
    lastReplyAt: number;
    /** This message's cost to rebuild the cache, at list price and the session's write TTL mix. */
    resumeUsd?: number;
    /** Each later message's cost to re-read the context, at list price. */
    perMessageUsd?: number;
}
/**
 * Is the prompt being submitted now a return to a large, cache-cold session?
 * Reads only the transcript's tail. Undefined when not (or when unreadable).
 */
export declare function detectColdResume(path: string, now?: number, idleMs?: number, minTokens?: number): ColdResume | undefined;
/**
 * What this session pays to write a token to the cache, relative to input:
 * the 5-minute/1-hour mix of the main-thread writes in the transcript's
 * tail (subagents write 5 minutes and are not this context). The tail, not
 * the whole file, because it is the TTL the harness writes at now: on the
 * author's machine Claude Code 2.1.295 (desktop app) moved main-thread
 * writes from 1 hour to 5 minutes, and 7 of the 12 largest recent sessions
 * switched mid-file. 1.25x when the tail records no split or no writes.
 * Reads only the tail, so the every-prompt hook can afford it.
 */
export declare function sessionWriteMultiplier(path: string): number;
/**
 * The one line shown to the USER in the app (hook `systemMessage`). In the
 * first week the offer lived only inside the model's reply and was acted on
 * 1 time in 33; a notice of its own is harder to miss.
 */
export declare function renderColdResumeNotice(c: ColdResume): string;
/** The note the hook hands the model: the numbers, and one sentence to say. */
export declare function renderColdResume(c: ColdResume): string;
export interface ColdResumeEvent {
    at: number;
    tokens: number;
    /** Messages until the session ended, was compacted, or went cold again. */
    messagesAfter: number;
    /** Net USD compaction after the first reply would have saved (negative: cost). */
    netUsd: number;
}
/**
 * Replay a transcript's billed usage and price what compacting at each cold
 * resume would have saved. Each resume only counts the messages up to the
 * next one (no double counting), and the compaction request is a cost.
 *
 * Each request at its own model's prices: a session that moved from a $4 to
 * a $10 model was priced at the first throughout, and one that opened with
 * a "<synthetic>" row not at all. A re-write that never happened (a cold
 * read of what compaction would have removed, the fresh context after it)
 * at the session's own 5-minute/1-hour write mix, not 1.25x. `runRows` is
 * shared by every transcript of one report (see replyCounter): a forked
 * session's copy of its parent's history shapes the timeline, but a resume
 * in it was counted under the transcript that met it first.
 */
export declare function coldResumeEvents(path: string, idleMs?: number, minTokens?: number, runRows?: Set<string>): ColdResumeEvent[];
/**
 * How often the cold-resume offer was acted on: offers (ledger events) whose
 * session has a compaction within an hour after. `sessionPaths` maps the
 * ledger's 12-char session id to its transcript. Only lines that mention a
 * compact boundary are parsed, so even very large transcripts scan quickly.
 */
export declare function coldResumeFollowThrough(offers: {
    ts: number;
    sid?: string;
}[], sessionPaths: Map<string, string>): {
    offers: number;
    compacted: number;
};
