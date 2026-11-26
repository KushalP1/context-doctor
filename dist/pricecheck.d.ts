/**
 * Does what we charge match what a provider's price page says? The weekly
 * check (`scripts/check-models.mjs`) asked only whether each model had some
 * price, so a row the page later changed (GPT-6 Rosalind went from $15 to
 * $10 per 1M input) or a long-prompt tier a row left out (GPT-6 Astra for
 * Law) stayed wrong without a red. This compares each of the page's
 * Standard prices with our rate card for the model, as of `at`.
 */
import type { PagePrice } from "./modelids.js";
/** One line per model whose price differs from the page's, in plain words; empty when all agree. */
export declare function pagePriceMismatches(prices: PagePrice[], at?: number): string[];
