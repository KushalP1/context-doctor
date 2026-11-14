/**
 * The models a source names, to check each has a price of its own. Claude's
 * below; OpenAI's and Google's price pages, Codex's model catalog and Gemini
 * CLI's model list after them (openaiPageIds...), and the table's own dated
 * rows (datedRows, dueRows). All read by scripts/check-models.mjs.
 *
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
const family = (word, major) => {
    const f = word.toLowerCase();
    if (new RegExp(`^(?:${FAMILY})$`).test(f))
        return Number(major) >= 4;
    return !NOT_A_FAMILY.has(f) && Number(major) >= 1;
};
/** Ids that have no price on purpose, with the reason. */
export const UNPRICED_ON_PURPOSE = {
    "claude-mythos-preview": "no list price on the page; priced by the Fable/Mythos family row as an estimate",
    // Gemini CLI names these (packages/core/src/config/models.ts, read
    // 2026-11-14); Google's price page does not, so there is no price to copy.
    "gemini-3-pro-preview": "Gemini CLI's preview model, not on Google's price page (2026-11-14); the 3.x Pro fallback prices it at 3.1 Pro's rates, an estimate",
    "gemini-3.5-flash": "Gemini CLI's base Flash, not on Google's price page (2026-11-14; Gemini CLI rewrites it to gemini-3.8-flash once that is GA); the 3.x Flash fallback prices it at 3.8 Flash's rates, an estimate",
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
    for (const m of text.matchAll(/(?<![\w.-])claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?(?![\w-])/g)) {
        if (!family(m[1], m[2]))
            continue;
        out.add(`claude-${m[1]}-${m[2]}${m[3] && m[3] !== "0" ? `-${m[3]}` : ""}`);
    }
    for (const m of text.matchAll(/\bClaude ([A-Z][a-z]+) (\d{1,2})(?:\.(\d{1,2}))?(?![\w.]*\d)/g)) {
        if (!family(m[1], m[2]))
            continue;
        out.add(`claude-${m[1].toLowerCase()}-${m[2]}${m[3] && m[3] !== "0" ? `-${m[3]}` : ""}`);
    }
    return [...out].sort();
}
/** The Claude models `text` names that have no price of their own and no reason to lack one. */
export function unpricedClaudeIds(text) {
    return unpriced(claudeModelIds(text));
}
/** The ids in `ids` that have no price of their own and no reason to lack one. */
export function unpriced(ids) {
    return ids.filter((id) => !hasKnownPrice(id) && !(id in UNPRICED_ON_PURPOSE));
}
/**
 * Models priced per image, per minute or per character, or not by the token
 * at all (embeddings, moderation), and Google's endpoints that are not
 * models a coding agent runs (video, music, robots, the Decisions API, Gemma
 * on the free tier only): the table has no row for them on purpose
 * (pricing.ts header). Matched anywhere in the id.
 */
const NOT_A_TEXT_MODEL = /image|realtime|audio|tts|transcribe|whisper|translate|(?:^|-)live(?:-|$)|embedding|moderation|omni|robotics|decision|lyria|veo|imagen|gemma|nano-banana|sora/i;
/**
 * The models OpenAI's price page (developers.openai.com/api/docs/pricing,
 * its .md) lists in its text tables: each table row's model cell (the first,
 * or the second where the first is a category), the context-length notes
 * dropped. Tables with a Modality or Use case column (images, audio,
 * transcription) and the tools table are not models priced by the token.
 */
