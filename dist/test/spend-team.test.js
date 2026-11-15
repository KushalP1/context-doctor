/**
 * `spend --export` and `spend merge`: an export holds totals only (no
 * prompt text, no path, no project or session name; a repository is its
 * base name, or a hash with --anonymize), and merging exports equals their
 * sum, a developer's day counted once when two of their files cover it,
 * with a month-end forecast at the recent pace.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectSpend, TOOLS } from "../spend.js";
import { anonymize, buildExport, EXPORT_KIND, mergeExports, parseExport, readExports, renderMerge } from "../spendteam.js";
import { clearRepoNames } from "../spendplace.js";
import { clearScanMemo } from "../scan.js";
import { sandboxEnv, withSandboxHome } from "./sandbox.js";
import { writeCopilot } from "./copilot-fixture.js";
import { writeClaudePlaces, writeRepos } from "./place-fixture.js";
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "cli.js");
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-14T12:00:00Z");
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
function sandbox(fn) {
    const home = mkdtempSync(join(tmpdir(), "cd-spend-team-"));
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
/** Every string anywhere in a value, keys included. */
function strings(v, out = []) {
    if (typeof v === "string")
        out.push(v);
    else if (Array.isArray(v))
        v.forEach((x) => strings(x, out));
    else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
            out.push(k);
            strings(x, out);
        }
    return out;
}
/** An export of this home's fixture history (two Claude Code sessions, Copilot CLI's), as `developer`. */
function exportOf(home, developer, o = {}) {
    const files = writeClaudePlaces(home, writeRepos(home), NOW);
    writeCopilot(home, NOW);
    const c = collectSpend(30, { home, now: NOW, claudePaths: files, progress: false, by: o.branches ? "branch" : "repo" });
    return buildExport(c.items, { developer, days: c.days, since: c.since, until: c.until, basis: "as billed at list rates", now: NOW, ...o });
}
test("export: totals by day, tool, model and repository; no prompt text, no path, no project or session", async () => {
    await sandbox((home) => {
        const e = exportOf(home, "alice", { branches: true });
        assert.equal(e.kind, EXPORT_KIND);
        assert.equal(e.developer, "alice");
        assert.ok(e.rows.length > 0);
        const text = JSON.stringify(e);
        for (const bad of ["SECRET", home, "/Users/", "\\\\", "tech-shop", "a.jsonl", "sess-a", "u-m1", "msg_", "cwd", "project", "session"])
            assert.ok(!text.includes(bad), `the export holds "${bad}"`);
        for (const r of e.rows) {
            assert.deepEqual(Object.keys(r).filter((k) => !["day", "tool", "model", "repo", "branch", "requests", "usd", "unpriced", "tokens", "credits", "premium"].includes(k)), []);
            assert.ok(!/[\\/]/.test(r.repo), `a repository is a base name: ${r.repo}`);
        }
        assert.deepEqual([...new Set(e.rows.map((r) => r.repo))].sort(), ["(no folder)", "shop", "sub"]);
        assert.ok(e.rows.some((r) => r.branch === "feat/x"), "branches with --by branch");
        // The sum equals spend's own total for the window.
        const c = collectSpend(30, { home, now: NOW, claudePaths: [join(home, ".claude", "projects", "-Users-dev-tech-shop", "a.jsonl"), join(home, ".claude", "projects", "-Users-dev-scratch-sub", "b.jsonl")], progress: false });
        close(e.rows.reduce((n, r) => n + r.usd, 0), c.items.reduce((n, i) => n + i.usd, 0), "export total");
        assert.equal(e.rows.reduce((n, r) => n + r.requests, 0), c.items.length);
        assert.equal(exportOf(home, "alice").rows.some((r) => r.branch), false, "no branch unless asked");
    });
});
test("export --anonymize: repository and branch names hashed, the same name to the same hash", async () => {
    await sandbox((home) => {
        const e = exportOf(home, "alice", { anonymize: true, branches: true });
        const text = JSON.stringify(e);
        for (const bad of ["shop", "sub", "feat/x", "main", "wt-branch"])
            assert.ok(!text.includes(`"${bad}"`) && !text.includes(`"${bad} `), `the export names "${bad}"`);
        for (const r of e.rows) {
            assert.match(r.repo, /^(repo-[0-9a-f]{10}|\(no folder\))$/);
            if (r.branch)
                assert.match(r.branch, /^branch-[0-9a-f]{10}$/);
        }
        assert.ok(e.rows.some((r) => r.repo === anonymize("repo", "shop")));
        assert.equal(anonymize("repo", "shop"), anonymize("repo", "shop"));
        assert.notEqual(anonymize("repo", "shop"), anonymize("branch", "shop"));
        assert.ok(strings(e).every((s) => !s.includes(home)));
    });
});
/** A synthetic export: `perDay` dollars on each day from `from` to `to`, one row a day. */
function synthetic(developer, from, to, perDay, o = {}) {
    const rows = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY)
        rows.push({ day: new Date(t).toISOString().slice(0, 10), tool: o.tool ?? "codex", model: "gpt-5.5", repo: o.repo ?? "api", requests: 2, usd: perDay, unpriced: 0, tokens: { input: 10, read: 20, write: 0, output: 5 } });
    return { kind: EXPORT_KIND, version: 1, developer, exportedAt: o.exportedAt ?? `${to}T20:00:00.000Z`, days: rows.length, from, to, basis: "as billed at list rates", anonymized: false, byBranch: false, rows };
}
test("merge: three exports equal their sum, by developer, repository and tool", async () => {
    await sandbox((home) => {
        const alice = exportOf(home, "alice");
        const bob = synthetic("bob", "2026-10-16", "2026-11-14", 1.5, { tool: "codex", repo: "shop" });
        const carol = synthetic("carol", "2026-10-16", "2026-11-14", 0.25, { tool: "cline", repo: "api" });
        const folder = join(home, "shared");
        mkdirSync(folder);
        for (const e of [alice, bob, carol])
            writeFileSync(join(folder, `${e.developer}.json`), JSON.stringify(e));
        writeFileSync(join(folder, "notes.json"), JSON.stringify({ hello: 1 }));
        writeFileSync(join(folder, "readme.txt"), "not read");
        const { exports, skipped } = readExports(folder);
        assert.equal(exports.length, 3);
        assert.deepEqual(skipped, [{ file: "notes.json", reason: "not a context-doctor spend export" }]);
        const m = mergeExports(exports, skipped);
        const sum = (e, f = () => true) => e.rows.filter(f).reduce((n, r) => n + r.usd, 0);
        close(m.usd, sum(alice) + sum(bob) + sum(carol), "the total is the sum");
        assert.equal(m.requests, [alice, bob, carol].reduce((n, e) => n + e.rows.reduce((k, r) => k + r.requests, 0), 0));
        assert.deepEqual(m.developers.map((d) => d.name), ["alice", "bob", "carol"], "alphabetical, not by spend");
        for (const e of [alice, bob, carol])
            close(m.developers.find((d) => d.name === e.developer).usd, sum(e), e.developer);
        for (const t of TOOLS)
            close(m.tools.find((x) => x.name === t)?.usd ?? 0, [alice, bob, carol].reduce((n, e) => n + sum(e, (r) => r.tool === t), 0), `tool ${t}`);
        for (const repo of ["shop", "api", "sub", "(no folder)"])
            close(m.repos.find((x) => x.name === repo)?.usd ?? 0, [alice, bob, carol].reduce((n, e) => n + sum(e, (r) => r.repo === repo), 0), `repo ${repo}`);
        close(m.daily.reduce((n, d) => n + d.usd, 0), m.usd, "the days add up");
        assert.equal(m.credits, 53, "Copilot CLI's credits carried through");
        const text = renderMerge(m, folder);
        assert.match(text, /^Team spend: 3 exports, 3 developers, 2026-10-1[56] to 2026-11-14/);
        assert.match(text, /By developer \(alphabetical\)\n  alice/);
        assert.match(text, /Skipped notes\.json: not a context-doctor spend export\./);
        assert.doesNotMatch(text, /SECRET/);
    });
});
test("merge: a developer's day in two files counts once, from the newer; a file that ends early is said", () => {
    const older = synthetic("dana", "2026-11-01", "2026-11-10", 2, { exportedAt: "2026-11-10T20:00:00.000Z" });
    const newer = synthetic("dana", "2026-11-05", "2026-11-14", 3, { exportedAt: "2026-11-14T20:00:00.000Z" });
    const early = synthetic("eve", "2026-11-01", "2026-11-09", 1);
    const m = mergeExports([{ file: "a.json", data: older }, { file: "b.json", data: newer }, { file: "c.json", data: early }]);
    // Nov 1-4 from the older file ($2), Nov 5-14 from the newer ($3), eve's 9 days at $1.
    close(m.usd, 4 * 2 + 10 * 3 + 9 * 1, "overlap once");
    assert.equal(m.overlaps, 6);
    assert.deepEqual(m.endsEarly, [{ developer: "eve", to: "2026-11-09" }]);
    assert.match(renderMerge(m, "x"), /eve's export ends 2026-11-09/);
});
test("merge: the month so far and its end at the last 14 days' pace", () => {
    const m = mergeExports([{ file: "f.json", data: synthetic("fay", "2026-10-25", "2026-11-14", 1) }]);
    // November so far: 14 days at $1; 16 days left at the last 14 days' $1/day.
    assert.deepEqual(m.forecast, { month: "2026-11", soFar: 14, perDay: 1, paceDays: 14, daysLeft: 16, usd: 30 });
    assert.match(renderMerge(m, "x"), /November 2026: \$14\.00 so far; ~\$30\.00 by month-end at the last 14 days' \$1\.00\/day \(an estimate\)/);
});
test("parseExport: refuses what is not an export, a newer version, a row that is not a total", () => {
    assert.equal(parseExport("{"), "not JSON");
    assert.equal(parseExport(JSON.stringify({ kind: "other" })), "not a context-doctor spend export");
    assert.match(parseExport(JSON.stringify({ ...synthetic("x", "2026-11-01", "2026-11-01", 1), version: 2 })), /version 2/);
    const bad = synthetic("x", "2026-11-01", "2026-11-01", 1);
    bad.rows[0].usd = "lots";
    assert.equal(parseExport(JSON.stringify(bad)), "a row is not a spend total");
    assert.equal(typeof parseExport("﻿" + JSON.stringify(synthetic("x", "2026-11-01", "2026-11-01", 1))), "object", "a byte-order mark is not part of it");
});
test("cli: spend --export writes the file, spend merge adds the folder up", async () => {
    const home = mkdtempSync(join(tmpdir(), "cd-spend-team-cli-"));
    try {
        const now = Date.now();
        writeClaudePlaces(home, writeRepos(home), now);
        const shared = join(home, "shared");
        mkdirSync(shared);
        const env = { ...sandboxEnv(home), CONTEXT_DOCTOR_CACHE_DIR: join(home, "cache") };
        const out = spawnSync(process.execPath, [cli, "spend", "--export", join(shared, "me.json"), "--as", "kim", "--by", "branch"], { env, encoding: "utf8" });
        assert.equal(out.status, 0, out.stderr);
        assert.match(out.stdout, /Wrote .*me\.json: \$0\.03 over 4 requests, .* as kim\./);
        assert.match(out.stdout, /no prompt, path, project or session/);
        const e = JSON.parse(readFileSync(join(shared, "me.json"), "utf8"));
        assert.equal(e.developer, "kim");
        assert.ok(e.rows.some((r) => r.branch === "feat/x"));
        const merged = spawnSync(process.execPath, [cli, "spend", "merge", shared], { env, encoding: "utf8" });
        assert.equal(merged.status, 0, merged.stderr);
        assert.match(merged.stdout, /Team spend: 1 export, 1 developer/);
        assert.match(merged.stdout, /By repository\n  shop/);
        const empty = spawnSync(process.execPath, [cli, "spend", "merge", join(home, "nothing-here")], { env, encoding: "utf8" });
        assert.equal(empty.status, 1);
        assert.match(empty.stderr, /no such folder/);
        const misuse = spawnSync(process.execPath, [cli, "spend", "--anonymize"], { env, encoding: "utf8" });
        assert.equal(misuse.status, 1);
        assert.match(misuse.stderr, /go with --export/);
        const json = spawnSync(process.execPath, [cli, "spend", "--export", "-", "--json"], { env, encoding: "utf8" });
        assert.equal(json.status, 1);
        assert.ok(!existsSync(join(home, "-")));
    }
    finally {
        rmSync(home, { recursive: true, force: true, maxRetries: 5 });
    }
});
