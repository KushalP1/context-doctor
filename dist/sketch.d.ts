/**
 * Profile a conversation from a SKETCH instead of the conversation itself.
 *
 * Why this exists: in a chat app (Claude Desktop, ChatGPT) the model cannot
 * export the conversation, so asking it to call profile_context with the full
 * JSON means re-typing 50k+ tokens as a tool argument. No model does that, and
 * it would double the context it is meant to measure. A sketch is ~100 output
 * tokens: turn count plus the handful of blocks that matter (pastes, tool
 * results, images, repeats). Measured error: -20% to +9% on the conversation
 * total from turn count alone, ±25% on a code block sized by lines, ±15% on
 * one sized by chars. Coarse, stated, and enough to find what to drop; it turns
 * "call profile_context" from an impossible instruction into a cheap one.
 */
export type SketchKind = "paste" | "code" | "tool_result" | "image" | "base64" | "text";
export interface SketchBlock {
    /** 1-based turn the block sits in. */
    turn: number;
    kind: SketchKind;
    /** Short name the model can refer to later ("the nginx config", "test output #2"). */
    label: string;
    approx_tokens?: number;
    approx_lines?: number;
    approx_words?: number;
    approx_chars?: number;
    /** Times this same content appears in the conversation (2+ = duplicate). */
    repeated?: number;
    /** Already acted on; nothing in it is still needed. */
    stale?: boolean;
}
export interface ConversationSketch {
    /** User+assistant exchanges so far. */
    turns: number;
    /** Model the chat runs as, for window and price math. */
    model?: string;
    blocks: SketchBlock[];
}
export interface SketchFinding {
    id: "large_block" | "duplicate_block" | "base64_blob" | "many_images" | "long_history" | "near_window_limit";
    severity: "info" | "warn" | "high";
    estSavings: number;
    message: string;
    action: string;
}
export interface SketchProfile {
    totalTokens: number;
    baselineTokens: number;
    blockTokens: number;
    turns: number;
    model?: string;
    contextWindow?: number;
    usagePct?: number;
    findings: SketchFinding[];
    totalEstSavings: number;
    perTurnUsd?: number;
    perTurnCachedUsd?: number;
}
export declare function blockTokens(b: SketchBlock, model?: string): number;
/** Tokens for one plain exchange under this model's tokenizer. */
export declare function exchangeTokens(model?: string): number;
export declare function profileSketch(sketch: ConversationSketch): SketchProfile;
export declare function renderSketchProfile(p: SketchProfile): string;
/** Profile a sketch, log it to the ledger like a hook check, and render. */
export declare function runSketch(sketch: ConversationSketch): string;
