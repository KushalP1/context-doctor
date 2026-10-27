/**
 * `context-doctor statusline` — live context health in Claude Code's status bar.
 *
 * Claude Code's `statusLine` setting runs a command on every refresh and shows
 * its first line of stdout. That is "context health where the work happens"
 * without an editor extension: the number that matters, visible while typing.
 *
 * When Claude Code passes `prompt_cache` (2.1.251+), it also says until when
 * the cache is warm and what letting it go cold costs: the re-write of the
 * whole context at the TTL's write rate, instead of a read. The time is a
 * clock time, not a countdown, because the line is only re-run on events and
 * at `expires_at` (Claude Code does that itself), so a countdown would freeze.
 *
 * It also keeps the limit ledger: when Claude Code passes `rate_limits`
 * (Pro and Max), each new 5-hour and weekly reading is appended to
 * ~/.claude/.context-doctor-limits.jsonl for `context-doctor limits`.
 *
 * It has to be fast and silent. Fast: the status payload on stdin carries the
 * live context size in recent versions; when it does not, only the tail of the
 * transcript is read (last 256KB, ~1ms on a 20MB file). Silent: any failure
 * prints nothing at all, because a status line that shows an error is worse
 * than one that shows nothing.
 */
/** The parts of Claude Code's status payload this reads. All optional. */
interface StatusInput {
    transcript_path?: string;
    /** Pro/Max (or a gateway's spend limit), after the first reply: each window's used_percentage and resets_at. */
    rate_limits?: unknown;
    model?: {
        id?: string;
        display_name?: string;
    };
    cost?: {
        total_cost_usd?: number;
    };
    /** The main conversation's cache (2.1.251+), after its first reply. */
    prompt_cache?: PromptCache | null;
    context_window?: {
        /** Not read: stale after /compact (and a running total in some versions). */
        total_input_tokens?: number;
        context_window_size?: number;
        /** The last request's usage; null right after /compact, /clear and in a new session. */
        current_usage?: {
            input_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
        } | null;
    };
}
/** The fields of Claude Code's `prompt_cache` this reads. Timestamps are epoch seconds. */
export interface PromptCache {
    warm?: boolean;
    caching_observed?: boolean;
    ttl?: string;
    expires_at?: number | null;
    /** What the next request re-caches if the cache is cold by then; null right after a compaction. */
    recache_tokens_if_cold?: number | null;
    misses?: number;
    miss_recache_tokens?: number;
    last_miss_at?: number | null;
    last_miss_cause?: {
        causes?: unknown;
    } | null;
}
interface LiveUsage {
    tokens: number;
    cacheShare?: number;
    model?: string;
}
/** Newest assistant usage from the END of a transcript, without reading the file. */
export declare function tailUsage(path: string, tailBytes?: number): LiveUsage | undefined;
/**
 * Until when the cache is warm, and what going cold costs: the next request
 * writes `recache_tokens_if_cold` at the TTL's rate (1.25x input at 5 minutes,
 * 2x at an hour) where a warm one would read them (0.1x). The extra is the
 * price; tokens alone when the model has no price. Undefined when Claude Code
 * does not say (no `prompt_cache`, caching off, or right after a compaction
 * while the cache is cold).
 */
export declare function cacheClock(pc: PromptCache | null | undefined, model: string | undefined, nowMs?: number): string | undefined;
/** Build the status line, or null when there is nothing trustworthy to show. */
export declare function renderStatusLine(input: StatusInput, nowMs?: number): string | null;
export declare function runStatusLine(): Promise<void>;
export {};
