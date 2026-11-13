/**
 * A bare `context-doctor` in a terminal with history: fix's plan on one
 * screen, the quality-free fixes under one y/N question applied through
 * applyFix (the same writes and records as `fix --apply <ids>`), the others
 * with their dollars and the command for each. `n`, Ctrl-D and a stdin that
 * is not a terminal change nothing; piped, it is the Start here screen.
 *
 * The terminal is a real pseudo-terminal (Python's pty), where one is
 * available (not on Windows); the plan's grouping is tested everywhere.
 */
export {};
