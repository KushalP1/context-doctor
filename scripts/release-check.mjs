#!/usr/bin/env node
// Go or no-go for the weekly release (CONTRIBUTING.md, "Releasing"). Runs, in
// order, and stops at nothing: the checkout (clean, on main, level with
// origin/main), npm test, CI on this commit, the latest weekly canary and
// model-price runs on GitHub, check-models against the hosts and price pages
// (the list in .github/workflows/models.yml) and the dated rows, the Claude
// Code surface report, and scripts/verify-local.sh (which runs the canary on
// the newest Claude Code here). Then the train: how long since the last
// release, and the release notes for the next one. Read-only: it changes no
// file it did not build, bumps nothing, tags nothing, publishes nothing.
//
//   node scripts/release-check.mjs            everything (verify-local takes a few minutes)
//   node scripts/release-check.mjs --quick    without verify-local
//   node scripts/release-check.mjs --plan     print the checks, run none
//
// Exit 0 GO, 1 NO-GO (a blocking check failed). A warning never blocks: a
// dated price without a successor (a release cannot add a price nobody has
// published, and every version says the price changed once it has), a
// surface to review, a release earlier than the train's day.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The day of the week the train leaves (0 Sunday ... 2 Tuesday). */
export const TRAIN_DAY = 2;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The verdict over every check's result: blocking failures make it NO-GO, warnings never do. */
export function verdict(results) {
  const blocking = results.filter((r) => r.status === "fail");
  const warnings = results.filter((r) => r.status === "warn");
  return { go: blocking.length === 0, blocking, warnings };
}

/** check-models' arguments from models.yml's step, so the release checks what the weekly job checks. */
export function modelsArgs(workflow) {
  const i = workflow.indexOf("node scripts/check-models.mjs");
  if (i === -1) return [];
  const end = workflow.indexOf("\n\n", i);
  return workflow.slice(i, end === -1 ? undefined : end).split(/\s+/).filter(Boolean).slice(2);
}

