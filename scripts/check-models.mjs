#!/usr/bin/env node
// Fails when a Claude model that a source names has no price of its own in
// pricing.ts (it would be priced by its family's row: an estimate). Read-only.
//   node scripts/check-models.mjs --binary <claude binary>   the model catalog of an installed Claude Code
//   node scripts/check-models.mjs --url <url> [--url <url>]  Claude Code's CHANGELOG, the price page
//   node scripts/check-models.mjs --file <path>
// Needs a build (dist/). Exit 0: every model priced; 1: some are not; 2: a local file could not be read
// or the arguments are wrong. A --url that cannot be fetched (the page down, a network error) is a
// warning (a GitHub Actions annotation) and is left out: the check fails only on a model it read.
import { readFileSync, realpathSync } from "node:fs";
import { claudeModelIds, unpricedClaudeIds } from "../dist/modelids.js";

const args = process.argv.slice(2);
const sources = [];
for (let i = 0; i < args.length; i += 2) {
  const [flag, value] = [args[i], args[i + 1]];
  if (!["--binary", "--url", "--file"].includes(flag) || !value) {
    console.error(`usage: check-models.mjs (--binary <path> | --url <url> | --file <path>)...  (got ${flag ?? "nothing"})`);
    process.exit(2);
  }
  sources.push({ flag, value });
}
if (!sources.length) {
  console.error("usage: check-models.mjs (--binary <path> | --url <url> | --file <path>)...");
  process.exit(2);
}

let failed = false;
for (const { flag, value } of sources) {
  let text;
  try {
    if (flag === "--url") {
      const res = await fetch(value, { headers: { "user-agent": "context-doctor-model-check" }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } else {
      // A binary holds its strings as bytes: latin1 keeps every byte one character.
      text = readFileSync(realpathSync(value)).toString(flag === "--binary" ? "latin1" : "utf8");
    }
  } catch (e) {
    if (flag === "--url") {
      // Not this repository's fault, and not an unpriced model: say so where CI shows it, and go on.
      console.log(`::warning title=check-models::${value} could not be fetched (${e.message}); its models were not checked`);
      console.error(`⚠ ${value}: could not fetch it (${e.message}); not checked`);
      continue;
    }
    console.error(`✗ ${value}: could not read it (${e.message})`);
    process.exit(2);
  }
  const ids = claudeModelIds(text);
  const unpriced = unpricedClaudeIds(text);
  if (unpriced.length) {
    failed = true;
    console.log(`✗ ${value}: ${unpriced.length} of ${ids.length} Claude models have no price of their own in src/pricing.ts: ${unpriced.join(", ")}`);
  } else {
    console.log(`✓ ${value}: all ${ids.length} Claude models priced (${ids.join(", ")})`);
  }
}
process.exit(failed ? 1 : 0);
