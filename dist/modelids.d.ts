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
/** Ids that have no price on purpose, with the reason. */
export declare const UNPRICED_ON_PURPOSE: Record<string, string>;
/** Every Claude model id `text` names, each once, sorted. */
export declare function claudeModelIds(text: string): string[];
/** The Claude models `text` names that have no price of their own and no reason to lack one. */
export declare function unpricedClaudeIds(text: string): string[];
