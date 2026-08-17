/**
 * The optimizer: deterministic, lossless-first strategies that rewrite a
 * conversation's message array to reclaim tokens. No LLM calls — everything
 * here is safe to run offline and inspect before use.
 *
 * Strategies operate on the ORIGINAL JSON structure (not the normalized view)
 * so the output is a drop-in replacement for the input conversation.
 */
export type StrategyId = "dedupe" | "trim-tool-results" | "prune-history" | "strip-base64";
export interface OptimizeOptions {
    strategies?: StrategyId[];
    /** Tool results older than this many messages from the end get trimmed. */
    keepRecent?: number;
    /** Max tokens a trimmed tool result keeps. */
    maxToolResultTokens?: number;
}
export interface AppliedChange {
    strategy: StrategyId;
    messageIndex: number;
    tokensSaved: number;
    note: string;
}
export interface OptimizeResult {
    /** The rewritten conversation, same shape as the input. */
    conversation: unknown;
    tokensBefore: number;
    tokensAfter: number;
    applied: AppliedChange[];
    /**
     * When prune-history ran: a compact digest of the pruned turns. A host LLM
     * (e.g. the model running in Claude Desktop via MCP) can summarize this and
     * replace the stub message — summarization without any API key.
     */
    prunedDigest?: string;
}
export declare function optimizeConversation(input: string, options?: OptimizeOptions): OptimizeResult;
