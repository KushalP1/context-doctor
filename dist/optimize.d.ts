/**
 * The optimizer: deterministic, lossless-first strategies that rewrite a
 * conversation's message array to reclaim tokens. No LLM calls — everything
 * here is safe to run offline and inspect before use.
 *
 * Strategies operate on the ORIGINAL JSON structure (not the normalized view)
 * so the output is a drop-in replacement for the input conversation.
 */
export type StrategyId = "dedupe" | "trim-tool-results" | "trim-tool-calls" | "prune-history" | "strip-base64";
export interface OptimizeOptions {
    strategies?: StrategyId[];
    /** Tool results older than this many messages from the end get trimmed. */
    keepRecent?: number;
    /** Max tokens a trimmed tool result — or tool-call argument set — keeps. */
    maxToolResultTokens?: number;
    /**
     * How many messages the trim boundary moves at a time. Bigger steps keep the
     * prompt cache alive longer but leave stale results in place longer.
     * Measured on a growing agent session: at 400 turns a step of 10 invalidated
     * the cache on 21% of turns with ~2 stale results waiting on average; 20
     * gave 12% and ~4; 40 gave 10% and ~9. Adaptive steps were worse everywhere,
     * because a step that changes size moves the boundary by itself. Default 10.
     */
    trimBoundaryStep?: number;
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
