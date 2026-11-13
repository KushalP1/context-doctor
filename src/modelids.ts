/**
 * The Claude models a text names, to check each has a price of its own
 * (pricing.ts hasKnownPrice) before a user runs it: Claude Code ships a
 * model days before a context-doctor release (2.1.322 made Fable 5.2 the
 * default the day its price changed), and an id the table does not know is
 * priced by its family's row, an estimate that was five times too high on
 * Fable 5.2's cache reads. Read from Claude Code's binary (its model
 * catalog), its CHANGELOG and the price page by scripts/check-models.mjs.
 *
 * Three spellings: Bedrock ids (`anthropic.claude-opus-5-5`,
 * `us.anthropic.claude-sonnet-4-5-20250929-v1:0`), the catalog's cleanest
 * list; first-party ids of the current naming (`claude-fable-5-2`); and
 * display names (`Claude Fable 5.2`), which is how the price page names
 * them. First-party and display names of the known families count from
 * major version 4 (the naming the table keys on): older aliases Claude Code
 * still accepts (`claude-haiku-3-5`, `claude-sonnet-3-7`) are not ids
 * anything bills. A family the table does not know counts from version 1.
 */

import { hasKnownPrice } from "./pricing.js";

/** The families the table keys on: their ids and names count from major version 4. */
const FAMILY = "opus|sonnet|haiku|fable|mythos";
/**
 * Words that follow "claude-" or "Claude " with a number and are not a model
 * family: products, plans, apps, test ids (`claude-eval-9` is in the 2.1.321
 * binary). Any other word with a version is a model, a family new to the
 * table included: Fable and Mythos were new families once, and an id of a
 * family the table does not know has no price at all, not even a family's.
 */
const NOT_A_FAMILY = new Set(["code", "eval", "agent", "agents", "desktop", "app", "apps", "api", "cli", "sdk", "tag", "chrome", "max", "pro", "team", "enterprise", "gov", "console", "platform", "models", "cowork", "design", "for", "in", "on", "and", "is", "the"]);
const family = (word: string, major: string): boolean => {
  const f = word.toLowerCase();
  if (new RegExp(`^(?:${FAMILY})$`).test(f)) return Number(major) >= 4;
  return !NOT_A_FAMILY.has(f) && Number(major) >= 1;
};

/** Ids that have no price on purpose, with the reason. */
export const UNPRICED_ON_PURPOSE: Record<string, string> = {
  "claude-mythos-preview": "no list price on the page; priced by the Fable/Mythos family row as an estimate",
};

/** The model a Bedrock id names, as a first-party id: region prefix, `-v1:0` and the date dropped. */
function fromBedrock(id: string): string {
  return id.replace(/^(?:[a-z]{2,6}\.)?anthropic\./, "").replace(/-v\d+(?::\d+)?$/, "").replace(/-\d{8}$/, "");
}

/** Every Claude model id `text` names, each once, sorted. */
export function claudeModelIds(text: string): string[] {
  const out = new Set<string>();
  // A model's Bedrock id has a version number (com.anthropic.claude-code, an app id, has none).
  for (const m of text.matchAll(/(?<![\w.-])(?:(?:us|eu|apac|global|au|jp|ca|us-gov)\.)?anthropic\.(claude-[a-z0-9-]*?\d[a-z0-9-]*?)(?:-v\d+(?::\d+)?)?(?![\w.-]*\w)/g)) out.add(fromBedrock(m[1]));
  for (const m of text.matchAll(/(?<![\w.-])claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?(?![\w-])/g)) {
    if (!family(m[1], m[2])) continue;
    out.add(`claude-${m[1]}-${m[2]}${m[3] && m[3] !== "0" ? `-${m[3]}` : ""}`);
  }
  for (const m of text.matchAll(/\bClaude ([A-Z][a-z]+) (\d{1,2})(?:\.(\d{1,2}))?(?![\w.]*\d)/g)) {
    if (!family(m[1], m[2])) continue;
    out.add(`claude-${m[1].toLowerCase()}-${m[2]}${m[3] && m[3] !== "0" ? `-${m[3]}` : ""}`);
  }
  return [...out].sort();
}

/** The Claude models `text` names that have no price of their own and no reason to lack one. */
export function unpricedClaudeIds(text: string): string[] {
  return claudeModelIds(text).filter((id) => !hasKnownPrice(id) && !(id in UNPRICED_ON_PURPOSE));
}
