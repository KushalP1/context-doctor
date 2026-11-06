/**
 * The price table against each provider's page as read on 2026-11-06: one
 * test per family with ids that must and must not match each row, the
 * fallbacks as they were, and every model seen on the author's machine in
 * the 90 days before that priced or unpriced on purpose.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { exactClaudePricingFor, hasKnownPrice, isUnbilledModel, knownPricingFor, pricingFor } from "../pricing.js";

const price = (model: string) => {
  const p = pricingFor(model);
  return p ? [p.inputPerM, p.outputPerM, p.cacheReadPerM] : undefined;
};
const known = (model: string) => {
  const p = knownPricingFor(model);
  return p ? [p.inputPerM, p.outputPerM, p.cacheReadPerM] : undefined;
};

/** Each id at its own row's price (known), and each id that must not take that row. */
function rows(cases: Array<[id: string, expected: number[], mustNot: string[]]>): void {
  for (const [id, expected, mustNot] of cases) {
    assert.deepEqual(known(id), expected, id);
    for (const other of mustNot) assert.notDeepEqual(price(other), expected, `${other} is not ${id}`);
  }
}

test("Anthropic, the 5 family: Fable/Mythos, Opus, Sonnet and Haiku by version", () => {
  rows([
    ["claude-fable-5-1", [10, 50, 0.25], ["claude-fable-5", "claude-fable-5-10"]],
    ["claude-mythos-5-1", [10, 50, 0.25], ["claude-mythos-5"]],
    ["claude-fable-5", [10, 50, 1], ["claude-fable-5-1"]],
    ["claude-opus-5-5", [4, 20, 0.2], ["claude-opus-5", "claude-opus-5-50", "claude-sonnet-5-5"]],
    ["claude-opus-5", [5, 25, 0.5], ["claude-opus-5-5"]],
    // Sonnet 5.5's cache hits are 5% of input on the page read 2026-11-06 (was $0.20 here).
    ["claude-sonnet-5-5", [2, 10, 0.1], ["claude-sonnet-5", "claude-sonnet-5-50"]],
    ["claude-sonnet-5", [2, 10, 0.2], ["claude-sonnet-5-5"]],
    ["claude-haiku-5-5", [0.1, 0.5, 0.01], ["claude-haiku-5", "claude-haiku-4-5"]],
  ]);
  // Dated, [1m] and cloud ids name the same version.
  assert.deepEqual(known("claude-sonnet-5-5-20261001"), [2, 10, 0.1]);
  assert.deepEqual(known("anthropic.claude-haiku-5-5"), [0.1, 0.5, 0.01]);
  assert.deepEqual(known("claude-opus-5-5[1m]"), [4, 20, 0.2]);
});

test("Anthropic, the 4 family and the retired Claude 3 models", () => {
  rows([
    ["claude-opus-4-8", [5, 25, 0.5], []],
    ["claude-opus-4-1-20250805", [15, 75, 1.5], ["claude-opus-4-8"]],
    ["claude-opus-4-20250514", [15, 75, 1.5], ["claude-opus-4-5"]],
    ["claude-sonnet-4-6", [3, 15, 0.3], []],
    ["claude-haiku-4-5-20251001", [1, 5, 0.1], ["claude-haiku-5-5"]],
    ["claude-3-opus-20240229", [15, 75, 1.5], []],
    ["claude-3-5-haiku-20241022", [0.8, 4, 0.08], ["claude-3-haiku-20240307"]],
    ["claude-3-haiku-20240307", [0.25, 1.25, 0.03], ["claude-3-5-haiku-20241022"]],
    ["claude-3-7-sonnet-20250219", [3, 15, 0.3], []],
  ]);
});

test("Claude ids the table knows only by family: priced by the fallback, but not known", () => {
  for (const [id, expected] of [
    ["claude-mythos-preview", [10, 50, 1]],
    ["claude-opus-9", [5, 25, 0.5]],
    ["claude-sonnet-6", [3, 15, 0.3]],
    ["claude-haiku-6", [1, 5, 0.1]],
    // Cursor's own names for Claude models.
    ["claude-4.6-opus-high-thinking", [5, 25, 0.5]],
  ] as const) {
    assert.deepEqual(price(id), expected, id);
    assert.equal(hasKnownPrice(id), false, id);
    assert.equal(exactClaudePricingFor(id), undefined, id);
  }
  assert.deepEqual(exactClaudePricingFor("claude-opus-5-5"), pricingFor("claude-opus-5-5"));
  assert.equal(exactClaudePricingFor("gpt-5.5"), undefined, "a Claude-only helper");
});

