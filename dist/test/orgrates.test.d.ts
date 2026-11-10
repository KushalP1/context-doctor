/**
 * An organization's contracted rates: Claude Code's managed `modelPricing`
 * (multiplier in (0, 10], rows of input / output / cacheRead / cacheWrite
 * charged as written; settings reference and the 2.1.321 binary, read
 * 2026-11-10). Where a managed settings file sets it, every report prices a
 * Claude request at those rates and says so: a fixture session with a Fable
 * 5.2 request, a fast-mode one and a subagent, priced alike by `spend`, the
 * budget, the session price, `subagents` and its payback, at list prices,
 * under a multiplier and under a row.
 */
export {};