/** "x.y.z" newer than "a.b.c". */
function newer(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/**
 * The train's own checks: the day, the time since the last release, and the
 * release notes publish.yml takes from ROADMAP.md ("## Shipped in X.Y.Z" for
 * a version after the current one).
 */
export function trainChecks({ today, lastTag, lastTagDate, version, roadmap, commitsSince }) {
  const out = [];
  const day = new Date(`${today}T12:00:00Z`).getUTCDay();
  const days = lastTagDate ? Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastTagDate.slice(0, 10)}T00:00:00Z`)) / 864e5) : undefined;
  if (day === TRAIN_DAY && (days === undefined || days >= 6)) out.push({ name: "train", status: "ok", detail: `${DAY_NAMES[day]}, ${days ?? "?"} days since ${lastTag ?? "the last release"}` });
  else out.push({ name: "train", status: "warn", detail: `${DAY_NAMES[day]}, ${days ?? "?"} days since ${lastTag ?? "the last release"}: the train leaves on ${DAY_NAMES[TRAIN_DAY]}s, at most once a week; between trains, only a pricing or security fix` });
  if (commitsSince === 0) out.push({ name: "something to release", status: "fail", detail: `nothing since ${lastTag}` });
  else if (commitsSince !== undefined) out.push({ name: "something to release", status: "ok", detail: `${commitsSince} commit${commitsSince === 1 ? "" : "s"} since ${lastTag}` });
  const notes = [...roadmap.matchAll(/^## Shipped in (\d+\.\d+\.\d+)/gm)].map((m) => m[1]).filter((v) => newer(v, version));
  if (notes.length) out.push({ name: "release notes", status: "ok", detail: `ROADMAP.md has "## Shipped in ${notes[0]}"` });
  else out.push({ name: "release notes", status: "warn", detail: `no "## Shipped in X.Y.Z" after ${version} in ROADMAP.md: the GitHub release would say only "See ROADMAP.md."` });
  return out;
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  return { status: r.error ? -1 : r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, error: r.error };
}
const tail = (s, n = 8) => s.trim().split("\n").slice(-n).map((l) => `    ${l}`).join("\n");

/** The newest run of a workflow (on this commit, if given), from gh. */
function ghRun(workflow, sha) {
  const r = sh("gh", ["run", "list", "--workflow", workflow, "--branch", "main", "--limit", sha ? "20" : "1", "--json", "status,conclusion,headSha,createdAt,url"]);
  if (r.status !== 0) return { error: r.error ? "gh not found" : r.out.trim().split("\n")[0] };
  const runs = JSON.parse(r.out || "[]");
  return { run: sha ? runs.find((x) => x.headSha === sha) : runs[0] };
}

const CHECKS = [
  ["checkout", "clean, on main, level with origin/main"],
  ["npm test", "the whole suite (builds first)"],
  ["dist", "committed dist/ matches src/"],
  ["CI", "ci.yml green on this commit (3 OSes x Node 20/22/24)"],
  ["canary (weekly)", "the newest canary.yml run on main is green"],
  ["model prices (weekly)", "the newest models.yml run on main is green"],
  ["check-models", "every model the hosts and price pages name has a price (models.yml's list, read now)"],
  ["dated prices", "no row's price ends within 14 days without a successor (a warning)"],
  ["Claude Code surface", "what the newest Claude Code here adds since docs/hosts-reviewed.json (a report)"],
  ["verify-local", "scripts/verify-local.sh: smokes, the published package, Python, real history, the canary, install round trip (skipped by --quick)"],
  ["train", "the train's day and the time since the last release; something to release; the release notes"],
];

async function main() {
  const args = process.argv.slice(2);
  const bad = args.filter((a) => !["--quick", "--plan"].includes(a));
  if (bad.length) {
    console.error(`usage: release-check.mjs [--quick] [--plan]  (got ${bad.join(" ")})`);
    process.exit(2);
  }
  if (args.includes("--plan")) {
    for (const [name, what] of CHECKS) console.log(`- ${name}: ${what}`);
    return;
  }
  const quick = args.includes("--quick");
  const results = [];
  const add = (name, status, detail) => {
    results.push({ name, status, detail });
    console.log(`${status === "ok" ? "✓" : status === "warn" ? "⚠" : "✗"} ${name}${detail ? `: ${detail}` : ""}`);
  };

  // The checkout.
  sh("git", ["fetch", "--quiet", "origin"]);
  const sha = sh("git", ["rev-parse", "HEAD"]).out.trim();
  const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
  const dirty = sh("git", ["status", "--porcelain", "--untracked-files=no"]).out.trim();
  const remote = sh("git", ["rev-parse", "origin/main"]).out.trim();
  if (dirty) add("checkout", "fail", `uncommitted changes:\n${tail(dirty)}`);
  else if (sha !== remote) add("checkout", "fail", `HEAD ${sha.slice(0, 7)} (${branch}) is not origin/main ${remote.slice(0, 7)}: release what CI tested`);
  else add("checkout", "ok", `${sha.slice(0, 7)} = origin/main`);

  const test = sh("npm", ["test"], { shell: process.platform === "win32" });
  const passLine = test.out.match(/^ℹ pass \d+$/m)?.[0].slice(2);
  add("npm test", test.status === 0 && /^ℹ fail 0$/m.test(test.out) ? "ok" : "fail", test.status === 0 ? passLine : `exit ${test.status}\n${tail(test.out.split("\n").filter((l) => /^✖|^ℹ (pass|fail)/.test(l)).join("\n"))}`);
  const dist = sh("git", ["diff", "--quiet", "--", "dist"]);
  add("dist", dist.status === 0 ? "ok" : "fail", dist.status === 0 ? "" : "the build changed dist/: commit it");

  // GitHub: CI on this commit, the weekly jobs' latest runs.
  const ci = ghRun("ci.yml", sha);
  if (ci.error) add("CI", "fail", `could not ask GitHub (${ci.error}); check the Actions tab by hand`);
  else if (!ci.run) add("CI", "fail", `no CI run for ${sha.slice(0, 7)} yet`);
  else if (ci.run.status !== "completed") add("CI", "fail", `still ${ci.run.status}: ${ci.run.url}`);
  else add("CI", ci.run.conclusion === "success" ? "ok" : "fail", `${ci.run.conclusion} ${ci.run.url}`);
  for (const [name, wf] of [["canary (weekly)", "canary.yml"], ["model prices (weekly)", "models.yml"]]) {
    const w = ghRun(wf);
    if (w.error) add(name, "fail", `could not ask GitHub (${w.error})`);
    else if (!w.run) add(name, "warn", "never run: Actions > run it by hand");
    else add(name, w.run.conclusion === "success" ? "ok" : "fail", `${w.run.conclusion || w.run.status} on ${w.run.createdAt.slice(0, 10)} ${w.run.url}`);
  }

  // The prices: what the weekly job checks, read now; the dated rows apart, as a warning.
  const pages = modelsArgs(readFileSync(join(repo, ".github", "workflows", "models.yml"), "utf8")).filter((a) => a !== "--dated");
  const cm = sh(process.execPath, ["scripts/check-models.mjs", ...pages]);
  const unreachable = cm.out.split("\n").filter((l) => l.startsWith("::warning")).length;
  add("check-models", cm.status === 0 ? (unreachable ? "warn" : "ok") : "fail", cm.status === 0 ? (unreachable ? `${unreachable} source(s) not read:\n${tail(cm.out.split("\n").filter((l) => l.startsWith("::warning")).join("\n"))}` : "every model priced") : tail(cm.out.split("\n").filter((l) => l.startsWith("✗")).join("\n")));
  const dated = sh(process.execPath, ["scripts/check-models.mjs", "--dated"]);
  add("dated prices", dated.status === 0 ? "ok" : dated.status === 1 ? "warn" : "fail", dated.status === 0 ? dated.out.trim().replace(/^✓ /, "") : tail(dated.out));

  const surface = sh(process.execPath, ["scripts/claude-surface.mjs"]);
  if (surface.status === 0) {
    const changed = surface.out.split("\n").filter((l) => /: \d+ new, \d+ removed/.test(l));
    add("Claude Code surface", changed.length ? "warn" : "ok", changed.length ? `${changed.map((l) => l.trim()).join("; ")}: run node scripts/claude-surface.mjs and review` : surface.out.split("\n")[0].replace(/^== /, ""));
  } else add("Claude Code surface", "warn", tail(surface.out, 2));

  if (quick) add("verify-local", "warn", "skipped (--quick)");
  else {
    console.log("… verify-local (a few minutes)");
    const v = sh("bash", ["scripts/verify-local.sh"]);
    const result = v.out.match(/^== RESULT: (\d+) passed, (\d+) failed$/m);
    add("verify-local", result && result[2] === "0" ? "ok" : "fail", result ? `${result[1]} passed, ${result[2]} failed${result[2] === "0" ? "" : `\n${tail(v.out.slice(v.out.indexOf("== RESULT")), 12)}`}` : `no result line\n${tail(v.out)}`);
  }

  // The train.
  const lastTag = sh("git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"]).out.trim() || undefined;
  const lastTagDate = lastTag ? sh("git", ["log", "-1", "--format=%cI", lastTag]).out.trim() : undefined;
  const commitsSince = lastTag ? Number(sh("git", ["rev-list", "--count", `${lastTag}..HEAD`]).out.trim()) : undefined;
  const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
  for (const r of trainChecks({ today: new Date().toISOString().slice(0, 10), lastTag, lastTagDate, version, roadmap: readFileSync(join(repo, "ROADMAP.md"), "utf8"), commitsSince })) add(r.name, r.status, r.detail);

  const v = verdict(results);
  console.log("");
  if (v.go) console.log(`GO${v.warnings.length ? ` (${v.warnings.length} warning${v.warnings.length === 1 ? "" : "s"}: ${v.warnings.map((w) => w.name).join(", ")})` : ""}: npm version minor (or patch), then git push --follow-tags`);
  else console.log(`NO-GO: ${v.blocking.map((b) => b.name).join(", ")}`);
  process.exit(v.go ? 0 : 1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
