/**
 * The ledger is capped, and everything it feeds is a LIFETIME total.
 *
 * Rotation used to drop old lines outright, so the moment a heavy user crossed
 * the cap their reported savings fell off a cliff and kept falling: measured at
 * 1,692,000 tokens saved becoming 501,000. A number that goes backwards is
 * worse than no number, so rotation folds what it drops into a rollup.
 */
export {};