export function openaiPageIds(markdown) {
    const out = new Set();
    let header;
    for (const line of markdown.split("\n")) {
        if (!line.startsWith("|")) {
            header = undefined;
            continue;
        }
        const cells = line.split("|").slice(1, -1).map((c) => c.trim());
        if (!header) {
            header = cells.map((c) => c.toLowerCase());
            continue;
        }
        if (cells.every((c) => /^-+$/.test(c)))
            continue;
        if (header.includes("modality") || header.includes("use case") || header[0] === "tool")
            continue;
        const at = header.indexOf("model");
        if (at === -1)
            continue;
        const name = cells[at]?.replace(/\s*\(.*\)\s*$/, "").replace(/<[^>]*>/g, "").trim();
        if (name && /^[a-z][a-z0-9.-]*$/.test(name) && !NOT_A_TEXT_MODEL.test(name))
            out.add(name);
    }
    return [...out].sort();
}
/**
 * The models Google's price page (ai.google.dev/gemini-api/docs/pricing, its
 * .md.txt) prices: each section's model id line (`*[\`gemini-4-argon\`](...)*`),
 * the text models only.
 */
export function googlePageIds(markdown) {
    const out = new Set();
    for (const m of markdown.matchAll(/^\s*\*\[`([a-z][a-z0-9.-]*)`\]/gm))
        if (!NOT_A_TEXT_MODEL.test(m[1]))
            out.add(m[1]);
    return [...out].sort();
}
/**
 * The models Codex offers (its models catalog, codex-rs/models-manager/
 * models.json): `listed` are the ones its picker shows, `hidden` the rest
 * (internal and trusted-access ids, which the price page may not name).
 */
export function codexModelIds(json) {
    const models = JSON.parse(json).models ?? [];
    const listed = new Set();
    const hidden = new Set();
    for (const m of models)
        if (typeof m.slug === "string")
            (m.visibility === "list" ? listed : hidden).add(m.slug);
    return { listed: [...listed].sort(), hidden: [...hidden].sort() };
}
/**
 * The Gemini models Gemini CLI names (packages/core/src/config/models.ts):
 * every quoted full model id (a version and a Pro/Flash/Flash-Lite name),
 * not family prefixes like 'gemini-3' or the embedding model.
 */
export function geminiCliIds(source) {
    const out = new Set();
    for (const m of source.matchAll(/['"`](gemini-\d[\d.]*-(?:pro|flash)[a-z0-9.-]*)['"`]/g))
        if (!NOT_A_TEXT_MODEL.test(m[1]))
            out.add(m[1]);
    return [...out].sort();
}
/** One way of naming a pricing.ts row, as a model id the row prices. */
function rowId(line) {
    const named = /\[(?:openai|gemini)\("([^"]+)"\)/.exec(line);
    if (named)
        return named[1];
    const c = /\[claude\("([a-z]+)[^"]*",\s*(\d+)(?:,\s*(\d+))?\)/.exec(line);
    return c ? `claude-${c[1]}-${c[2]}${c[3] ? `-${c[3]}` : ""}` : undefined;
}
/**
 * The rows of pricing.ts's table (its source, `src/pricing.ts`) whose price
 * ends on a known day (`changes`), each with whether the page said what
 * follows (`then`, or `routes`: billed as another model from that day).
 * Throws on a dated row it cannot name, so the check cannot pass by missing one.
 */
export function datedRows(pricingSource) {
    const out = [];
    for (const line of pricingSource.split("\n")) {
        const day = /\bchanges:\s*"(\d{4}-\d{2}-\d{2})"/.exec(line);
        if (!day || /^\s*(?:\/\/|\*)/.test(line))
            continue;
        const id = rowId(line);
        if (!id)
            throw new Error(`a dated row with no model name this check can read: ${line.trim()}`);
        out.push({ id, changes: day[1], successor: /\bthen:|\broutes:/.test(line) });
    }
    return out;
}
/**
 * The dated rows with no successor price whose last day at that price (the
 * day before `changes`) is at most `days` days after `today`, or already
 * past: from then, every install prices that model as an estimate, so the
 * page needs reading again (and the successor price adding, once published).
 */
export function dueRows(rows, today, days = 14) {
    const t = Date.parse(`${today}T00:00:00Z`);
    return rows
        .filter((r) => !r.successor)
        .map((r) => ({ ...r, daysLeft: Math.round((Date.parse(`${r.changes}T00:00:00Z`) - 864e5 - t) / 864e5) }))
        .filter((r) => r.daysLeft <= days);
}
