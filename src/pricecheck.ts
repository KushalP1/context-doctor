/**
 * Does what we charge match what a provider's price page says? The weekly
 * check (`scripts/check-models.mjs`) asked only whether each model had some
 * price, so a row the page later changed (GPT-6 Rosalind went from $15 to
 * $10 per 1M input) or a long-prompt tier a row left out (GPT-6 Astra for
 * Law) stayed wrong without a red. This compares each of the page's
 * Standard prices with our rate card for the model, as of `at`.
 */
import type { PagePrice } from "./modelids.js";
import { rateCard } from "./pricing.js";

const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 + 1e-6 * Math.max(a, b);
const money = (n: number) => "$" + String(Number(n.toFixed(4)));

type Rates = { inputPerM: number; outputPerM: number; cacheReadPerM: number };

/** One line per model whose price differs from the page's, in plain words; empty when all agree. */
export function pagePriceMismatches(prices: PagePrice[], at = Date.now()): string[] {
  const out: string[] = [];
  for (const p of prices) {
    const card = rateCard(p.model, undefined, at);
    // No price at all is the id check's job; an organization's contracted row is theirs, not the page's.
    if (!card || card.org) continue;
    const diffs: string[] = [];
    const tier = (label: string, page: PagePrice["short"], ours: Rates) => {
      if (!same(page.input, ours.inputPerM)) diffs.push(`${label} input ${money(page.input)} on the page, ${money(ours.inputPerM)} here`);
      if (!same(page.output, ours.outputPerM)) diffs.push(`${label} output ${money(page.output)} on the page, ${money(ours.outputPerM)} here`);
      if (page.cached !== undefined && !same(page.cached, ours.cacheReadPerM)) diffs.push(`${label} cached input ${money(page.cached)} on the page, ${money(ours.cacheReadPerM)} here`);
    };
    tier("short-context", p.short, card.rates);
    if (p.long && !card.longRates) diffs.push(`the page has a long-context price (${money(p.long.input)} / ${money(p.long.output)}) and src/pricing.ts has no long tier`);
    else if (!p.long && card.longRates) diffs.push("src/pricing.ts has a long tier the page does not list");
    else if (p.long && card.longRates) tier("long-context", p.long, card.longRates);
    if (diffs.length) out.push(`${p.model}: ${diffs.join("; ")}`);
  }
  return out;
}
