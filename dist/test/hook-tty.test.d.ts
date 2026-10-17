/**
 * `hook` and `statusline` read JSON that Claude Code pipes in. Typed in a
 * terminal they waited for stdin forever; they now say what they are for
 * and exit 0. The terminal is a real pseudo-terminal (Python's pty), where
 * one is available.
 */
export {};
