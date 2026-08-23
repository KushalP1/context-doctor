/**
 * Optional exact token counting (`analyze --exact`). Zero-config heuristic
 * remains the default; this upgrades the TOTAL where an exact source exists:
 *
 *   Claude models — Anthropic's count-tokens API when ANTHROPIC_API_KEY is
 *   set (opt-in network call; the key is read from env, never stored).
 *   GPT models   — tiktoken, when the user has installed it alongside us
 *   (optional peer; we never ship the WASM weight by default).
 *
 * Anything else falls back to the heuristic with a note saying why.
 */
export interface ExactResult {
    tokens?: number;
    source?: string;
    note?: string;
}
export declare function exactTokenCount(conversationJson: string, model?: string): Promise<ExactResult>;
