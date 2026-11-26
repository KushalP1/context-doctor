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
/** One model's per-1M rates as OpenAI's price page states them: short context, and the long tier where it has one. */
export interface PagePrice {
    model: string;
    short: {
        input: number;
        output: number;
        cached?: number;
    };
    long?: {
        input: number;
        output: number;
        cached?: number;
    };
}
/**
 * The prices in OpenAI's price page's Standard tables (not Batch, Flex, Fast
 * or Ultrafast): the main table's "Short context …" and "Long context …"
 * columns, and the specialized tables' "(short context)" / "(long context)"
 * row pairs. A "-" cell is no price (no cached rate, or no long tier). So
 * the weekly check can compare what we charge with what the page says, not
 * only that a model has some price.
 */
export declare function openaiPagePrices(markdown: string): PagePrice[];
/**
 * The prices in Anthropic's price page's model table (platform.claude.com
 * pricing.md, "Model | Base input tokens | … | Cache hits and refreshes |
 * Output tokens"): each "Claude Opus 5.5" row as `claude-opus-5-5`, notes in
 * parentheses and footnote marks dropped. A model priced in two rows by
 * prompt size (Haiku 5.5's "for prompts over 100,000 tokens") gets the
 * second as its long tier. Cache writes are not read: they are 1.25x and 2x
 * input by rule, which pricing.ts applies.
 */
export declare function anthropicPagePrices(markdown: string): PagePrice[];
/**
 * The prices in Google's price page (ai.google.dev/gemini-api/docs/pricing,
 * its .md.txt): in each model's section, the Standard tab's paid-tier cells
 * for input, output and context caching. A cell's first price is today's
 * (a later "$4.00 starting December 1" line is the dated row's `then`, which
 * the dated check covers); "prompts <= 200k" / "prompts > 200k" lines split
 * a short and a long tier; per-hour storage lines and audio rates after a
 * text rate are not read. A section whose cells do not read this way is
 * left out rather than guessed.
 */
export declare function googlePagePrices(markdown: string): PagePrice[];
/**
 * The models Google's price page (ai.google.dev/gemini-api/docs/pricing, its
 * .md.txt) prices: each section's model id line (`*[\`gemini-4-argon\`](...)*`),
 * the text models only.
 */
export declare function googlePageIds(markdown: string): string[];
/**
 * The models Claude Code's signed model catalog offers
 * (downloads.claude.ai/model-catalog/v1/catalog.json, read from 2.1.331 on;
 * `modelCatalogUrl` can point elsewhere): every
 * `surfaces.<surface>.model_selector_config[].models[].id`, across the
 * terminal (`cc`), the Desktop app's Code tab (`ccd`) and the rest. It
 * changes between Claude Code releases (version 5883 was issued 2026-11-24
 * and expires a week later), so a model can reach the picker before any
 * binary or CHANGELOG names it. `about` says which catalog was read.
 * Throws on a catalog in another shape.
 */
export declare function catalogModelIds(json: string): {
    ids: string[];
    about: string;
};
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
