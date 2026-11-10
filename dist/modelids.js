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
 * them. First-party and display names count from major version 4 (the
 * naming the table keys on): older aliases Claude Code still accepts
 * (`claude-haiku-3-5`, `claude-sonnet-3-7`) are not ids anything bills.
 */
import { hasKnownPrice } from "./pricing.js";
const FAMILY = "opus|sonnet|haiku|fable|mythos";
/** Ids that have no price on purpose, with the reason. */
export const UNPRICED_ON_PURPOSE = {
    "claude-mythos-preview": "no list price on the page; priced by the Fable/Mythos family row as an estimate",
};
/** The model a Bedrock id names, as a first-party id: region prefix, `-v1:0` and the date dropped. */
function fromBedrock(id) {
    return id.replace(/^(?:[a-z]{2,6}\.)?anthropic\./, "").replace(/-v\d+(?::\d+)?$/, "").replace(/-\d{8}$/, "");
}
/** Every Claude model id `text` names, each once, sorted. */
export function claudeModelIds(text) {
    const out = new Set();
    // A model's Bedrock id has a version number (com.anthropic.claude-code, an app id, has none).
    for (const m of text.matchAll(/(?<![\w.-])(?:(?:us|eu|apac|global|au|jp|ca|us-gov)\.)?anthropic\.(claude-[a-z0-9-]*?\d[a-z0-9-]*?)(?:-v\d+(?::\d+)?)?(?![\w.-]*\w)/g))
        out.add(fromBedrock(m[1]));
    for (const m of text.matchAll(new RegExp(`(?<![\\w.-])claude-(${FAMILY})-(\\d{1,2})(?:-(\\d{1,2}))?(?:-\\d{8})?(?![\\w-])`, "g"))) {
        if (Number(m[2]) < 4)
            continue;
        out.add(`claude-${m[1]}-${m[2]}${m[3] && m[3] !== "0" ? `-${m[3]}` : ""}`);
    }
    for (const m of text.matchAll(new RegExp(`\\bClaude (${FAMILY.replace(/\b\w/g, (c) => c.toUpperCase())}) (\\d{1,2})(?:\\.(\\d{1,2}))?(?![\\w.]*\\d)`, "g"))) {
        if (Number(m[2]) < 4)
            continue;
        out.add(`claude-${m[1].toLowerCase()}-${m[2]}${m[3] && m[3] !== "0" ? `-${m[3]}` : ""}`);
    }
    return [...out].sort();
}
/** The Claude models `text` names that have no price of their own and no reason to lack one. */
export function unpricedClaudeIds(text) {
    return claudeModelIds(text).filter((id) => !hasKnownPrice(id) && !(id in UNPRICED_ON_PURPOSE));
}
