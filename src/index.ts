/**
 * context-doctor — profile and optimize LLM context windows.
 * Library entry point; see cli.ts for the CLI and mcp.ts for the MCP server.
 */

export { parseConversation } from "./parse.js";
export type { NormalizedConversation, NormalizedMessage, MessageKind } from "./parse.js";

export { profileConversation } from "./profile.js";
export type { ContextProfile, Finding, FindingId, MessageProfile, Category } from "./profile.js";

export { optimizeConversation } from "./optimize.js";
export type { OptimizeOptions, OptimizeResult, AppliedChange, StrategyId } from "./optimize.js";

export { renderProfile } from "./report.js";
export { estimateTokens, contextWindowFor, providerFor, formatTokens } from "./tokens.js";
export type { Provider } from "./tokens.js";
