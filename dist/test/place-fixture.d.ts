/** Claude Code sessions with folders and branches, and the repositories they ran in: for `spend --by` and `--export`. */
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
}, now: number): string[];
