/**
 * The status line's number must be the CURRENT context. Claude Code's
 * context_window.current_usage is null right after /compact and in a new
 * session, while total_input_tokens still holds an older figure (a running
 * total in some versions), which is exactly when a stale large number
 * misleads the most.
 */
export {};
