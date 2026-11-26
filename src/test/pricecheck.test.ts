// The weekly check compares the price pages' own figures with ours, not only
// that each model has a price: a row the page changed (GPT-6 Rosalind, $15 to
// $10) or a long tier a row left out (GPT-6 Astra for Law) is a red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { anthropicPagePrices, googlePagePrices, openaiPagePrices } from "../modelids.js";
import { pagePriceMismatches } from "../pricecheck.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const OPENAI = `
Standard

### Standard pricing data

| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Short context 12h write | Long context input | Long context output | Long context cached input | Long context 30m write | Long context 12h write |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-6-astra | $10.00 | $50.00 | $1.00 | $12.50 | $25.00 | $20.00 | $75.00 | $2.00 | $25.00 | $50.00 |

Fast

### Fast pricing data

| Model | Short context input | Short context output | Short context cached input | Long context input | Long context output | Long context cached input |
| --- | --- | --- | --- | --- | --- | --- |
| gpt-6-astra | $20.00 | $100.00 | $2.00 | $40.00 | $150.00 | $4.00 |

Standard

### Grouped Pricing Table data

| Category | Model | Input | Output | Cached input | 30m write | 12h write |
| --- | --- | --- | --- | --- | --- | --- |
| Life Sciences | gpt-6-rosalind (short context) | $10.00 | $50.00 | $1.00 | $12.50 | $25.00 |
| Life Sciences | gpt-6-rosalind (long context) | $20.00 | $75.00 | $2.00 | $25.00 | $50.00 |
| Life Sciences | gpt-rosalind-research (short context) | $5.00 | $25.00 | $0.50 | - | - |
| Life Sciences | gpt-rosalind-research (long context) | - | - | - | - | - |
| Embedding | text-embedding-3-small | $0.02 | - | - | - | - |

Standard

### Pricing Table data

