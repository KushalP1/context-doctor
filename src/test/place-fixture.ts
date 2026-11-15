/** Claude Code sessions with folders and branches, and the repositories they ran in: for `spend --by` and `--export`. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();

/** A repository, a worktree of it, and a folder in no repository, under `home`. */
export function writeRepos(home: string): { shop: string; worktree: string; loose: string } {
  const shop = join(home, "tech", "shop"), worktree = join(home, "tech", "shop-wt"), loose = join(home, "scratch", "sub");
  mkdirSync(join(shop, ".git", "worktrees", "wt1"), { recursive: true });
  mkdirSync(join(shop, "web"), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(shop, ".git", "worktrees", "wt1")}\n`);
  mkdirSync(loose, { recursive: true });
  return { shop, worktree, loose };
}

/** Two Claude Code sessions: one that switches branch and then folder (into the worktree), one in a folder in no repository. Prompts carry a secret. */
export function writeClaudePlaces(home: string, dirs: { shop: string; worktree: string; loose: string }, now: number): string[] {
  const T = now - 3 * DAY;
  const reply = (id: string, t: number, cwd: string, branch: string | undefined, input: number, output: number) => ({
    type: "assistant", uuid: `u-${id}`, timestamp: iso(t), sessionId: "s", cwd, ...(branch ? { gitBranch: branch } : {}),
    message: { id, role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: output } },
  });
  const ask = (id: string, t: number, cwd: string, branch?: string) => ({ type: "user", uuid: `q-${id}`, timestamp: iso(t), sessionId: "s", cwd, ...(branch ? { gitBranch: branch } : {}), message: { role: "user", content: `SECRET PROMPT in ${cwd}` } });
  const a = [
    ask("1", T, join(dirs.shop, "web"), "main"),
    reply("m1", T + 1_000, join(dirs.shop, "web"), "main", 1_000, 100),
    ask("2", T + 2_000, join(dirs.shop, "web"), "feat/x"),
    reply("m2", T + 3_000, join(dirs.shop, "web"), "feat/x", 2_000, 200),
    ask("3", T + 4_000, dirs.worktree, "wt-branch"),
    reply("m3", T + 5_000, dirs.worktree, "wt-branch", 3_000, 300),
  ];
  const b = [ask("4", T + 6_000, dirs.loose), reply("m4", T + 7_000, dirs.loose, undefined, 500, 50)];
  const files = [join(home, ".claude", "projects", "-Users-dev-tech-shop", "a.jsonl"), join(home, ".claude", "projects", "-Users-dev-scratch-sub", "b.jsonl")];
  [a, b].forEach((rows, i) => {
    mkdirSync(dirname(files[i]), { recursive: true });
    writeFileSync(files[i], rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  });
  return files;
}
