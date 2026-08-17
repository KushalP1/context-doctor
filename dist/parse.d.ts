/**
 * Normalize conversations from different providers into one shape.
 *
 * Accepted inputs:
 *  - OpenAI chat format:    { messages: [{ role, content, tool_calls?, tool_call_id? }] }
 *  - Anthropic format:      { system?, messages: [{ role, content: string | Block[] }] }
 *    where Block = { type: "text" | "tool_use" | "tool_result" | "image", ... }
 *  - Bare message array:    [{ role, content }, ...]
 *  - Raw text:              treated as a single user message (last-resort fallback)
 */
export type MessageKind = "system" | "user" | "assistant" | "tool_call" | "tool_result" | "image" | "other";
export interface NormalizedMessage {
    /** Index in the original message array (-1 for extracted system prompt). */
    index: number;
    role: string;
    kind: MessageKind;
    /** Flattened text content used for token estimation and analysis. */
    text: string;
    /** Tool name when kind is tool_call/tool_result and it is known. */
    toolName?: string;
    /** Just the tool-call portion (name + args), for repeat-call detection. */
    toolCallText?: string;
    /** True when the content contained non-text blocks (images, documents). */
    hasBinary: boolean;
}
export interface NormalizedConversation {
    messages: NormalizedMessage[];
    /** Format detected, for reporting. */
    sourceFormat: "openai" | "anthropic" | "array" | "text";
}
export declare function parseConversation(input: string): NormalizedConversation;
