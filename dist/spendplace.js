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
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
/**
 * What `spend --by` takes from a Claude Code transcript: each change of
 * folder or branch, with the time of the row that made it. No text.
 */
export const CLAUDE_PLACE_ROWS = {
    id: "claude-place.1",
    init: () => ({}),
    line(line, row, out, st) {
        if (!line.includes('"cwd"') && !line.includes('"gitBranch"'))
            return;
        let e;
        try {
            e = row();
        }
        catch {
            return;
        }
        const c = typeof e?.cwd === "string" && e.cwd ? e.cwd : undefined;
        const b = typeof e?.gitBranch === "string" && e.gitBranch ? e.gitBranch : undefined;
        if ((c === undefined || c === st.c) && (b === undefined || b === st.b))
            return;
        if (c !== undefined)
            st.c = c;
        if (b !== undefined)
            st.b = b;
        out.push({ ts: typeof e.timestamp === "string" ? e.timestamp : "", ...(st.c ? { c: st.c } : {}), ...(st.b ? { b: st.b } : {}) });
    },
};
/** The place in effect at `ts` among a transcript's changes (oldest first): the last made at or before it, else the first. */
export function placeAt(changes, ts) {
    let at = changes[0];
    for (const p of changes) {
        const t = Date.parse(p.ts);
        if (Number.isFinite(t) && t > ts)
            break;
        at = p;
    }
    return at ? { ...(at.c ? { cwd: at.c } : {}), ...(at.b ? { branch: at.b } : {}) } : {};
}
const memo = new Map();
/** A folder's repository name (see above); the folder's own name when it is in none. "(home)" for the home folder itself. */
export function repoName(folder, home = homedir()) {
    const hit = memo.get(folder);
    if (hit !== undefined)
        return hit;
    const top = resolve(home);
    let name;
    for (let d = resolve(folder); d !== top && dirname(d) !== d; d = dirname(d)) {
        const git = join(d, ".git");
        if (!existsSync(git))
            continue;
        name = basename(d);
        try {
            if (statSync(git).isFile()) {
                // A worktree: "gitdir: <repo>/.git/worktrees/<name>".
                const m = /^gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/][^\\/]+\s*$/m.exec(readFileSync(git, "utf8"));
                if (m)
                    name = basename(m[1]);
            }
        }
        catch { /* unreadable: the folder's own name */ }
        break;
    }
    if (name === undefined)
        name = resolve(folder) === top ? "(home)" : basename(resolve(folder)) || folder;
    memo.set(folder, name);
    return name;
}
/** Forget what repoName worked out (tests). */
export function clearRepoNames() {
    memo.clear();
}
