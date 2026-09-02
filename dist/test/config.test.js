/** Project config discovery + context budget verdicts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBudget, loadConfig, RC_FILENAME } from "../config.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
test("loadConfig walks up to the nearest .contextdoctorrc", () => {
    const root = mkdtempSync(join(tmpdir(), "ctxdoc-cfg-"));
    const nested = join(root, "packages", "app", "src");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, RC_FILENAME), JSON.stringify({ budget: { maxTokens: 1234 } }));
    const loaded = loadConfig(nested);
    assert.equal(loaded.config.budget?.maxTokens, 1234);
    assert.equal(loaded.path, join(root, RC_FILENAME));
});
test("a malformed rc warns instead of throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "ctxdoc-cfg-bad-"));
    writeFileSync(join(root, RC_FILENAME), "{ not json");
    const warnings = [];
    const loaded = loadConfig(root, (m) => warnings.push(m));
    assert.deepEqual(loaded.config, {});
    assert.equal(warnings.length, 1);
});
test("checkBudget flags each configured limit independently", () => {
    const profile = { totalTokens: 200_000, usagePct: 65, cost: { perCallUsd: 1.2 } };
    assert.equal(checkBudget(undefined, profile).overBudget, false);
    assert.equal(checkBudget({}, profile).overBudget, false);
    const tokens = checkBudget({ maxTokens: 100_000 }, profile);
    assert.equal(tokens.overBudget, true);
    assert.match(tokens.breaches[0], /over the 100000 budget/);
    const cost = checkBudget({ maxCostPerMessageUsd: 0.5 }, profile);
    assert.match(cost.breaches[0], /per message/);
    const window = checkBudget({ maxWindowPct: 50 }, profile);
    assert.match(window.breaches[0], /% of the window/);
    const all = checkBudget({ maxTokens: 100_000, maxCostPerMessageUsd: 0.5, maxWindowPct: 50 }, profile);
    assert.equal(all.breaches.length, 3);
    const within = checkBudget({ maxTokens: 500_000, maxWindowPct: 90 }, profile);
    assert.equal(within.overBudget, false);
});
test("analyze reports budget status from the project rc", async () => {
    const root = mkdtempSync(join(tmpdir(), "ctxdoc-cfg-cli-"));
    writeFileSync(join(root, RC_FILENAME), JSON.stringify({ budget: { maxTokens: 10 } }));
    const chat = join(root, "chat.json");
    writeFileSync(chat, JSON.stringify({ messages: [{ role: "user", content: "a fairly long message ".repeat(40) }] }));
    const out = await new Promise((resolve, reject) => {
        execFile(process.execPath, [cliPath, "analyze", chat, "--model", "claude-sonnet-5"], { cwd: root }, (err, stdout) => err ? reject(err) : resolve(stdout));
    });
    assert.ok(out.includes("OVER BUDGET"), `expected budget breach in output:\n${out}`);
    assert.ok(out.includes(RC_FILENAME), "names the rc file responsible");
});
test("analyze stays quiet about budgets when no rc exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "ctxdoc-cfg-none-"));
    const chat = join(root, "chat.json");
    writeFileSync(chat, JSON.stringify({ messages: [{ role: "user", content: "hello" }] }));
    const out = await new Promise((resolve, reject) => {
        // HOME override keeps a real ~/.contextdoctorrc from leaking into the test.
        execFile(process.execPath, [cliPath, "analyze", chat], { cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root } }, (err, stdout) => err ? reject(err) : resolve(stdout));
    });
    assert.ok(!out.includes("BUDGET"), "no budget chatter without an rc");
});
test("--fail-over-budget exits 1 on a breach and 0 otherwise", async () => {
    const root = mkdtempSync(join(tmpdir(), "ctxdoc-gate-"));
    const chat = join(root, "chat.json");
    writeFileSync(chat, JSON.stringify({ messages: [{ role: "user", content: "a long message ".repeat(60) }] }));
    const run = () => new Promise((resolve) => {
        execFile(process.execPath, [cliPath, "analyze", chat, "--fail-over-budget"], { cwd: root }, (err) => resolve(err ? (err.code ?? 1) : 0));
    });
    writeFileSync(join(root, RC_FILENAME), JSON.stringify({ budget: { maxTokens: 10 } }));
    assert.equal(await run(), 1, "over budget must fail the build");
    writeFileSync(join(root, RC_FILENAME), JSON.stringify({ budget: { maxTokens: 10_000_000 } }));
    assert.equal(await run(), 0, "within budget must pass");
});
