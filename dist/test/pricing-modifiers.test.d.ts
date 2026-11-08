/**
 * What a request recorded that bills it above its row (requestCost), each
 * against the provider's page as read on 2026-11-08:
 *
 *  - Anthropic, platform.claude.com/docs/en/about-claude/pricing.md: "Fast
 *    mode pricing" (Opus 5.5 $8 / $40, Opus 5 and 4.8 $10 / $50, caching
 *    multipliers on top), "Data residency pricing" (1.1x on every category
 *    for Claude 4.6 and later, Haiku 5.5's long-prompt prices included),
 *    "Long context pricing" (Haiku 5.5 over 100,000 prompt tokens, cache
 *    reads and writes counted: $0.50 / $2.50 / $0.05), "Web search tool"
 *    ($10 per 1,000 searches; web fetch free).
 *  - OpenAI, developers.openai.com/api/docs/pricing: "Long context: >272K
 *    input tokens", 2x input and cached input, 1.5x output.
 *  - Google, ai.google.dev/gemini-api/docs/pricing: 3.1 Pro and 2.5 Pro over
 *    200k prompt tokens.
 * And the rows whose price ends on a day (P2), with a clock on either side.
 */
export {};
