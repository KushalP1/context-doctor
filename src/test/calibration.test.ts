/**
 * Calibration learns from the user's own exact counts and is never silent.
 * Runs with the calibration file redirected into a sandbox and the global
 * test-runner disable switch cleared, so it exercises the real path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function withCalibrationSandbox<T>(fn: () => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ctxdoc-calib-"));
  const saved = { state: process.env.CONTEXT_DOCTOR_HOOK_STATE, off: process.env.CONTEXT_DOCTOR_NO_CALIBRATION };
  process.env.CONTEXT_DOCTOR_HOOK_STATE = join(dir, "state.json"); // calibration file lives beside it
  delete process.env.CONTEXT_DOCTOR_NO_CALIBRATION;
  try {
    return await fn();
  } finally {
    if (saved.state === undefined) delete process.env.CONTEXT_DOCTOR_HOOK_STATE;
    else process.env.CONTEXT_DOCTOR_HOOK_STATE = saved.state;
    if (saved.off === undefined) delete process.env.CONTEXT_DOCTOR_NO_CALIBRATION;
    else process.env.CONTEXT_DOCTOR_NO_CALIBRATION = saved.off;
  }
}

test("an exact count recalibrates later estimates for the same model family, visibly", async () => {
  const { recordCalibration, calibrationFor } = await import("../calibration.js");
  const { profileConversation } = await import("../profile.js");
  const { parseConversation } = await import("../parse.js");
  const { renderProfile } = await import("../report.js");

  await withCalibrationSandbox(() => {
    const conv = parseConversation(JSON.stringify({ messages: [{ role: "user", content: "word ".repeat(2000) }] }));
    const before = profileConversation(conv, "claude-sonnet-5");
    assert.equal(before.calibration, undefined, "no exact count yet: raw heuristic, and the profile says nothing");

    // The API said the heuristic was 20% low on this content.
    recordCalibration("claude-sonnet-5", Math.round(before.totalTokens * 1.2), before.totalTokens);
    assert.ok(Math.abs(calibrationFor("claude-opus-5").factor - 1.2) < 0.01, "applies to the whole family, not one model id");

    const after = profileConversation(conv, "claude-opus-5");
    assert.ok(after.totalTokens > before.totalTokens * 1.15, `estimate should scale up, got ${before.totalTokens} -> ${after.totalTokens}`);
    assert.equal(after.calibration?.samples, 1);
    assert.match(renderProfile(after), /calibrated \+20% from 1 exact count/, "scaled numbers must say so");

    // A different family is untouched.
    assert.equal(profileConversation(conv, "gpt-4o").calibration, undefined);
  });
});

test("a broken sample cannot poison the calibration, and the switch disables it", async () => {
  const { recordCalibration, calibrationFor } = await import("../calibration.js");
  await withCalibrationSandbox(() => {
    recordCalibration("claude-sonnet-5", 1_000_000, 100); // 10000x: not a calibration, a bug somewhere
    assert.equal(calibrationFor("claude-sonnet-5").factor, 1, "out-of-range ratios are ignored");
    recordCalibration("claude-sonnet-5", 0, 100);
    recordCalibration("claude-sonnet-5", 120, 0);
    assert.equal(calibrationFor("claude-sonnet-5").samples, 0, "zero and missing counts are ignored");

    recordCalibration("claude-sonnet-5", 110, 100);
    assert.ok(calibrationFor("claude-sonnet-5").factor > 1.05);
    process.env.CONTEXT_DOCTOR_NO_CALIBRATION = "1";
    assert.equal(calibrationFor("claude-sonnet-5").factor, 1, "the escape hatch returns raw estimates");
  });
});
