/** The preferences paste is the only standing channel for web and mobile chat; keep it short and complete. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAT_PREFERENCES, copyToClipboard, renderPreferences } from "../preferences.js";
import { estimateTokens } from "../tokens.js";

test("preferences: text is short enough to ride in every chat and names the sketch path", () => {
  assert.ok(estimateTokens(CHAT_PREFERENCES) < 130, `too long: ${estimateTokens(CHAT_PREFERENCES)} tokens`);
  assert.match(CHAT_PREFERENCES, /sketch/);
  assert.match(CHAT_PREFERENCES, /handoff/);
  assert.doesNotMatch(CHAT_PREFERENCES, /—/);
});

test("preferences: render reports clipboard outcome and lists both apps", () => {
  const out = renderPreferences(false);
  assert.match(out, /ChatGPT/);
  assert.match(out, /claude\.ai/);
  assert.match(out, /No clipboard tool/);
  assert.match(renderPreferences(true), /Copied/);
  assert.doesNotMatch(renderPreferences(undefined), /clipboard/i);
});

test("preferences: copy fails cleanly on a platform with no clipboard tool", () => {
  // "aix" has no candidate binaries in our table, so this exercises the miss path without touching the real clipboard.
  assert.equal(copyToClipboard("x", "aix" as NodeJS.Platform), false);
});
