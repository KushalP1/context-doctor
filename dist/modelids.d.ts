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
/** Ids that have no price on purpose, with the reason. */
export declare const UNPRICED_ON_PURPOSE: Record<string, string>;
/** Every Claude model id `text` names, each once, sorted. */
export declare function claudeModelIds(text: string): string[];
/** The Claude models `text` names that have no price of their own and no reason to lack one. */
export declare function unpricedClaudeIds(text: string): string[];
/** The ids in `ids` that have no price of their own and no reason to lack one. */
export declare function unpriced(ids: string[]): string[];
/**
 * The models OpenAI's price page (developers.openai.com/api/docs/pricing,
 * its .md) lists in its text tables: each table row's model cell (the first,
 * or the second where the first is a category), the context-length notes
 * dropped. Tables with a Modality or Use case column (images, audio,
 * transcription) and the tools table are not models priced by the token.
 */
export declare function openaiPageIds(markdown: string): string[];
/**
 * The models Google's price page (ai.google.dev/gemini-api/docs/pricing, its
 * .md.txt) prices: each section's model id line (`*[\`gemini-4-argon\`](...)*`),
 * the text models only.
 */
export declare function googlePageIds(markdown: string): string[];
/**
 * The models Codex offers (its models catalog, codex-rs/models-manager/
 * models.json): `listed` are the ones its picker shows, `hidden` the rest
 * (internal and trusted-access ids, which the price page may not name).
 */
export declare function codexModelIds(json: string): {
    listed: string[];
    hidden: string[];
};
/**
 * The Gemini models Gemini CLI names (packages/core/src/config/models.ts):
 * every quoted full model id (a version and a Pro/Flash/Flash-Lite name),
 * not family prefixes like 'gemini-3' or the embedding model.
 */
export declare function geminiCliIds(source: string): string[];
/** A dated pricing.ts row: the model it prices, the day its price changes, and whether the page gave what follows. */
export interface DatedRow {
    id: string;
    changes: string;
    successor: boolean;
}
/**
 * The rows of pricing.ts's table (its source, `src/pricing.ts`) whose price
 * ends on a known day (`changes`), each with whether the page said what
 * follows (`then`, or `routes`: billed as another model from that day).
 * Throws on a dated row it cannot name, so the check cannot pass by missing one.
 */
export declare function datedRows(pricingSource: string): DatedRow[];
/**
 * The dated rows with no successor price whose last day at that price (the
 * day before `changes`) is at most `days` days after `today`, or already
 * past: from then, every install prices that model as an estimate, so the
 * page needs reading again (and the successor price adding, once published).
 */
export declare function dueRows(rows: DatedRow[], today: string, days?: number): Array<DatedRow & {
    daysLeft: number;
}>;
