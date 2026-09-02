/**
 * The profiler: turns a normalized conversation into a breakdown of where
 * tokens go, plus a list of actionable findings ("what's eating my window").
 */
import { NormalizedConversation } from "./parse.js";
export type Category = "system" | "user" | "assistant" | "tool_calls" | "tool_results" | "other";
export interface MessageProfile {
    index: number;
    role: string;
    kind: string;
    tokens: number;
    preview: string;
    toolName?: string;
}
export type FindingId = "large_tool_result" | "large_tool_call" | "duplicate_content" | "near_duplicate" | "repeated_tool_call" | "repeated_file_read" | "retained_error_output" | "base64_blob" | "long_history" | "large_system_prompt" | "cache_ordering" | "near_window_limit";
export interface Finding {
    id: FindingId;
    severity: "info" | "warn" | "high";
    /** Estimated tokens recoverable by acting on this finding (0 = advisory). */
    estSavings: number;
    message: string;
    suggestion: string;
    /** Message indexes involved. */
    messages: number[];
}
export interface CostEstimate {
    /** Input cost of sending this context once, USD (estimate). */
    perCallUsd: number;
    /** Input cost over 1,000 calls — the number that makes people act. */
    per1kCallsUsd: number;
    /** USD recoverable per call if all savings findings are applied. */
    savingsPerCallUsd: number;
    /** Same, over 1,000 calls. */
    savingsPer1kCallsUsd: number;
    /** Estimated seconds of time-to-first-token attributable to this input size. */
    ttftSeconds: number;
    /** TTFT seconds saved per call if savings are applied. */
    ttftSavedSeconds: number;
}
export interface ContextProfile {
    totalTokens: number;
    model?: string;
    contextWindow?: number;
    usagePct?: number;
    messageCount: number;
    categories: Record<Category, number>;
    largestMessages: MessageProfile[];
    findings: Finding[];
    /** Total estimated savings if all findings with savings are acted on. */
    totalEstSavings: number;
    /** Present when the model has a known price. All figures are estimates. */
    cost?: CostEstimate;
    sourceFormat: string;
    /** Propagated from parsing: input could not be read as a conversation. */
    parseWarning?: string;
}
export declare function profileConversation(conv: NormalizedConversation, model?: string): ContextProfile;
