import { rateCard } from "./pricing.js";
const same = (a, b) => Math.abs(a - b) <= 1e-9 + 1e-6 * Math.max(a, b);
const money = (n) => "$" + String(Number(n.toFixed(4)));
/** One line per model whose price differs from the page's, in plain words; empty when all agree. */
export function pagePriceMismatches(prices, at = Date.now()) {
    const out = [];
    for (const p of prices) {
        const card = rateCard(p.model, undefined, at);
        // No price at all is the id check's job; an organization's contracted row is theirs, not the page's.
        if (!card || card.org)
            continue;
        const diffs = [];
        const tier = (label, page, ours) => {
            if (!same(page.input, ours.inputPerM))
                diffs.push(`${label} input ${money(page.input)} on the page, ${money(ours.inputPerM)} here`);
            if (!same(page.output, ours.outputPerM))
                diffs.push(`${label} output ${money(page.output)} on the page, ${money(ours.outputPerM)} here`);
            if (page.cached !== undefined && !same(page.cached, ours.cacheReadPerM))
                diffs.push(`${label} cached input ${money(page.cached)} on the page, ${money(ours.cacheReadPerM)} here`);
        };
        tier("short-context", p.short, card.rates);
        if (p.long && !card.longRates)
            diffs.push(`the page has a long-context price (${money(p.long.input)} / ${money(p.long.output)}) and src/pricing.ts has no long tier`);
        else if (!p.long && card.longRates)
            diffs.push("src/pricing.ts has a long tier the page does not list");
        else if (p.long && card.longRates)
            tier("long-context", p.long, card.longRates);
        if (diffs.length)
            out.push(`${p.model}: ${diffs.join("; ")}`);
    }
    return out;
}
