/**
 * `spend --by repo` and `--by branch`: each request goes to the folder and
 * branch in effect when it was made (Claude Code's `cwd` and `gitBranch`,
 * a change mid-session splitting it; Copilot CLI's start context), a folder
 * to its git repository (a worktree to the repository it was cut from, a
 * folder in none to its own name), across tools.
 */
/** A repository, a worktree of it, and a folder in no repository, under `home`. */
export declare function writeRepos(home: string): {
    shop: string;
    worktree: string;
    loose: string;
};
/** Two Claude Code sessions: one that switches branch and then folder (into the worktree), one in a folder in no repository. Prompts carry a secret. */
export declare function writeClaudePlaces(home: string, dirs: {
    shop: string;
    worktree: string;
    loose: string;
}): string[];
export declare function sandbox<R>(fn: (home: string) => R): Promise<R>;
