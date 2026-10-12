/**
 * `context-doctor cache-plan <request.json>`: where an API app should put
 * Anthropic `cache_control` breakpoints, and what that saves.
 *
 * A request is cached as a prefix in a fixed order: tools, then system, then
 * messages. A breakpoint caches everything up to and including the block it
 * sits on, a prefix under the model's minimum (1,024 tokens; 2,048 on Haiku)
 * is not cached at all, a request may carry at most 4 breakpoints, and the
 * cache looks back at most 20 blocks from a breakpoint for an earlier hit.
 * The planner places breakpoints at the ends of the stable parts (last tool,
 * last system block) and on the last block of the conversation, adds a
 * middle anchor when the conversation is longer than the 20-block lookback,
 * prices the request sent N times with and without the plan, and with
 * --out saves the request with the breakpoints in place.
 *
 * Pricing assumes the same request is sent N times (an agent loop's steps, a
 * shared system prompt and document set); cache writes cost 1.25x input
 * (2x with ttl "1h"), reads 0.1x.
 */
export interface Breakpoint {
    /** Where: "tools[3]", "system[1]", "messages[12].content[0]". */
    at: string;
    /** Prefix tokens cached up to and including this point. */
    prefixTokens: number;
    why: string;
}
export interface CachePlan {
    provider: "anthropic" | "openai" | "unknown";
    model?: string;
    totalTokens: number;
    minCacheable: number;
    existing: string[];
    plan: Breakpoint[];
    /** Tokens before the last breakpoint of the plan: what later calls read from cache. */
    cachedTokens: number;
    calls: number;
    usdWithout?: number;
    usdWith?: number;
    notes: string[];
}
export declare function planCache(request: unknown, calls?: number, modelOverride?: string): {
    plan: CachePlan;
    apply: () => Record<string, any>;
};
export declare function renderCachePlan(p: CachePlan): string;
