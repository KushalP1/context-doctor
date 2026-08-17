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

const server = new McpServer({ name: "context-doctor", version: "0.1.0" });

const STRATEGY_IDS = ["dedupe", "trim-tool-results", "strip-base64", "prune-history"] as const;

server.tool(
  "profile_context",
  "Profile an LLM conversation or prompt: token breakdown by category, largest messages, and actionable findings about wasted context (duplicates, oversized tool results, base64 blobs, cache-unfriendly ordering). Accepts OpenAI/Anthropic conversation JSON or raw text.",
  {
    conversation: z.string().describe("Conversation JSON (OpenAI or Anthropic format, or bare message array) or raw prompt text"),
    model: z.string().optional().describe("Target model name for context-window math, e.g. claude-sonnet-5 or gpt-4o"),
  },
  async ({ conversation, model }) => {
    const profile = profileConversation(parseConversation(conversation), model);
    return { content: [{ type: "text", text: renderProfile(profile) }] };
  }
);

server.tool(
  "optimize_context",
  "Rewrite a conversation to reclaim tokens using deterministic strategies: dedupe repeated content, trim stale tool results, strip base64 blobs, optionally prune old history. Returns the slimmed conversation JSON plus a savings summary. No LLM calls — safe and inspectable.",
  {
    conversation: z.string().describe("Conversation JSON (OpenAI or Anthropic format, or bare message array)"),
    strategies: z.array(z.enum(STRATEGY_IDS)).optional()
      .describe("Strategies to apply. Default: dedupe, trim-tool-results, strip-base64. Add prune-history for lossy compaction of old turns."),
    keep_recent: z.number().int().positive().optional().describe("Messages at the tail to leave untouched (default 6)"),
    max_tool_result_tokens: z.number().int().positive().optional().describe("Token budget for trimmed tool results (default 300)"),
  },
  async ({ conversation, strategies, keep_recent, max_tool_result_tokens }) => {
    const result = optimizeConversation(conversation, {
      strategies: strategies as any,
      keepRecent: keep_recent,
      maxToolResultTokens: max_tool_result_tokens,
    });
    const saved = result.tokensBefore - result.tokensAfter;
    const summary =
      `Saved ~${formatTokens(saved)} tokens (${formatTokens(result.tokensBefore)} → ${formatTokens(result.tokensAfter)}) ` +
      `via ${result.applied.length} change(s):\n` +
      result.applied.map((c) => `- [${c.strategy}] message #${c.messageIndex}: ${c.note} (~${formatTokens(c.tokensSaved)})`).join("\n");
    const content: Array<{ type: "text"; text: string }> = [
      { type: "text", text: summary },
      { type: "text", text: JSON.stringify(result.conversation, null, 2) },
    ];
    // Host-model summarization: instead of calling an LLM ourselves (which would
    // need an API key), hand the pruned material to the model that invoked this
    // tool and ask IT to write the summary.
    if (result.prunedDigest) {
      content.push({
        type: "text",
        text:
          "ACTION REQUIRED (you, the assistant calling this tool): the pruned turns are digested below. " +
          "Write a dense factual summary of them (≤150 tokens: decisions, current state, open items, key identifiers) " +
          "and replace the '[context-doctor: ... pruned]' stub message in the conversation above with your summary " +
          "before presenting the result.\n\nPRUNED TURNS DIGEST:\n" + result.prunedDigest,
      });
    }
    return { content };
  }
);

const BEST_PRACTICES: Record<string, string[]> = {
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

server.tool(
  "context_best_practices",
  "Get a curated checklist of context-management best practices, optionally specialized for a provider (anthropic, openai).",
  {
    provider: z.enum(["general", "anthropic", "openai"]).optional().describe("Provider to specialize tips for (default: general)"),
  },
  async ({ provider }) => {
    const tips = [...BEST_PRACTICES.general, ...(provider && provider !== "general" ? BEST_PRACTICES[provider] : [])];
    return { content: [{ type: "text", text: tips.map((t, i) => `${i + 1}. ${t}`).join("\n") }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
