/**
 * `spend --by repo` and `--by branch`: each request goes to the folder and
 * branch in effect when it was made (Claude Code's `cwd` and `gitBranch`,
 * a change mid-session splitting it; Copilot CLI's start context), a folder
 * to its git repository (a worktree to the repository it was cut from, a
 * folder in none to its own name), across tools.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderSpend, spendReport } from "../spend.js";
import { clearRepoNames, placeAt, repoName } from "../spendplace.js";
import { clearScanMemo } from "../scan.js";
import { withSandboxHome } from "./sandbox.js";
import { writeCopilot } from "./copilot-fixture.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-14T12:00:00Z");
const T = NOW - 3 * DAY;
const iso = (t: number) => new Date(t).toISOString();
const close = (a: number, b: number, msg: string) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

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
export function writeClaudePlaces(home: string, dirs: { shop: string; worktree: string; loose: string }): string[] {
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
/** By hand at Sonnet 4.5's $3 / $15. */
const M1 = (1_000 * 3 + 100 * 15) / 1e6, M2 = (2_000 * 3 + 200 * 15) / 1e6, M3 = (3_000 * 3 + 300 * 15) / 1e6, M4 = (500 * 3 + 50 * 15) / 1e6;
/** Copilot CLI's fixture: session a in /Users/dev/tech/shop on feat/cart, session b with no context. */
const COPILOT_SHOP = (2_000 * 5 + 6_000 * 0.5 + 2_000 * 6.25 + 500 * 25 + 3_000 * 2.5 + 1_000 * 0.25 + 200 * 15 + 3_000 * 3 + 300 * 15) / 1e6;
const COPILOT_B = (1_000 * 3 + 100 * 15) / 1e6;

export function sandbox<R>(fn: (home: string) => R): Promise<R> {
  const home = mkdtempSync(join(tmpdir(), "cd-spend-place-"));
  const saved = process.env.CONTEXT_DOCTOR_CACHE_DIR;
  process.env.CONTEXT_DOCTOR_CACHE_DIR = join(home, "cache");
  clearScanMemo();
  clearRepoNames();
  return withSandboxHome(home, () => fn(home)).finally(() => {
    if (saved === undefined) delete process.env.CONTEXT_DOCTOR_CACHE_DIR;
    else process.env.CONTEXT_DOCTOR_CACHE_DIR = saved;
    clearScanMemo();
    clearRepoNames();
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });
}

test("place: the change in effect at a time, else the first", () => {
  const changes = [{ ts: iso(1_000), c: "/a", b: "main" }, { ts: iso(3_000), c: "/a", b: "dev" }];
  assert.deepEqual(placeAt(changes, 500), { cwd: "/a", branch: "main" });
  assert.deepEqual(placeAt(changes, 2_000), { cwd: "/a", branch: "main" });
  assert.deepEqual(placeAt(changes, 3_000), { cwd: "/a", branch: "dev" });
  assert.deepEqual(placeAt([], 1), {});
});

test("place: a folder's repository, a worktree's main repository, a folder in none its own name, the home folder never a name", async () => {
  await sandbox((home) => {
    const d = writeRepos(home);
    assert.equal(repoName(join(d.shop, "web"), home), "shop");
    assert.equal(repoName(join(d.shop, "web", "gone", "deeper"), home), "shop", "a folder gone from disk: its parents");
    assert.equal(repoName(d.worktree, home), "shop");
    assert.equal(repoName(d.loose, home), "sub");
    assert.equal(repoName(home, home), "(home)");
  });
});

test("spend --by repo and --by branch: a session split where it switched, a worktree in its repository, Copilot's sessions beside Claude Code's", async () => {
  await sandbox((home) => {
    const files = writeClaudePlaces(home, writeRepos(home));
    writeCopilot(home, NOW);
    const opts = { home, now: NOW, claudePaths: files, progress: false } as const;
    const plain = spendReport(30, opts);
    assert.equal(plain.repos, undefined, "only on request");
    assert.equal(plain.branches, undefined);

    const byRepo = spendReport(30, { ...opts, by: "repo" });
    const repos = Object.fromEntries(byRepo.repos!.map((r) => [r.repo, r.usd]));
    assert.deepEqual(Object.keys(repos).sort(), ["copilot", "shop", "sub"]);
    close(repos.shop, M1 + M2 + M3 + COPILOT_SHOP, "shop: both Claude sessions' repo and Copilot's");
    close(repos.sub, M4, "a folder in no repository");
    close(repos.copilot, COPILOT_B, "no context: its project");
    assert.equal(byRepo.branches, undefined, "--by repo carries no branches");
    close(byRepo.usd, plain.usd, "the same total");
    assert.match(renderSpend(byRepo), /By repository\n  shop\s+\$0\.09/);

    const byBranch = spendReport(30, { ...opts, by: "branch" });
    const branches = Object.fromEntries(byBranch.branches!.map((b) => [`${b.repo} ${b.branch ?? "-"}`, b.usd]));
    assert.deepEqual(Object.keys(branches).sort(), ["copilot -", "shop feat/cart", "shop feat/x", "shop main", "shop wt-branch", "sub -"]);
    close(branches["shop main"], M1, "main");
    close(branches["shop feat/x"], M2, "after the switch");
    close(branches["shop wt-branch"], M3, "in the worktree");
    close(branches["shop feat/cart"], COPILOT_SHOP, "Copilot's branch");
    const text = renderSpend(byBranch);
    assert.match(text, /By branch\n  shop feat\/cart\s+\$0\.06\s+\d+%  Copilot CLI\n/);
    assert.match(text, /  sub \(no branch\)/);
    assert.doesNotMatch(text, /SECRET/);
  });
});
