/**
 * Cold resume priced as billed: the rebuild and any re-write at the
 * session's own 5-minute/1-hour write mix (Claude Code's main thread writes
 * the 1-hour cache, at 2x input; 1.25x only when nothing records a split),
 * each request at its own model, and a forked session's copy of a resume
 * counted once in the savings report.
 */
export {};
