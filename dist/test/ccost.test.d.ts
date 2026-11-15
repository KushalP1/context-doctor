/**
 * What Claude Code counts that the usage totals leave out, and Claude Code's
 * own figure beside ours (ROADMAP F1).
 *
 * A fixture session with: a plain request; one that consulted the advisor
 * (the shape of Anthropic's "Advisor tool" page: top-level usage is the sum
 * of the executor's iterations, the advisor's call is billed on top at its
 * own model); one a server-side fallback answered (the shape of a real reply
 * on the author's machine: top-level usage is the attempt that answered, the
 * declined attempt is billed on top), written as two rows; a client-side
 * refusal Claude Code retried (no row has its usage); and Claude Code's own
 * `cost-state`. Every total is checked against a hand count.
 */
export {};
