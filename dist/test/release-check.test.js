/**
 * scripts/release-check.mjs (ROADMAP E7): the weekly train's go/no-go. Its
 * pure parts, without git, GitHub or a network: the verdict (a blocking
 * failure is NO-GO, a warning never is), the train's day, cadence and release
 * notes, and the list of sources it shares with the weekly models.yml job.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "release-check.mjs");
const load = async () => import(pathToFileURL(SCRIPT).href);
test("the verdict: any blocking failure is NO-GO; warnings alone are GO", async () => {
    const { verdict } = await load();
    assert.equal(verdict([{ name: "npm test", status: "ok" }, { name: "dated prices", status: "warn" }]).go, true);
    const v = verdict([{ name: "CI", status: "fail" }, { name: "dated prices", status: "warn" }, { name: "npm test", status: "ok" }]);
    assert.equal(v.go, false);
    assert.deepEqual(v.blocking.map((b) => b.name), ["CI"]);
    assert.deepEqual(v.warnings.map((b) => b.name), ["dated prices"]);
});
test("the train: Tuesdays, a week apart; something to release; release notes for a version after this one", async () => {
    const { trainChecks } = await load();
    const roadmap = "## Shipped in 0.48.0: the next one\n\n## Shipped in 0.47.0: this one\n";
    const base = { lastTag: "v0.47.0", lastTagDate: "2026-11-10T13:57:59+05:30", version: "0.47.0", roadmap, commitsSince: 12 };
    // 2026-11-17 is a Tuesday, a week after the last release.
    assert.deepEqual(trainChecks({ ...base, today: "2026-11-17" }).map((r) => r.status), ["ok", "ok", "ok"]);
    // A Saturday, four days after: a warning, never a block (pricing and security fixes go out between trains).
    const early = trainChecks({ ...base, today: "2026-11-14" });
    assert.equal(early[0].status, "warn");
    assert.match(early[0].detail, /^Saturday, 4 days since v0\.47\.0: the train leaves on Tuesdays/);
    // A Tuesday only a day after a release: still a warning.
    assert.equal(trainChecks({ ...base, lastTagDate: "2026-11-16T09:00:00Z", today: "2026-11-17" })[0].status, "warn");
    assert.equal(trainChecks({ ...base, today: "2026-11-17", commitsSince: 0 })[1].status, "fail");
    const noNotes = trainChecks({ ...base, today: "2026-11-17", roadmap: "## Shipped in 0.47.0: this one\n" })[2];
    assert.equal(noNotes.status, "warn");
    assert.match(noNotes.detail, /no "## Shipped in X\.Y\.Z" after 0\.47\.0/);
});
test("check-models' sources are models.yml's: the release reads what the weekly job reads", async () => {
    const { modelsArgs } = await load();
    const args = modelsArgs(readFileSync(join(ROOT, ".github", "workflows", "models.yml"), "utf8"));
    for (const flag of ["--url", "--openai", "--codex", "--google", "--gemini-cli", "--dated"])
        assert.ok(args.includes(flag), flag);
    assert.ok(args.includes("https://developers.openai.com/api/docs/pricing.md"));
    assert.ok(args.includes("https://ai.google.dev/gemini-api/docs/pricing.md.txt"));
    assert.ok(args.every((a) => a.startsWith("--") || /^https:\/\//.test(a)), args.join(" "));
});
test("--plan lists the checks and runs none; an unknown flag is exit 2", () => {
    const plan = spawnSync(process.execPath, [SCRIPT, "--plan"], { encoding: "utf8" });
    assert.equal(plan.status, 0, plan.stderr);
    for (const name of ["checkout", "npm test", "CI", "canary (weekly)", "check-models", "dated prices", "verify-local", "train"])
        assert.match(plan.stdout, new RegExp(`^- ${name.replace(/[()]/g, "\\$&")}: `, "m"));
    assert.equal(spawnSync(process.execPath, [SCRIPT, "--nope"], { encoding: "utf8" }).status, 2);
});
