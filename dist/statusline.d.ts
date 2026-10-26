/**
 * `context-doctor statusline` — live context health in Claude Code's status bar.
 *
 * Claude Code's `statusLine` setting runs a command on every refresh and shows
 * its first line of stdout. That is "context health where the work happens"
 * without an editor extension: the number that matters, visible while typing.
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
interface LiveUsage {
    tokens: number;
    cacheShare?: number;
    model?: string;
}
/** Newest assistant usage from the END of a transcript, without reading the file. */
export declare function tailUsage(path: string, tailBytes?: number): LiveUsage | undefined;
/** Build the status line, or null when there is nothing trustworthy to show. */
export declare function renderStatusLine(input: StatusInput): string | null;
export declare function runStatusLine(): Promise<void>;
export {};
