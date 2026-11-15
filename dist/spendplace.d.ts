/**
 * Where a request ran, for `spend --by repo` and `--by branch`: the folder
 * and the git branch each tool records, and the repository a folder is in.
 *
 *  - Claude Code writes `cwd` and `gitBranch` on every row of a transcript;
 *    CLAUDE_PLACE_ROWS keeps each change, so a request takes the place in
 *    effect when it was made (a session that switched branch is split).
 *  - Codex: `session_meta`'s `cwd` and `git.branch` (CODEX_SPEND_ROWS).
 *  - Copilot CLI: `session.start`'s `context` (`cwd`, `gitRoot`, `branch`).
 *  - OpenCode: a message's `path` (`cwd`, `root`); Cline, Cursor: the folder.
 *
 * A folder's repository is the nearest folder above it holding `.git`, up to
 * (not including) the home folder; a git worktree (`.git` a file naming
 * `<repo>/.git/worktrees/<name>`) is its main repository, so Claude Code's
 * agent worktrees count as the repository they were cut from. A folder gone
 * from disk is walked up the same way (its parents may still be there). Its
 * name is the folder's base name: what `spend --export` carries, never a path.
 */
import type { Extractor } from "./scan.js";
/**
 * What `spend --by` takes from a Claude Code transcript: each change of
 * folder or branch, with the time of the row that made it. No text.
 */
export declare const CLAUDE_PLACE_ROWS: Extractor<{
    c?: string;
    b?: string;
}>;
/** The place in effect at `ts` among a transcript's changes (oldest first): the last made at or before it, else the first. */
export declare function placeAt(changes: Array<{
    ts: string;
    c?: string;
    b?: string;
}>, ts: number): {
    cwd?: string;
    branch?: string;
};
/** A folder's repository name (see above); the folder's own name when it is in none. "(home)" for the home folder itself. */
export declare function repoName(folder: string, home?: string): string;
/** Forget what repoName worked out (tests). */
export declare function clearRepoNames(): void;
