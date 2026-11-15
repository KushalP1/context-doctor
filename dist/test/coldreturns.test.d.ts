/**
 * Cold returns replayed three ways (coldreturns.ts): as billed, compacted on
 * return, kept warm by a cache read every 55 minutes (4.5 on a 5-minute
 * cache); the keep-warm caps priced with every ping a timer would send; and
 * #107157's re-added compacted segment. Prices: Opus 5.5 $4 in, $0.20 cache
 * read, $20 out; Sonnet 5 $2, $0.20, $10; 1-hour writes at 2x input.
 */
export {};
