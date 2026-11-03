/**
 * `fix` run from inside a Claude Code session (the plugin's
 * /context-doctor:fix runs it through the Bash tool). Claude Code copies
 * every settings file's `env` into its process at start, so the process's
 * CLAUDE_CODE_SUBAGENT_MODEL may be a project's value, or fix's own value
 * left from before an undo: neither is "a value you set" in the shell.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type SubagentModelReplay } from "../subagentmodel.js";
import { applyFix, planFixes, type FixInputs } from "../fix.js";
import { effectiveEnv, settingsSources, shellSet } from "../effective.js";
import { sandboxEnv } from "./sandbox.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const SM = "CLAUDE_CODE_SUBAGENT_MODEL";

function replay(savedUsd: number): SubagentModelReplay {
  return {
    candidate: "claude-sonnet-5-5", agents: 200, requests: 9000, billedUsd: 1000, atCandidateUsd: 1000 - savedUsd, savedUsd, unpriced: 0, movedFrom: { "claude-opus-5-5": 900 }, before: { "claude-opus-5-5": 450 },
    byType: [{ type: "general-purpose", agents: 180, requests: 8000, billedUsd: 900, atCandidateUsd: 900 - savedUsd, atHaikuUsd: 30, over100k: 10, moves: true, readOnly: false }],
  };
}

function place(): { home: string; cwd: string; settings: string } {
  const home = mkdtempSync(join(tmpdir(), "cd-fis-"));
  mkdirSync(join(home, ".claude"));
  const cwd = mkdtempSync(join(tmpdir(), "cd-fis-proj-"));
  const settings = join(home, ".claude", "settings.json");
  writeFileSync(settings, "{}\n");
  return { home, cwd, settings };
}

test("shellSet: a settings copy or fix's own leftover is not the shell's; a shell export is", () => {
  const { home, cwd } = place();
  mkdirSync(join(cwd, ".claude"));
  writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ env: { [SM]: "claude-opus-5-5" } }));
  const sources = settingsSources({ home, cwd, env: { CONTEXT_DOCTOR_NO_MANAGED_SETTINGS: "1" } });
  assert.equal(shellSet(SM, sources, { [SM]: "claude-opus-5-5", CLAUDECODE: "1" }), false, "the project's value, copied in");
  assert.equal(shellSet(SM, [], { [SM]: "claude-sonnet-5-5", CLAUDECODE: "1" }, "claude-sonnet-5-5"), false, "fix's own, left from before an undo");
  assert.equal(shellSet(SM, [], { [SM]: "claude-sonnet-5-5" }, "claude-sonnet-5-5"), true, "outside Claude Code it is the shell's");
  assert.equal(shellSet(SM, [], { [SM]: "claude-haiku-5-5", CLAUDECODE: "1" }, "claude-sonnet-5-5"), true);
  assert.equal(shellSet(SM, [], { [SM]: " " }), false, "blank is unset");
  // Messages name the session's environment for what only the process holds.
  assert.match(effectiveEnv("CLAUDE_CODE_PROMPT_CACHE_TTL", [], { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m", CLAUDECODE: "1" })!.where, /in this Claude Code session's environment \(from the shell that started it, or a settings env removed since/);
  assert.match(effectiveEnv("CLAUDE_CODE_PROMPT_CACHE_TTL", [], { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" })!.where, /=5m in the environment$/);
});

test("apply inside Claude Code: fix's own value left in the session after undo does not block it; a shell value still does", async () => {
  const { home, cwd, settings } = place();
  const base: FixInputs = { days: 30, billedUsd: 2000, subagentModel: replay(600) };
  const [fix] = planFixes(base);
  const deps = { home, cwd, now: 5_000 };
  const own = await applyFix(fix, { ...deps, env: { CONTEXT_DOCTOR_NO_MANAGED_SETTINGS: "1", CLAUDECODE: "1", [SM]: "claude-sonnet-5-5" } });
  assert.equal(own.ok, true, own.lines.join("\n"));
  assert.equal(JSON.parse(readFileSync(settings, "utf8")).env[SM], "claude-sonnet-5-5");
  const { home: home2, cwd: cwd2, settings: settings2 } = place();
  const mine = await applyFix(fix, { home: home2, cwd: cwd2, now: 5_000, env: { CONTEXT_DOCTOR_NO_MANAGED_SETTINGS: "1", CLAUDECODE: "1", [SM]: "claude-haiku-5-5" } });
  assert.equal(mine.ok, false);
  assert.match(mine.lines[0], /claude-haiku-5-5 in this Claude Code session's environment.*a value you set: left as it is/);
  assert.equal(readFileSync(settings2, "utf8"), "{}\n");
});

test("fix inside Claude Code: a project's value copied into the session is the project's override, not 'a value you set'", () => {
  const { home, cwd } = place();
  mkdirSync(join(cwd, ".claude"));
  writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ env: { [SM]: "claude-opus-5-5" } }));
  const run = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [cli, "fix", "--json"], { encoding: "utf8", cwd, env: { ...sandboxEnv(home), ...env } });
  const sub = (env: NodeJS.ProcessEnv) => {
    const r = run(env);
    assert.equal(r.status, 0, r.stderr);
    return (JSON.parse(r.stdout).fixes as Array<{ id: string; note?: string; state: string }>).find((f) => f.id === "subagent-model");
  };
  assert.equal(sub({ CLAUDECODE: "1", [SM]: "claude-opus-5-5" }), undefined, "no 'set' entry: the project's value is not the user's");
  assert.equal(sub({ CLAUDECODE: "1", [SM]: "claude-sonnet-5-5" }), undefined, "fix's own value left in the session is no one's");
  const shell = sub({ [SM]: "claude-haiku-5-5" });
  assert.equal(shell?.state, "applied");
  assert.match(shell!.note!, /claude-haiku-5-5 in the environment/);
});
