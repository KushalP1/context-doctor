/**
 * Claude Fable 5.2 and Mythos 5.2 against the price page as read on
 * 2026-11-10 (platform.claude.com/docs/en/about-claude/pricing.md):
 * "Model pricing" $8 input, $10 5-minute writes, $16 1-hour writes, $0.20
 * cache hits (0.025x), $40 output; "Fast mode pricing" $16 / $80, caching
 * multipliers and data residency on top; "Data residency pricing" 1.1x for
 * Claude 4.6 and later. Before these rows `claude-fable-5-2` fell to the
 * Fable/Mythos family fallback ($10 / $50, reads $1): reads five times too
 * high, and labelled an estimate.
 */
export {};
