/**
 * Lifetime proxy savings, as `report` and the dashboard total them.
 *
 * A running proxy writes the delta of its running total to the ledger every
 * 60 s, while /stats keeps returning the whole total since it started. Both
 * views must count each token once: the report used to add the two (one
 * request saving 22,320 tokens read "~45k" a minute later), and the dashboard
 * ignored the ledger (a stopped proxy's savings read 0).
 */
export {};
