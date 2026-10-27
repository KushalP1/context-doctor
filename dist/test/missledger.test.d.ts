/**
 * N2: Claude Code's own diagnosis of each cache miss, logged by the status
 * line and grouped by `cache-misses`. Each refresh re-sends the same
 * `last_miss_at` and parallel sessions share one file, so a miss must be
 * written once; its tokens are the growth of the session's running total.
 */
export {};
