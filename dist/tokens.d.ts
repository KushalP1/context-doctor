/**
 * Token estimation without provider tokenizer dependencies.
 *
 * Exact token counts require each provider's tokenizer (tiktoken, Anthropic's
 * API, etc.). For profiling purposes an estimate within ~10% is enough to rank
 * what's eating the window, so we use a calibrated chars-per-token heuristic:
 * prose averages ~4 chars/token, code and JSON are denser (~3.2), and
 * whitespace-heavy content is cheaper. This keeps the tool zero-config and
 * fully offline.
 */
export type Provider = "anthropic" | "openai" | "google" | "generic";
export declare function contextWindowFor(model?: string): number | undefined;
export declare function providerFor(model?: string): Provider;
export declare function estimateTokens(text: string): number;
/** Per-message structural overhead (role markers, delimiters) is roughly constant. */
export declare const MESSAGE_OVERHEAD_TOKENS = 4;
export declare function formatTokens(n: number): string;
