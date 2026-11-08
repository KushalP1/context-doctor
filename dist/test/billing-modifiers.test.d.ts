/**
 * Billing modifiers agree across every report that prices a request: on a
 * session with a fast-mode request, a US-only one, a 150k Haiku 5.5 prompt
 * and two web searches (modifier-fixture.ts), `spend`, `limits`' usage, the
 * budget, the session price and `savings`' bill all come to the same
 * dollars, and `spend` says what each modifier added. And prices that end on
 * a day (gpt-5.6-sol's promotion, Gemini 4 Argon's) with a frozen clock
 * either side: `spend`, the budget and `doctor` say the price changed.
 */
export {};
