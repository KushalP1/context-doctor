#!/usr/bin/env node
/**
 * context-doctor MCP server (stdio).
 *
 * Plug into Claude Desktop, ChatGPT desktop (developer mode), Cursor, or any
 * MCP client:
 *
 *   { "mcpServers": { "context-doctor": { "command": "npx", "args": ["-y", "context-doctor-mcp"] } } }
 *
 * Tools:
 *   profile_context   — analyze a conversation/prompt, report token breakdown + findings
 *   optimize_context  — apply safe strategies, return the slimmed conversation
 *   context_best_practices — curated checklist for a given provider/use case
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { parseConversation } from "./parse.js";
import { profileConversation } from "./profile.js";
import { optimizeConversation } from "./optimize.js";
import { renderProfile } from "./report.js";
import { formatTokens } from "./tokens.js";
/**
 * Server instructions are injected by MCP clients (Claude Desktop, Cursor, …)
 * into the system context of EVERY conversation where this server is enabled.
 * This is what upgrades plain-chat apps from "tools available on request" to
 * "standing context-hygiene instructions in every chat" — no hook needed.
 */
const SERVER_INSTRUCTIONS = `context-doctor keeps this conversation's context window lean, fast, and cheap. Standing instructions for every conversation:
1. Practice context hygiene continuously: after consuming a large tool result or pasted document, carry forward a one-sentence summary instead of re-quoting it; reference earlier content rather than repeating it; never inline base64.
2. When the conversation has grown long (roughly 30+ turns) or contains several large pastes, proactively offer to profile it and call profile_context — do not wait to be asked.
3. When the user asks anything about token usage, cost, latency, or "what's eating my context", call profile_context immediately rather than estimating by eye.
4. When optimize_context returns a pruned-turns digest, YOU write the replacement summary (dense, factual, ≤150 tokens) as instructed in the result.`;
const server = new McpServer({ name: "context-doctor", version: "0.2.1" }, { instructions: SERVER_INSTRUCTIONS });
const STRATEGY_IDS = ["dedupe", "trim-tool-results", "strip-base64", "prune-history"];
server.tool("profile_context", "Profile an LLM conversation or prompt: token breakdown by category, largest messages, and actionable findings about wasted context (duplicates, oversized tool results, base64 blobs, cache-unfriendly ordering). Accepts OpenAI/Anthropic conversation JSON or raw text. Call this immediately whenever the user asks about token usage, context size, LLM cost, or latency — and proactively offer it once a conversation grows long or accumulates large pasted content.", {
    conversation: z.string().describe("Conversation JSON (OpenAI or Anthropic format, or bare message array) or raw prompt text"),
    model: z.string().optional().describe("Target model name for context-window math, e.g. claude-sonnet-5 or gpt-4o"),
}, async ({ conversation, model }) => {
    const profile = profileConversation(parseConversation(conversation), model);
    return { content: [{ type: "text", text: renderProfile(profile) }] };
});
server.tool("optimize_context", "Rewrite a conversation to reclaim tokens using deterministic strategies: dedupe repeated content, trim stale tool results, strip base64 blobs, optionally prune old history. Returns the slimmed conversation JSON plus a savings summary. No LLM calls — safe and inspectable. Call this after profile_context finds recoverable waste and the user wants it fixed; add the prune-history strategy only with the user's consent, then write the replacement summary yourself as the result instructs.", {
    conversation: z.string().describe("Conversation JSON (OpenAI or Anthropic format, or bare message array)"),
    strategies: z.array(z.enum(STRATEGY_IDS)).optional()
        .describe("Strategies to apply. Default: dedupe, trim-tool-results, strip-base64. Add prune-history for lossy compaction of old turns."),
    keep_recent: z.number().int().positive().optional().describe("Messages at the tail to leave untouched (default 6)"),
    max_tool_result_tokens: z.number().int().positive().optional().describe("Token budget for trimmed tool results (default 300)"),
}, async ({ conversation, strategies, keep_recent, max_tool_result_tokens }) => {
    const result = optimizeConversation(conversation, {
        strategies: strategies,
        keepRecent: keep_recent,
        maxToolResultTokens: max_tool_result_tokens,
    });
    const saved = result.tokensBefore - result.tokensAfter;
    const summary = `Saved ~${formatTokens(saved)} tokens (${formatTokens(result.tokensBefore)} → ${formatTokens(result.tokensAfter)}) ` +
        `via ${result.applied.length} change(s):\n` +
        result.applied.map((c) => `- [${c.strategy}] message #${c.messageIndex}: ${c.note} (~${formatTokens(c.tokensSaved)})`).join("\n");
    // Echoing a huge optimized conversation back inline would flood the very
    // context this tool exists to save. Above the cap, return the summary and
    // point at the CLI (compact JSON keeps mid-size results affordable).
    const ECHO_CAP_CHARS = 100_000;
    const conversationJson = JSON.stringify(result.conversation);
    const content = [
        { type: "text", text: summary },
        conversationJson.length <= ECHO_CAP_CHARS
            ? { type: "text", text: conversationJson }
            : {
                type: "text",
                text: `[optimized conversation is ${conversationJson.length} chars — too large to echo into this context. ` +
                    `Tell the user the savings above and that \`npx context-doctor optimize <file> --out slim.json\` produces the file directly.]`,
            },
    ];
    // Host-model summarization: instead of calling an LLM ourselves (which would
    // need an API key), hand the pruned material to the model that invoked this
    // tool and ask IT to write the summary.
    if (result.prunedDigest) {
        content.push({
            type: "text",
            text: "ACTION REQUIRED (you, the assistant calling this tool): the pruned turns are digested below. " +
                "Write a dense factual summary of them (≤150 tokens: decisions, current state, open items, key identifiers) " +
                "and replace the '[context-doctor: ... pruned]' stub message in the conversation above with your summary " +
                "before presenting the result.\n\nPRUNED TURNS DIGEST:\n" + result.prunedDigest,
        });
    }
    return { content };
});
const BEST_PRACTICES = {
    general: [
        "Put stable content first (system prompt, tool definitions, reference docs) and volatile content last — prompt caches match byte-identical prefixes only.",
        "Truncate or summarize tool results before they enter history; keep only what the model actually needs downstream.",
        "Never inline base64/binary data in text content — use file/image APIs.",
        "Summarize and drop conversation history past ~30-40 turns; models lose the middle of long contexts well before the hard limit.",
        "Deduplicate: if the same document/result appears twice, replace later copies with a reference.",
        "Measure before optimizing — profile the conversation to find the actual heavy hitters.",
    ],
    anthropic: [
        "Use prompt caching with cache_control breakpoints after your stable prefix — cached reads cost ~10% of base input price.",
        "Claude models have a 200k window, but quality degrades under heavy fill; aim to stay under ~70%.",
        "For agents: prefer compact tool-result summaries in history and re-fetch details on demand.",
    ],
    openai: [
        "Prefix caching is automatic for prompts >1024 tokens — but only on byte-identical prefixes, so keep the front of your prompt stable.",
        "Use max_completion_tokens headroom math: input + output must fit the window together.",
    ],
};
server.tool("context_best_practices", "Get a curated checklist of context-management best practices, optionally specialized for a provider (anthropic, openai).", {
    provider: z.enum(["general", "anthropic", "openai"]).optional().describe("Provider to specialize tips for (default: general)"),
}, async ({ provider }) => {
    const tips = [...BEST_PRACTICES.general, ...(provider && provider !== "general" ? BEST_PRACTICES[provider] : [])];
    return { content: [{ type: "text", text: tips.map((t, i) => `${i + 1}. ${t}`).join("\n") }] };
});
const transport = new StdioServerTransport();
await server.connect(transport);
