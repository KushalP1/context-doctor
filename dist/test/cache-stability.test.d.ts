/**
 * Optimization must not destroy the prompt cache it is trying to save money on.
 *
 * Caches match a byte-identical prefix, so editing any message in the middle
 * invalidates everything after it. A trim boundary of `length - keepRecent`
 * moves by one every turn, rewriting the message that just aged out — which
 * costs the 1.25x cache-write price on the whole prefix, every turn, to save a
 * few hundred tokens. On this fixture that was 22 of 24 turns.
 */
export {};