test("OpenAI, gpt-6 family: each model by its exact name", () => {
  rows([
    ["gpt-6-astra", [10, 50, 1], ["gpt-6", "gpt-6-astra-2"]],
    ["gpt-6-astra-law", [10, 50, 1], []],
    ["gpt-6.1-sol", [2, 10, 0.1], ["gpt-6-sol", "gpt-6.1"]],
    ["gpt-6-sol", [2, 10, 0.2], ["gpt-6.1-sol"]],
    ["gpt-6.1-terra", [1, 5, 0.05], ["gpt-6-terra"]],
    ["gpt-6-luna", [0.1, 0.5, 0.01], ["gpt-6.1-luna"]],
    ["gpt-6-cyber", [20, 100, 2], []],
    ["gpt-6-rosalind", [15, 75, 1.5], []],
    ["gpt-rosalind-research", [5, 25, 0.5], []],
    ["gpt-rosalind-discovery", [5, 25, 0.5], []],
  ]);
  // No gpt-6 fallback: an id the page does not list stays not priced.
  for (const id of ["gpt-6", "gpt-6.1", "gpt-6-terra", "gpt-6.2-sol"]) assert.equal(pricingFor(id), undefined, id);
  // Snapshot dates and provider prefixes name the same model.
  assert.deepEqual(known("gpt-6.1-sol-2026-10-01"), [2, 10, 0.1]);
  assert.deepEqual(known("openai/gpt-6-luna"), [0.1, 0.5, 0.01]);
});

test("OpenAI, gpt-5.x: each version, its -pro, -mini, -nano and -cyber apart", () => {
  rows([
    ["gpt-5.6-sol", [4, 20, 0.4], ["gpt-5.6-terra", "gpt-5.6-cyber"]],
    // The gpt-5.6 alias routes to Sol.
    ["gpt-5.6", [4, 20, 0.4], []],
    ["gpt-5.6-terra", [2, 12, 0.2], []],
    ["gpt-5.6-luna", [0.2, 1.2, 0.02], []],
    ["gpt-5.6-cyber", [12.5, 75, 1.25], []],
    ["gpt-5.5", [5, 30, 0.5], ["gpt-5.5-pro", "gpt-5.5-cyber", "gpt-5.5-codex"]],
    ["gpt-5.5-2026-04-23", [5, 30, 0.5], []],
    ["gpt-5.5-pro", [30, 180, 30], ["gpt-5.5"]],
    ["gpt-5.5-cyber", [12.5, 75, 1.25], []],
    ["gpt-5.4", [2.5, 15, 0.25], ["gpt-5.4-mini", "gpt-5.4-pro"]],
    ["gpt-5.4-mini", [0.75, 4.5, 0.075], ["gpt-5.4-nano"]],
    ["gpt-5.4-nano", [0.2, 1.25, 0.02], []],
    ["gpt-5.4-pro", [30, 180, 30], []],
    ["gpt-5.3-codex", [1.75, 14, 0.175], ["gpt-5.3"]],
    ["gpt-5.2", [1.75, 14, 0.175], ["gpt-5.2-pro"]],
    ["gpt-5.2-pro", [21, 168, 21], []],
    ["gpt-5.1", [1.25, 10, 0.125], []],
    ["gpt-5", [1.25, 10, 0.125], []],
    ["gpt-5-mini", [0.25, 2, 0.025], ["gpt-5-nano"]],
    ["gpt-5-nano", [0.05, 0.4, 0.005], []],
    ["gpt-5-pro", [15, 120, 15], []],
  ]);
});

test("OpenAI, gpt-4.x and o-series: gpt-4.1 apart from gpt-4o, o3 apart from o3-pro", () => {
  rows([
    ["gpt-4.1", [2, 8, 0.5], ["gpt-4.1-mini", "gpt-4o"]],
    ["gpt-4.1-mini", [0.4, 1.6, 0.1], []],
    ["gpt-4o", [2.5, 10, 1.25], ["gpt-4o-mini"]],
    ["gpt-4o-mini", [0.15, 0.6, 0.075], []],
    ["o3", [2, 8, 0.5], ["o3-pro", "o3-mini"]],
    ["o3-pro", [20, 80, 20], []],
    ["chat-latest", [5, 30, 0.5], []],
  ]);
});

test("OpenAI fallbacks price what they priced before, and are not known", () => {
  for (const [id, expected] of [
    ["gpt-5-codex", [1.25, 10, 0.125]],
    ["gpt-5.1-codex-max", [1.25, 10, 0.125]],
    ["gpt-5.9", [1.25, 10, 0.125]],
    ["gpt-5.1-codex-mini", [0.25, 2, 0.025]],
    ["gpt-4.1-nano", [2.5, 10, 1.25]],
    ["gpt-4-turbo", [10, 30, 10]],
    ["o1", [2, 8, 1]],
    ["o3-mini", [2, 8, 1]],
  ] as const) {
    assert.deepEqual(price(id), expected, id);
    assert.equal(hasKnownPrice(id), false, id);
  }
});

