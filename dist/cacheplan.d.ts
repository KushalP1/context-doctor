/**
 * `context-doctor cache-plan <request.json>`: where an API app should put
 * Anthropic `cache_control` breakpoints, and what that saves.
 *
 * A request is cached as a prefix in a fixed order: tools, then system, then
 * messages. A breakpoint caches everything up to and including the block it
 * sits on, a prefix under the model's minimum (512 to 4,096 tokens, see
 * minCacheableTokens) is not cached at all, a request may carry at most 4
 * breakpoints, and the cache looks back at most 20 positions from a
 * breakpoint for an earlier hit (a run of tool_use blocks, or of
 * tool_result blocks, is one position).
 *
 * Automatic caching (prompt-caching docs, Oct 2026): one top-level
 * `cache_control` puts a breakpoint on the last cacheable block and moves it
 * forward as the conversation grows, so the app never re-places it. It takes
 * one of the 4 slots; with 4 explicit breakpoints as well, or an explicit one
 * on the last block at a different TTL, the API answers 400. Every platform
 * has it except Bedrock's legacy integration (Opus 4.6 and earlier), which
 * rejects the field.
 *
 * The planner places breakpoints at the ends of the stable parts (last tool,
 * last system block) and at the end of the conversation, there by automatic
 * caching unless the platform lacks it or --explicit asks for a block-level
 * one; adds a middle anchor when the conversation is longer than the
 * 20-position lookback; prices the request sent N times with and without the
 * plan; and with --out saves the request with the breakpoints in place.
 *
 * Pricing assumes the same request is sent N times (an agent loop's steps, a
 * shared system prompt and document set); cache writes cost 1.25x input
 * (2x with ttl "1h"), reads the model's own cache-read rate (0.1x; 0.05x on
 * Opus 5.5 and Sonnet 5.5; 0.025x on Fable and Mythos 5.1).
 */
export interface Breakpoint {
    /** Where: "tools[3]", "system[1]", "messages[12].content[0]", or "top level (automatic)". */
    at: string;
    /** The top-level automatic breakpoint: it lands on the last block and follows the conversation. */
    automatic?: boolean;
    /** Prefix tokens cached up to and including this point. */
    prefixTokens: number;
    why: string;
}
export interface CachePlan {
    provider: "anthropic" | "openai" | "gemini" | "unknown";
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
    /** Cache reads relative to input, for this model. */
    readMultiplier?: number;
    notes: string[];
}
export declare function minCacheableTokens(model?: string): number;
export interface CachePlanOptions {
    /** Place the conversation's breakpoint on its last block instead of using top-level automatic caching. */
    explicit?: boolean;
}
export declare function planCache(request: unknown, calls?: number, modelOverride?: string, opts?: CachePlanOptions): {
    plan: CachePlan;
    apply: () => Record<string, any>;
};
export declare function renderCachePlan(p: CachePlan): string;
