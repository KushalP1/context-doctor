/**
 * `context-doctor statusline` — live context health in Claude Code's status bar.
 *
 * Claude Code's `statusLine` setting runs a command on every refresh and shows
 * its first line of stdout. That is "context health where the work happens"
 * without an editor extension: the number that matters, visible while typing.
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
    model?: {
        id?: string;
        display_name?: string;
    };
    cost?: {
        total_cost_usd?: number;
    };
    context_window?: {
        total_input_tokens?: number;
        context_window_size?: number;
        current_usage?: {
            input_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
        };
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
