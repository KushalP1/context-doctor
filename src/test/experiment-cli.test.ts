/**
 * `experiment` through the CLI and against Claude Code's real project-dir
 * naming. The claude binary is never the real one: a missing path, or a stub.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findTranscript } from "../experiment.js";
import { sandboxEnv, withSandboxHome } from "./sandbox.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ctxdoc-expcli-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git("add", ".");
  git("commit", "-q", "-m", "start");
  return dir;
}

function experiment(cwd: string, claudeBin: string): Promise<{ code: number; stdout: string }> {
  const home = mkdtempSync(join(tmpdir(), "ctxdoc-expcli-home-"));
  const env: NodeJS.ProcessEnv = { ...sandboxEnv(home), CONTEXT_DOCTOR_CLAUDE_BIN: claudeBin };
  delete env.CLAUDECODE; // the harness refuses inside Claude Code; this test is not Claude Code
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, "experiment", "--task", "t", "--existing", "abc"], { cwd, env, timeout: 30_000 }, (err, stdout) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout })
    );
  });
}

test("experiment exits 1 when no arm could run", async () => {
  const dir = gitRepo();
  const r = await experiment(dir, join(dir, "..", "no-such-claude-binary"));
  assert.match(r.stdout, /fresh: could not run/);
  assert.match(r.stdout, /existing: could not run/);
  assert.equal(r.code, 1, "nothing was compared; a script must not read success");
});

test("experiment exits 0 when the arms ran", { skip: process.platform === "win32" && "sh stub" }, async () => {
  const dir = gitRepo();
  // Outside the repo: the harness cleans the tree between arms.
  const stub = join(mkdtempSync(join(tmpdir(), "ctxdoc-expcli-stub-")), "claude-stub.sh");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s' '{"session_id":"s1","total_cost_usd":0.01,"num_turns":1,"is_error":false,"usage":{"input_tokens":10,"output_tokens":5}}'\n`);
  chmodSync(stub, 0o755);
  assert.equal((await experiment(dir, stub)).code, 0);
});

test("the arm's transcript is found when the cwd has dots, underscores or spaces", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxdoc-exptx-"));
  const cwd = join(home, "my.repo_dir", "with space");
  // Claude Code's own naming: every non-alphanumeric character becomes "-".
  const projectDir = join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "sess-1.jsonl"), "");
  await withSandboxHome(home, () => {
    assert.equal(findTranscript("sess-1", cwd), join(projectDir, "sess-1.jsonl"));
    assert.equal(findTranscript("sess-2", cwd), undefined);
  });
});