test("Google, Gemini: each text model, not its -lite, image or audio siblings", () => {
  rows([
    ["gemini-4-argon", [2, 10, 0.1], ["gemini-4"]],
    ["gemini-3.8-flash", [0.75, 3.75, 0.075], ["gemini-3.8-flash-lite-tts"]],
    ["gemini-3.6-flash", [0.75, 3.75, 0.075], []],
    ["gemini-3.5-flash-lite", [0.3, 2.5, 0.03], []],
    // Before, the 3.x Flash-Lite wildcard came first and priced 3.1 Flash-Lite at 3.5's $0.30.
    ["gemini-3.1-flash-lite", [0.25, 1.5, 0.025], ["gemini-3.1-flash-lite-image"]],
    ["gemini-3.1-pro-preview", [2, 12, 0.2], []],
    ["gemini-3.1-pro-preview-customtools", [2, 12, 0.2], []],
    ["gemini-3-flash-preview", [0.5, 3, 0.05], []],
    ["gemini-2.5-pro", [1.25, 10, 0.125], ["gemini-2.5-pro-preview-tts"]],
    ["gemini-2.5-flash", [0.3, 2.5, 0.03], ["gemini-2.5-flash-lite", "gemini-2.5-flash-image", "gemini-2.5-flash-preview-tts", "gemini-2.5-flash-native-audio-preview-09-2025"]],
    ["gemini-2.5-flash-preview-05-20", [0.3, 2.5, 0.03], []],
    ["models/gemini-2.5-flash-lite", [0.1, 0.4, 0.01], []],
  ]);
  for (const id of ["gemini-2.5-flash-image", "gemini-3.8-flash-tts", "gemini-2.5-flash-native-audio-preview-09-2025"]) assert.equal(hasKnownPrice(id), false, id);
});

test("Gemini fallbacks price what they priced before, and are not known", () => {
  for (const [id, expected] of [
    ["gemini-3-pro", [2, 12, 0.2]],
    ["gemini-3.9-flash", [0.75, 3.75, 0.075]],
    ["gemini-3.9-flash-lite", [0.3, 2.5, 0.03]],
    ["gemini-2.0-flash", [0.1, 0.4, 0.025]],
    ["gemini-1.5-pro", [1.25, 5, 0.31]],
  ] as const) {
    assert.deepEqual(price(id), expected, id);
    assert.equal(hasKnownPrice(id), false, id);
  }
});

test("nothing, an empty id or a stranger: no price, not known", () => {
  for (const id of [undefined, "", "llama-4", "default", "<synthetic>"]) {
    assert.equal(pricingFor(id), undefined, String(id));
    assert.equal(hasKnownPrice(id), false, String(id));
  }
});

/**
 * Every model id seen on the author's machine from 2026-08-08 to 2026-11-06
 * (read-only: Claude Code transcripts with subagents and workflow agents,
 * Codex rollouts, Cursor's history; no Gemini CLI chats in the window), with
 * a reason for each one left unpriced.
 */
const SEEN_LAST_90_DAYS = [
  "claude-opus-5-5",
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-fable-5",
  "claude-sonnet-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-opus-4-8",
  "<synthetic>",
  "gpt-5.6-sol",
  "gpt-5.6",
  "gpt-5.5",
  "default",
];
const UNPRICED_ON_PURPOSE: Record<string, string> = {
  "<synthetic>": "Claude Code's own replies (an error, an interruption): no API call, nothing billed",
  default: "Cursor's Auto: Cursor picks the model and publishes no per-token list price for it",
};

test("every model seen on the author's machine in the last 90 days has a known price, or a reason it has none", () => {
  for (const id of SEEN_LAST_90_DAYS) {
    if (hasKnownPrice(id)) continue;
    assert.ok(UNPRICED_ON_PURPOSE[id], `${id} has no price of its own and no reason`);
  }
  for (const id of Object.keys(UNPRICED_ON_PURPOSE)) assert.equal(hasKnownPrice(id), false, `${id} is priced now: drop its reason`);
  assert.equal(isUnbilledModel("<synthetic>"), true);
  assert.equal(isUnbilledModel("default"), false, "Cursor's Auto is billed, just not at a price we know");
  assert.equal(isUnbilledModel("claude-opus-5-5"), false);
});
