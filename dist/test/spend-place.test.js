/**
 * `spend --by repo` and `--by branch`: each request goes to the folder and
 * branch in effect when it was made (Claude Code's `cwd` and `gitBranch`,
 * a change mid-session splitting it; Copilot CLI's start context), a folder
 * to its git repository (a worktree to the repository it was cut from, a
 * folder in none to its own name), across tools.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSpend, spendReport } from "../spend.js";
import { clearRepoNames, placeAt, repoName } from "../spendplace.js";
import { clearScanMemo } from "../scan.js";
import { withSandboxHome } from "./sandbox.js";
import { writeCopilot } from "./copilot-fixture.js";
import { writeClaudePlaces, writeRepos } from "./place-fixture.js";
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-14T12:00:00Z");
const T = NOW - 3 * DAY;
const iso = (t) => new Date(t).toISOString();
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
/** By hand at Sonnet 4.5's $3 / $15. */
const M1 = (1_000 * 3 + 100 * 15) / 1e6, M2 = (2_000 * 3 + 200 * 15) / 1e6, M3 = (3_000 * 3 + 300 * 15) / 1e6, M4 = (500 * 3 + 50 * 15) / 1e6;
/** Copilot CLI's fixture: session a in /Users/dev/tech/shop on feat/cart, session b with no context. */
const COPILOT_SHOP = (2_000 * 5 + 6_000 * 0.5 + 2_000 * 6.25 + 500 * 25 + 3_000 * 2.5 + 1_000 * 0.25 + 200 * 15 + 3_000 * 3 + 300 * 15) / 1e6;
const COPILOT_B = (1_000 * 3 + 100 * 15) / 1e6;
function sandbox(fn) {
    const home = mkdtempSync(join(tmpdir(), "cd-spend-place-"));
    const saved = process.env.CONTEXT_DOCTOR_CACHE_DIR;
    process.env.CONTEXT_DOCTOR_CACHE_DIR = join(home, "cache");
    clearScanMemo();
    clearRepoNames();
    return withSandboxHome(home, () => fn(home)).finally(() => {
        if (saved === undefined)
            delete process.env.CONTEXT_DOCTOR_CACHE_DIR;
        else
            process.env.CONTEXT_DOCTOR_CACHE_DIR = saved;
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
        const files = writeClaudePlaces(home, writeRepos(home), NOW);
        writeCopilot(home, NOW);
        const opts = { home, now: NOW, claudePaths: files, progress: false };
        const plain = spendReport(30, opts);
        assert.equal(plain.repos, undefined, "only on request");
        assert.equal(plain.branches, undefined);
        const byRepo = spendReport(30, { ...opts, by: "repo" });
        const repos = Object.fromEntries(byRepo.repos.map((r) => [r.repo, r.usd]));
        assert.deepEqual(Object.keys(repos).sort(), ["copilot", "shop", "sub"]);
        close(repos.shop, M1 + M2 + M3 + COPILOT_SHOP, "shop: both Claude sessions' repo and Copilot's");
        close(repos.sub, M4, "a folder in no repository");
        close(repos.copilot, COPILOT_B, "no context: its project");
        assert.equal(byRepo.branches, undefined, "--by repo carries no branches");
        close(byRepo.usd, plain.usd, "the same total");
        assert.match(renderSpend(byRepo), /By repository\n  shop\s+\$0\.09/);
        const byBranch = spendReport(30, { ...opts, by: "branch" });
        const branches = Object.fromEntries(byBranch.branches.map((b) => [`${b.repo} ${b.branch ?? "-"}`, b.usd]));
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
