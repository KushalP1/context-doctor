#!/usr/bin/env node
// Fails when a model that a source names has no price of its own in
// pricing.ts (it would be priced by its family's row, an estimate, or not at
// all), or when a row's price ends within 14 days and the table does not
// know what follows. Read-only.
//   Claude:  --binary <claude binary>   the model catalog of an installed Claude Code
//            --url <url> / --file <path> Claude Code's CHANGELOG, Anthropic's price page
//   OpenAI:  --openai <url|path>         the price page (developers.openai.com/api/docs/pricing.md)
//            --codex <url|path>          Codex's model catalog (codex-rs/models-manager/models.json):
//                                        the models its picker lists; hidden ones are named, not failed
//   Google:  --google <url|path>         the price page (ai.google.dev/gemini-api/docs/pricing.md.txt)
//            --gemini-cli <url|path>     Gemini CLI's model list (packages/core/src/config/models.ts)
//   Dates:   --dated [--today YYYY-MM-DD] rows whose price ends within 14 days (or has ended) with no
//                                        successor price in the table
// Needs a build (dist/). Exit 0: every model priced and no row due; 1: some are not; 2: a local file
// could not be read or the arguments are wrong. A URL that cannot be fetched (the page down, a network
// error) is a warning (a GitHub Actions annotation) and is left out: the check fails only on what it read.
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeModelIds, codexModelIds, datedRows, dueRows, geminiCliIds, googlePageIds, openaiPageIds, unpriced, UNPRICED_ON_PURPOSE } from "../dist/modelids.js";
import { priceChange } from "../dist/pricing.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "usage: check-models.mjs [--binary <path> | --url <url> | --file <path> | --openai <url|path> | --codex <url|path> | --google <url|path> | --gemini-cli <url|path>]... [--dated [--today YYYY-MM-DD]]";

/** What each source flag reads, and the models it names. */
const READERS = {
  "--binary": { label: "Claude", ids: claudeModelIds },
  "--url": { label: "Claude", ids: claudeModelIds },
  "--file": { label: "Claude", ids: claudeModelIds },
  "--openai": { label: "OpenAI", ids: openaiPageIds },
  "--google": { label: "Gemini", ids: googlePageIds },
  "--gemini-cli": { label: "Gemini", ids: geminiCliIds },
  "--codex": { label: "Codex", ids: (t) => codexModelIds(t).listed, hidden: (t) => codexModelIds(t).hidden },
};

const args = process.argv.slice(2);
const sources = [];
let dated = false;
let today = new Date().toISOString().slice(0, 10);
for (let i = 0; i < args.length; i++) {
  const [flag, value] = [args[i], args[i + 1]];
  if (flag === "--dated") { dated = true; continue; }
  if (flag === "--today" && /^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) { today = value; i++; continue; }
  if (!(flag in READERS) || !value) {
    console.error(`${USAGE}  (got ${flag ?? "nothing"})`);
    process.exit(2);
  }
  sources.push({ flag, value });
  i++;
}
if (!sources.length && !dated) {
  console.error(USAGE);
  process.exit(2);
}

let failed = false;
for (const { flag, value } of sources) {
  const reader = READERS[flag];
  const remote = /^https?:\/\//.test(value);
  let text;
  try {
    if (remote) {
      const res = await fetch(value, { headers: { "user-agent": "context-doctor-model-check" }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } else {
      // A binary holds its strings as bytes: latin1 keeps every byte one character.
      text = readFileSync(realpathSync(value)).toString(flag === "--binary" ? "latin1" : "utf8");
    }
  } catch (e) {
    if (remote) {
      // Not this repository's fault, and not an unpriced model: say so where CI shows it, and go on.
      console.log(`::warning title=check-models::${value} could not be fetched (${e.message}); its models were not checked`);
      console.error(`⚠ ${value}: could not fetch it (${e.message}); not checked`);
      continue;
    }
    console.error(`✗ ${value}: could not read it (${e.message})`);
    process.exit(2);
  }
  let ids;
  let hidden = [];
  try {
    ids = reader.ids(text);
    hidden = reader.hidden?.(text) ?? [];
  } catch (e) {
    // A page or catalog in a shape this check does not know: a warning, as for a page that is down.
    console.log(`::warning title=check-models::${value} could not be parsed (${e.message}); its models were not checked`);
    continue;
  }
  if (!ids.length) {
    // A price page with no model on it is a page whose layout changed, not a page with every model priced.
    console.log(`::warning title=check-models::${value} names no ${reader.label} model this check can read; the page's layout may have changed`);
    console.error(`⚠ ${value}: no ${reader.label} models found in it; not checked`);
    continue;
  }
  const missing = unpriced(ids);
  if (missing.length) {
    failed = true;
    console.log(`✗ ${value}: ${missing.length} of ${ids.length} ${reader.label} models have no price of their own in src/pricing.ts: ${missing.join(", ")}`);
  } else {
    const estimates = ids.filter((id) => id in UNPRICED_ON_PURPOSE);
    console.log(`✓ ${value}: all ${ids.length} ${reader.label} models priced (${ids.join(", ")})${estimates.length ? `; by a family row on purpose, no price of their own on the page: ${estimates.join(", ")}` : ""}`);
  }
  const hiddenMissing = unpriced(hidden);
  if (hiddenMissing.length) console.log(`  (not in its picker, not checked: ${hiddenMissing.join(", ")})`);
}

if (dated) {
  let rows;
  try {
    rows = datedRows(readFileSync(join(repo, "src", "pricing.ts"), "utf8"));
  } catch (e) {
    console.error(`✗ src/pricing.ts: ${e.message}`);
    process.exit(2);
  }
  // The source names each dated row; the build must agree that it is dated, on that day.
  for (const r of rows) {
    const built = priceChange(r.id);
    if (built?.on !== r.changes) {
      console.error(`✗ src/pricing.ts: ${r.id}'s row changes on ${r.changes}, but the build prices ${r.id} ${built ? `with a change on ${built.on}` : "with no change"}: rebuild, or the row is shadowed by an earlier one`);
      process.exit(2);
    }
  }
  const due = dueRows(rows, today);
  if (due.length) {
    failed = true;
    for (const r of due) {
      const last = new Date(Date.parse(`${r.changes}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);
      const when = r.daysLeft < 0 ? `ended on ${last}` : r.daysLeft === 0 ? `ends today (${last})` : `ends on ${last}, in ${r.daysLeft} day${r.daysLeft === 1 ? "" : "s"},`;
      console.log(`✗ ${r.id}: its price ${when} and src/pricing.ts has no price for after it; re-read the provider's page and add \`then\` (or \`routes\`) once it says`);
    }
  } else {
    const next = rows.filter((r) => !r.successor).sort((a, b) => a.changes.localeCompare(b.changes))[0];
    console.log(`✓ ${rows.length} dated rows: every one ending within 14 days of ${today} has its successor price${next ? ` (next without one: ${next.id}, changes ${next.changes})` : ""}`);
  }
}
process.exit(failed ? 1 : 0);
