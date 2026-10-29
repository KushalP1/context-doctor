/**
 * A synthetic Claude Code history with every shape the history reports read,
 * for the golden tests of the shared scan (scan.ts): long sessions with
 * compactions (automatic and idle), cold returns, cache misses and
 * just-too-late re-writes, a model switch, edited contexts, API errors,
 * Read results (some failing), repeated identical calls, MCP tools, a
 * skill, slash commands, typed-while-working prompts, corrections, thinking
 * blocks, a reply written as several rows, a fork that copies its parent,
 * subagents, an older session only the 60-day check reaches, a desktop-app
 * session, a CRLF file, a malformed row and a last line still being written.
 *
 * Deterministic: a seeded generator, fixed times before FIXTURE_NOW (the
 * reports run with the clock frozen there, see `frozenClock`), and every
 * file's modification time set to its last row, since `listSessions` orders
 * transcripts by it. Only the home folder's path differs between builds,
 * and only in the rows' `cwd` (message content never holds it: its size is
 * what the replays price); `normalizeOutput` takes it out of a report.
 */
export declare const FIXTURE_NOW: number;
/** Node arguments that freeze `Date` at `now` in a child process (as the reports see it). */
export declare function frozenClock(now?: number): string[];
/** A report with the fixture's home folder (as given and as resolved) replaced by "~". */
export declare function normalizeOutput(text: string, home: string): string;
/** Write the history under `home`: ~/.claude/projects, a subagent's transcript, an MCP config, a limits log. */
export declare function buildHistory(home: string, now?: number): void;
/** Claude Code keeps writing: the live session's last line completes and more requests follow; a subagent and s5 grow. */
export declare function growHistory(home: string, now?: number): void;
/** The reports compared byte for byte, text and JSON (each run from the fixture's project folder). */
export declare const GOLDEN_COMMANDS: string[][];
