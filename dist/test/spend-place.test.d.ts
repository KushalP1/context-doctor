/**
 * `spend --by repo` and `--by branch`: each request goes to the folder and
 * branch in effect when it was made (Claude Code's `cwd` and `gitBranch`,
 * a change mid-session splitting it; Copilot CLI's start context), a folder
 * to its git repository (a worktree to the repository it was cut from, a
 * folder in none to its own name), across tools.
 */
export {};
