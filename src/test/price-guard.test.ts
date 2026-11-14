/**
 * The price guard beyond Claude (ROADMAP E7): every model OpenAI's and
 * Google's price pages, Codex's model catalog and Gemini CLI's model list
 * name has a price of its own, and a row whose price ends within 14 days has
 * its successor price, or scripts/check-models.mjs fails. The fixtures are
 * cut from the pages as read on 2026-11-14.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexModelIds, datedRows, dueRows, geminiCliIds, googlePageIds, openaiPageIds, unpriced } from "../modelids.js";
import { knownPricingFor, priceChange } from "../pricing.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const OPENAI_PAGE = `
### Standard pricing data

| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Short context 12h write | Long context input | Long context output | Long context cached input | Long context 30m write | Long context 12h write |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-6-astra | $10.00 | $50.00 | $1.00 | $12.50 | $25.00 | $20.00 | $75.00 | $2.00 | $25.00 | $50.00 |
| gpt-5.5 (<272K context length) | $5.00 | $30.00 | $0.50 | - | - | $10.00 | $45.00 | $1.00 | - | - |

| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-5.4-mini | $0.75 | $4.50 | $0.075 |

### Grouped Pricing Table data
| Model | Modality | Input | Output | Cached input |
| --- | --- | --- | --- | --- |
| gpt-image-2 | Image | $8.00 | $30.00 | $2.00 |
| gpt-realtime-2.1 | Text | $4.00 | $24.00 | $0.40 |

| Model | Price per minute |
| --- | --- |
| gpt-live-1 | $0.05 |

| Category | Model | Input | Output | Cached input | 30m write | 12h write |
| --- | --- | --- | --- | --- | --- | --- |
| <a id="cyber-models"></a>Cyber — Trusted Access | gpt-6-cyber (short context) | $20.00 | $100.00 | $2.00 | $25.00 | $50.00 |
| Cyber — Trusted Access | gpt-5.5-cyber-preview (short context) | $12.50 | $75.00 | $1.25 | - | - |
| Search | gpt-5-search-api | $1.25 | $10.00 | $0.125 | - | - |
| Embedding | text-embedding-3-small | $0.02 | - | - | - | - |
| Moderation | omni-moderation-latest | Free | - | - | - | - |

| Tool | Details | Pricing |
| --- | --- | --- |
| Web search | Web search (incl. images) | $10.00 / 1k calls |

| Model | Training | Input | Output | Cached input |
| --- | --- | --- | --- | --- |
| gpt-4.1-2025-04-14 | $25.00 | $3.00 | $12.00 | $0.75 |
`;

const GOOGLE_PAGE = `
## Gemini 4 Carbon  {% id="gemini-4-carbon" %}
  {% left-column class="center-vertically" %}
  *[\`gemini-4-carbon\`](/docs/models/gemini-4-carbon)*
  * $2.00 through November 30, 2026.
  $4.00 starting December 1, 2026.
## Gemini 4 Hydrogen  {% id="gemini-4-hydrogen" %}
  *[\`gemini-4-hydrogen\`](/docs/models/gemini-4-hydrogen)*
## Gemini 3.5 Transcribe  {% id="gemini-3.5-transcribe" %}
  *[\`gemini-3.5-transcribe\`](/docs/models/gemini-3.5-transcribe)*
## Gemini Omni 1.2 Flash  {% id="gemini-omni-1.2-flash" %}
  *[\`gemini-omni-1.2-flash\`](/docs/models/gemini-omni-flash)*
## Gemini 3.1 Flash Image (Nano Banana 2)  {% id="gemini-3.1-flash-image" %}
  *[\`gemini-3.1-flash-image\`](/docs/models/gemini-3.1-flash-image)*
## Gemini 2.5 Pro  {% id="gemini-2.5-pro" %}
  Effective December 1, 2026, all API requests to \`gemini-2.5-pro\` will automatically route to
  *[\`gemini-2.5-pro\`](/docs/models/gemini-2.5-pro)*
## Gemini Decision 1  {% id="gemini-decision" %}
  *[\`gemini-decision-1\`](/docs/models/gemini-decision-1)*
## Gemini Embedding 2  {% id="gemini-embedding-2" %}
  *[\`gemini-embedding-2\`](/docs/models/gemini-embedding-2)*
`;

test("OpenAI's price page: the text models of every table, by their model column; not images, audio, minutes, tools, embeddings or moderation", () => {
  assert.deepEqual(openaiPageIds(OPENAI_PAGE), [
    "gpt-4.1-2025-04-14", "gpt-5-search-api", "gpt-5.4-mini", "gpt-5.5", "gpt-5.5-cyber-preview", "gpt-6-astra", "gpt-6-cyber",
  ]);
});

test("Google's price page: each section's model id, text models only", () => {
  assert.deepEqual(googlePageIds(GOOGLE_PAGE), ["gemini-2.5-pro", "gemini-4-carbon", "gemini-4-hydrogen"]);
});

test("Codex's catalog: the models its picker lists, and the hidden ones apart", () => {
  const json = JSON.stringify({ models: [
    { slug: "gpt-6.1-sol", visibility: "list" }, { slug: "gpt-5.5", visibility: "list" },
    { slug: "gpt-daybreak-blue-latest", visibility: "hide" }, { slug: "codex-auto-review", visibility: "hide" },
  ] });
  assert.deepEqual(codexModelIds(json), { listed: ["gpt-5.5", "gpt-6.1-sol"], hidden: ["codex-auto-review", "gpt-daybreak-blue-latest"] });
});

test("Gemini CLI's model list: full model ids, not family prefixes or the embedding model", () => {
  const src = `export const PREVIEW_GEMINI_MODEL = 'gemini-3-pro-preview';
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-pro';
export const BASE_GEMINI_FLASH_MODEL = 'gemini-3.5-flash';
export const LATEST_GEMINI_FLASH_LITE_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001';
if (resolved.startsWith('gemini-')) return definition.family === 'gemini-3' || x === 'gemini-2.5';`;
  assert.deepEqual(geminiCliIds(src), ["gemini-2.5-pro", "gemini-3-pro-preview", "gemini-3.5-flash", "gemini-3.5-flash-lite"]);
  // Not on Google's price page: priced by a family row on purpose, with the reason recorded.
  assert.deepEqual(unpriced(geminiCliIds(src)), []);
});

test("the rows added on 2026-11-14, each at the page's price; every model the fixtures name is priced", () => {
  const p = (id: string) => { const r = knownPricingFor(id); return r && [r.inputPerM, r.outputPerM, r.cacheReadPerM]; };
  assert.deepEqual(p("gemini-4-carbon"), [2, 10, 0.1]);
  assert.deepEqual(priceChange("gemini-4-carbon"), { on: "2026-12-01", then: { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2 } });
  assert.deepEqual(p("gemini-4-hydrogen"), [1.5, 7.5, 0.075]);
  assert.equal(priceChange("gemini-4-hydrogen"), undefined);
  assert.deepEqual(p("gpt-5.5-cyber-preview"), [12.5, 75, 1.25]);
  assert.deepEqual(p("gpt-5-search-api"), [1.25, 10, 0.125]);
  assert.deepEqual(p("gpt-6-cyber"), [20, 100, 2]);
  assert.deepEqual(unpriced([...openaiPageIds(OPENAI_PAGE), ...googlePageIds(GOOGLE_PAGE)]), []);
  // What the guard says for a model that arrives before its row: named, not passed.
  assert.deepEqual(unpriced(["gemini-4-neon", "gpt-6.2-sol", "gemini-4-argon"]), ["gemini-4-neon", "gpt-6.2-sol"]);
});

test("dated rows: read from pricing.ts's source, each agreeing with the built table; a dated row with no name the check can read is an error", () => {
  const rows = datedRows(readFileSync(join(repoRoot, "src", "pricing.ts"), "utf8"));
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(byId["gpt-5.6-sol"], { id: "gpt-5.6-sol", changes: "2026-12-01", successor: false });
  assert.deepEqual(byId["gemini-4-argon"], { id: "gemini-4-argon", changes: "2026-12-01", successor: true });
  assert.deepEqual(byId["gemini-4-carbon"], { id: "gemini-4-carbon", changes: "2026-12-01", successor: true });
  // gemini-2.5-pro is routed to 3.8 Flash and billed at its price from that day.
  assert.equal(byId["gemini-2.5-pro"].successor, true);
  for (const r of rows) assert.equal(priceChange(r.id)?.on, r.changes, r.id);
  assert.throws(() => datedRows(`  [/gpt-7/i, rate(1, 2, 0.1), { changes: "2027-01-01" }],`), /no model name/);
  // A comment that quotes a row is not a row.
  assert.deepEqual(datedRows(`  // e.g. [openai("x"), rate(1, 2, 0.1), { changes: "2027-01-01" }]`), []);
});

test("due rows: a price whose last day is within 14 days, or past, with no successor; gpt-5.6-sol from 2026-11-16", () => {
  const rows = datedRows(readFileSync(join(repoRoot, "src", "pricing.ts"), "utf8"));
  assert.deepEqual(dueRows(rows, "2026-11-15"), []);
  assert.deepEqual(dueRows(rows, "2026-11-16").map((r) => [r.id, r.daysLeft]), [["gpt-5.6-sol", 14], ["gpt-5.6", 14]]);
  assert.deepEqual(dueRows(rows, "2026-11-30").map((r) => r.daysLeft), [0, 0]);
  assert.deepEqual(dueRows(rows, "2026-12-05").map((r) => r.daysLeft), [-5, -5]);
  // A successor price clears it, whatever the day.
  assert.deepEqual(dueRows([{ id: "x", changes: "2026-12-01", successor: true }], "2026-12-05"), []);
});

test("scripts/check-models.mjs: the pages, the catalogs and --dated; exit 1 naming what is missing, a page down or unreadable a warning", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-guard-"));
  try {
    const run = (...args: string[]) => spawnSync(process.execPath, [join(repoRoot, "scripts", "check-models.mjs"), ...args], { encoding: "utf8" });
    const openai = join(dir, "openai.md");
    const google = join(dir, "google.md");
    const codex = join(dir, "models.json");
    writeFileSync(openai, OPENAI_PAGE);
    writeFileSync(google, GOOGLE_PAGE);
    writeFileSync(codex, JSON.stringify({ models: [{ slug: "gpt-6.1-sol", visibility: "list" }, { slug: "gpt-daybreak-red-latest", visibility: "hide" }] }));
    const ok = run("--openai", openai, "--google", google, "--codex", codex, "--dated", "--today", "2026-11-14");
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /all 7 OpenAI models priced/);
    assert.match(ok.stdout, /all 3 Gemini models priced/);
    assert.match(ok.stdout, /all 1 Codex models priced \(gpt-6\.1-sol\)\n {2}\(not in its picker, not checked: gpt-daybreak-red-latest\)/);
    assert.match(ok.stdout, /✓ \d+ dated rows: every one ending within 14 days of 2026-11-14 has its successor price \(next without one: gpt-5\.6\S*, changes 2026-12-01\)/);

    // A model the table does not know yet, and the promotion's end two weeks out.
    writeFileSync(google, `${GOOGLE_PAGE}\n  *[\`gemini-4-neon\`](/docs/models/gemini-4-neon)*\n`);
    const bad = run("--google", google, "--dated", "--today", "2026-11-16");
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /1 of 4 Gemini models have no price of their own in src\/pricing\.ts: gemini-4-neon/);
    assert.match(bad.stdout, /✗ gpt-5\.6-sol: its price ends on 2026-11-30, in 14 days, and src\/pricing\.ts has no price for after it/);
    assert.equal(run("--dated", "--today", "2026-12-02").status, 1);
    assert.match(run("--dated", "--today", "2026-12-02").stdout, /gpt-5\.6-sol: its price ended on 2026-11-30/);

    // A page whose layout changed (no model found) or a catalog that is not JSON: a warning, not a pass of nothing.
    writeFileSync(openai, "# Pricing\n\nNothing tabular here.\n");
    writeFileSync(codex, "not json");
    const odd = run("--openai", openai, "--codex", codex);
    assert.equal(odd.status, 0, odd.stdout + odd.stderr);
    assert.match(odd.stdout, /::warning title=check-models::.*openai\.md names no OpenAI model this check can read/);
    assert.match(odd.stdout, /::warning title=check-models::.*models\.json could not be parsed/);
    const down = run("--openai", "http://127.0.0.1:1/pricing.md");
    assert.equal(down.status, 0, down.stdout + down.stderr);
    assert.match(down.stdout, /::warning title=check-models::http:\/\/127\.0\.0\.1:1\/pricing\.md could not be fetched/);
    assert.equal(run("--google").status, 2);
    assert.equal(run().status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
