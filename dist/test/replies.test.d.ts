/**
 * Counting API replies, not transcript rows. Claude Code writes one reply as
 * several rows carrying the same usage, writes "<synthetic>" placeholder
 * rows that are not requests, and a forked session starts as a verbatim copy
 * of its parent's transcript in a new file. Each reply must be counted and
 * priced once, at its own model's price.
 */
export {};
