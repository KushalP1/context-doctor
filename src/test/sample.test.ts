/**
 * The demonstration report: with no Claude Code history to replay, `savings`
 * is not a dead end — it shows the real replay pipeline's output on generated
 * sessions, said to be a sample in its first and last lines. `--sample` asks
 * for it on demand and never mixes with --json/--share.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateSavings } from "../savings.js";
import { renderSampleSavings } from "../savings.js";
import { writeSampleHistory } from "../sample.js";
import { sandboxEnv } from "./sandbox.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

function run(home: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, ...args], { env: sandboxEnv(home), timeout: 60_000 }, (error, stdout, stderr) =>
      resolve({ code: error ? (error as { code?: number }).code ?? 1 : 0, out: stdout, err: stderr })
    );
  });
}

test("the sample history replays through the real pipeline and shows both levers", () => {
  const h = writeSampleHistory();
  const dir = dirname(h.paths[0]);
  try {
    const r = estimateSavings(30, {}, h.paths);
    assert.equal(r.sessions.length, 2);
    assert.ok(r.billedUsd > 0);
    assert.ok(r.savedUsd > 0, "autopilot finds stale output to clear");
    assert.equal(r.worse, 0, "and no session is made more expensive");
    assert.equal(r.coldResumes, 2, "both long breaks are cold returns");
    assert.ok(r.coldResumeNetUsd > 0, "and compacting at them pays off");
  } finally {
    h.cleanup();
  }
  assert.ok(!existsSync(dir), "the temp folder is deleted afterwards");
});

test("the sample render says it is a sample, within 80 columns", () => {
  const h = writeSampleHistory();
  try {
    const text = renderSampleSavings(estimateSavings(30, {}, h.paths));
    assert.match(text, /^SAMPLE: what context-doctor finds/);
    assert.match(text, /Generated example sessions/);
    assert.match(text, /demonstration on generated data, not your usage/);
    assert.match(text, /savings --sample/);
    assert.doesNotMatch(text, /--share/, "a sample is never shared as if real");
    for (const line of text.split("\n")) assert.ok([...line].length <= 80, `too wide: ${line}`);
  } finally {
    h.cleanup();
  }
});

test("savings with no history is honest and offers the sample; --sample shows it", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-sample-cli-"));
  const r = await run(home, ["savings"]);
  assert.equal(r.code, 0, r.err);
  // No auto-substitution: the empty report says nothing was measured and
  // offers the sample, never the other way round.
  assert.doesNotMatch(r.out, /SAMPLE: what context-doctor finds/);
  assert.match(r.out, /nothing of yours was measured/);
  assert.match(r.out, /savings --sample/);
  assert.match(r.out, /run this again: `context-doctor savings`/);
  // --sample asks for the demonstration explicitly.
  const demo = await run(home, ["savings", "--sample"]);
  assert.match(demo.out, /SAMPLE: what context-doctor finds/);
  assert.match(demo.out, /Nothing was measured on this machine/);
  // --json and --share never carry a sample.
  const bad = await run(home, ["savings", "--sample", "--json"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /--sample.*--json or --share/);
  const json = await run(home, ["savings", "--json"]);
  assert.equal(json.code, 0, json.err);
  assert.doesNotMatch(json.out, /SAMPLE/);
});
