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
  const warnings: string[] = [];
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
  writeFileSync(
    chat,
    JSON.stringify({ messages: [{ role: "user", content: "a fairly long message ".repeat(40) }] })
  );

  const out = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, [cliPath, "analyze", chat, "--model", "claude-sonnet-5"], { cwd: root }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    );
  });
  assert.ok(out.includes("OVER BUDGET"), `expected budget breach in output:\n${out}`);
  assert.ok(out.includes(RC_FILENAME), "names the rc file responsible");
});

test("analyze stays quiet about budgets when no rc exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "ctxdoc-cfg-none-"));
  const chat = join(root, "chat.json");
  writeFileSync(chat, JSON.stringify({ messages: [{ role: "user", content: "hello" }] }));
  const out = await new Promise<string>((resolve, reject) => {
    // HOME override keeps a real ~/.contextdoctorrc from leaking into the test.
    execFile(process.execPath, [cliPath, "analyze", chat], { cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root } }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    );
  });
  assert.ok(!out.includes("BUDGET"), "no budget chatter without an rc");
});

test("--fail-over-budget exits 1 on a breach and 0 otherwise", async () => {
  const root = mkdtempSync(join(tmpdir(), "ctxdoc-gate-"));
  const chat = join(root, "chat.json");
  writeFileSync(chat, JSON.stringify({ messages: [{ role: "user", content: "a long message ".repeat(60) }] }));

  const run = (): Promise<number> =>
    new Promise((resolve) => {
      execFile(process.execPath, [cliPath, "analyze", chat, "--fail-over-budget"], { cwd: root }, (err) =>
        resolve(err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0)
      );
    });

  writeFileSync(join(root, RC_FILENAME), JSON.stringify({ budget: { maxTokens: 10 } }));
  assert.equal(await run(), 1, "over budget must fail the build");

  writeFileSync(join(root, RC_FILENAME), JSON.stringify({ budget: { maxTokens: 10_000_000 } }));
  assert.equal(await run(), 0, "within budget must pass");
});

test("every preset is valid config the loader actually understands", async () => {
  const { PRESETS, findPreset, loadConfig, RC_FILENAME } = await import("../config.js");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  assert.ok(PRESETS.length >= 3, "presets exist");
  for (const preset of PRESETS) {
    // A preset that the loader silently discards is worse than no preset.
    const dir = mkdtempSync(join(tmpdir(), `ctxdoc-preset-${preset.id}-`));
    writeFileSync(join(dir, RC_FILENAME), JSON.stringify(preset.config, null, 2));
    const { config, path } = loadConfig(dir);
    assert.ok(path, `${preset.id}: rc file must be discovered`);
    assert.deepEqual(config, preset.config, `${preset.id}: loads back unchanged`);
    assert.ok((config.budget?.maxTokens ?? 0) > 0, `${preset.id}: has a real token budget`);
    assert.ok((config.strategies ?? []).length > 0, `${preset.id}: names at least one strategy`);
  }
  assert.equal(findPreset("nope"), undefined, "an unknown id resolves to nothing");
});

test("config that will be silently ignored is named instead", async () => {
  const { validateConfig } = await import("../config.js");

  const warnings = validateConfig(
    {
      budget: { maxTokens: "lots", maxWindowPct: 150, maxTokns: 5 },
      strategies: ["trim-tool-result", "dedupe"],
      keepRecent: -10,
      colour: "blue",
    },
    "/x/.contextdoctorrc"
  );
  const joined = warnings.join("\n");

  // Each of these fails quietly today and looks like a broken feature.
  assert.match(joined, /maxTokens must be a positive number/, "a budget written as a string never triggers");
  assert.match(joined, /maxTokns is not a known budget limit/, "a typo'd limit does nothing");
  assert.match(joined, /maxWindowPct is above 100/, "a percentage over 100 can never be reached");
  assert.match(joined, /"trim-tool-result" is not a strategy/, "a typo'd strategy trims nothing");
  assert.match(joined, /keepRecent must be a positive whole number/, "a negative window disables trimming");
  assert.match(joined, /colour is not a known setting/, "an unknown key is ignored");

  // Valid config must stay silent, or the warnings become noise people skip.
  assert.deepEqual(
    validateConfig({ budget: { maxTokens: 120000, maxWindowPct: 60 }, strategies: ["dedupe"], keepRecent: 6 }, "/x"),
    []
  );
  // Arrays are objects in JavaScript; an rc file must still be a real object.
  assert.equal(validateConfig([1, 2, 3], "/x").length, 1);
});

test("every shipped preset validates clean", async () => {
  const { PRESETS, validateConfig } = await import("../config.js");
  for (const preset of PRESETS) {
    assert.deepEqual(validateConfig(preset.config, "/x"), [], `${preset.id} must not warn about itself`);
  }
});
