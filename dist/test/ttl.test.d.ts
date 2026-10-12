/**
 * Cache writes priced by TTL: 1.25x input at 5 minutes, 2x at 1 hour, as the
 * usage records them. Simulated writes (a cold re-read, a fresh context)
 * use the session's own mix. Claude Haiku 4.5 throughout: its price did not
 * change, so these isolate the TTL.
 */
export {};