| Model | Training | Input | Output | Cached input |
| --- | --- | --- | --- | --- |
| gpt-4.1-2025-04-14 | $25.00 | $3.00 | $12.00 | $0.75 |
`;

const ANTHROPIC = `
| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| --- | --- | --- | --- | --- | --- |
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |
| Claude Sonnet 5 | $2 / MTok<sup>3</sup> | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok<sup>3</sup> |
| Claude Mythos 5.2 ([limited availability](https://support.claude.com/x)) | $8 / MTok | $10 / MTok | $16 / MTok | $0.20 / MTok<sup>1</sup> | $40 / MTok |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |

| Model | Input | Output |
| --- | --- | --- |
| Claude Fable 5.2 | $16 USD / MTok | $80 USD / MTok |
`;

const GOOGLE = `
## Gemini 4 Carbon  {% id="gemini-4-carbon" %}
{% tabs %}
  {% tab title="Standard" %}
  {% table %}
  * Feature
  * Free Tier
  * Paid Tier, per 1M tokens in USD
  ---
  * Input price
  * Not available
  * $2.00 through November 30, 2026.
  $4.00 starting December 1, 2026.
  ---
  * Output price (including thinking tokens)
  * Not available
  * $10.00 through November 30, 2026.
  $20.00 starting December 1, 2026.
  ---
  * Context caching price
  * Not available
  * $0.10 through November 30, 2026.
  $0.20 starting December 1, 2026.
  {% /table %}
  {% /tab %}
  {% tab title="Batch" %}
  {% table %}
  * Feature
  * Free Tier
  * Paid Tier, per 1M tokens in USD
  ---
  * Input price
  * Not available
  * $1.00
  {% /table %}
  {% /tab %}
{% /tabs %}
## Gemini 2.5 Pro  {% id="gemini-2.5-pro" %}
{% tabs %}
  {% tab title="Standard" %}
  {% table %}
  * Feature
  * Free Tier
  * Paid Tier, per 1M tokens in USD
  ---
  * Input price
  * Free of charge
  * $1.25, prompts <= 200k tokens
  $2.50, prompts > 200k tokens
  ---
  * Output price (including thinking tokens)
  * Free of charge
  * $10.00, prompts <= 200k tokens
  $15.00, prompts > 200k
  ---
  * Context caching price
  * Not available
  * $0.125, prompts <= 200k tokens
  $0.25, prompts > 200k
  $4.50 / 1,000,000 tokens per hour (storage price)
  {% /table %}
  {% /tab %}
{% /tabs %}
## Gemini Embedding 2  {% id="gemini-embedding-2" %}
  * Input price
  * Free of charge
  * $0.15
`;

test("OpenAI's page: Standard prices only (not Fast or fine-tuning), the main table's long columns and the row pairs' long rows; '-' is no price", () => {
  assert.deepEqual(openaiPagePrices(OPENAI), [
    { model: "gpt-6-astra", short: { input: 10, output: 50, cached: 1 }, long: { input: 20, output: 75, cached: 2 } },
    { model: "gpt-6-rosalind", short: { input: 10, output: 50, cached: 1 }, long: { input: 20, output: 75, cached: 2 } },
    { model: "gpt-rosalind-research", short: { input: 5, output: 25, cached: 0.5 } },
  ]);
});

test("Anthropic's page: each Claude row as its id, footnotes and notes dropped, Haiku 5.5's over-100k row as its long tier", () => {
  assert.deepEqual(anthropicPagePrices(ANTHROPIC), [
    { model: "claude-haiku-5-5", short: { input: 0.1, output: 0.5, cached: 0.01 }, long: { input: 0.5, output: 2.5, cached: 0.05 } },
    { model: "claude-mythos-5-2", short: { input: 8, output: 40, cached: 0.2 } },
    { model: "claude-opus-5-5", short: { input: 4, output: 20, cached: 0.2 } },
    { model: "claude-sonnet-5", short: { input: 2, output: 10, cached: 0.2 } },
  ]);
});

test("Google's page: the Standard tab's paid cells, today's price before a dated one, prompt-size tiers, no storage price, text models only", () => {
  assert.deepEqual(googlePagePrices(GOOGLE), [
    { model: "gemini-2.5-pro", short: { input: 1.25, output: 10, cached: 0.125 }, long: { input: 2.5, output: 15, cached: 0.25 } },
    { model: "gemini-4-carbon", short: { input: 2, output: 10, cached: 0.1 } },
  ]);
});

test("the pages' prices against ours: every fixture row matches today's table; a changed price and a missing long tier are named", () => {
  const at = Date.parse("2026-11-26T12:00:00Z");
  assert.deepEqual(pagePriceMismatches([...openaiPagePrices(OPENAI), ...anthropicPagePrices(ANTHROPIC), ...googlePagePrices(GOOGLE)], at), []);
  const wrong = pagePriceMismatches([
    { model: "gpt-6-rosalind", short: { input: 15, output: 75, cached: 1.5 }, long: { input: 30, output: 112.5, cached: 3 } },
    { model: "gpt-rosalind-research", short: { input: 5, output: 25, cached: 0.5 }, long: { input: 10, output: 37.5, cached: 1 } },
    { model: "claude-opus-5-5", short: { input: 4, output: 20, cached: 0.2 }, long: undefined },
    { model: "no-such-model", short: { input: 1, output: 1 } },
  ], at);
  assert.equal(wrong.length, 2);
  assert.match(wrong[0], /^gpt-6-rosalind: short-context input \$15 on the page, \$10 here; short-context output \$75 on the page, \$50 here/);
  assert.match(wrong[1], /^gpt-rosalind-research: the page has a long-context price \(\$10 \/ \$37\.5\) and src\/pricing\.ts has no long tier/);
});

test("scripts/check-models.mjs: a page whose price differs from ours exits 1 naming the model and both figures", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-pricecheck-"));
  try {
    const run = (...args: string[]) => spawnSync(process.execPath, [join(repoRoot, "scripts", "check-models.mjs"), ...args], { encoding: "utf8" });
    const page = join(dir, "openai.md");
    writeFileSync(page, OPENAI);
    const ok = run("--openai", page);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /all 3 OpenAI prices on the page \(standard tier\) match src\/pricing\.ts/);
    writeFileSync(page, OPENAI.replace("| gpt-6-astra | $10.00 | $50.00 |", "| gpt-6-astra | $12.00 | $50.00 |"));
    const bad = run("--openai", page);
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /1 of 3 OpenAI prices differ from src\/pricing\.ts:\n {4}gpt-6-astra: short-context input \$12 on the page, \$10 here/);
    const claude = join(dir, "anthropic.md");
    writeFileSync(claude, ANTHROPIC);
    const ant = run("--file", claude);
    assert.equal(ant.status, 0, ant.stdout + ant.stderr);
    assert.match(ant.stdout, /all 4 Claude prices on the page \(standard tier\) match/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
