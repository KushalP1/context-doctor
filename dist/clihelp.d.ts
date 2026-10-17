/**
 * Helpers for the CLI's argument errors and per-command help: a "did you
 * mean" suggestion for a mistyped flag or command, and one command's lines
 * cut out of the full help text. Kept apart from cli.ts, which runs on
 * import, so they can be tested directly.
 */
/** Edit distance (insert, delete, substitute; each 1). */
export declare function levenshtein(a: string, b: string): number;
/**
 * The closest candidate, when it is close enough to be a typo: within a
 * third of the word's length (at least 2 edits), or one the word is a
 * prefix of (`--strat` for `--strategy`).
 */
export declare function suggest(word: string, candidates: readonly string[]): string | undefined;
/** "Did you mean …?" or nothing. */
export declare function didYouMean(word: string, candidates: readonly string[]): string;
/** Every command the help text documents, in order. */
export declare function documentedCommands(help: string): string[];
/**
 * One command's help, cut from the full text: its usage line(s), the options
 * scoped to it, and its examples. Undefined when the help has no usage line
 * for it.
 */
export declare function commandHelp(help: string, cmd: string): string | undefined;
