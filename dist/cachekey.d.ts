/**
 * A stable `prompt_cache_key` per conversation for OpenAI requests that do
 * not carry one.
 *
 * OpenAI routes a request to a cache by a hash of its first tokens and, when
 * present, the key (prompt-caching guide, checked 2026-10-18). On models
 * before GPT-5.6 (GPT-5.5 and earlier) a stable key per group of related
 * requests is how to keep them on one cache; from GPT-5.6 on the key is
 * optional and only separates cache accounting, so it is left alone there.
 * A key the app set is never touched, and requests that continue a
 * server-side conversation (`previous_response_id`, `conversation`) are left
 * as they are: their history is not in the request to identify.
 *
 * The key is derived from what stays fixed for a conversation's life: its
 * instructions (system/developer messages, Responses `instructions`) and its
 * first user message. Two conversations that open identically share a key,
 * which is what a shared prefix wants anyway.
 */
/** Models whose cache routing uses the key: GPT before 5.6, the o-series, codex-mini. */
export declare function usesPromptCacheKey(model: unknown): boolean;
/** The request with a conversation key added, or undefined when it should go as it is. */
export declare function withPromptCacheKey(raw: string): {
    body: string;
    key: string;
} | undefined;
