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
import { recordLedger } from "./ledger.js";
import { runSketch } from "./sketch.js";

/**
 * Server instructions are injected by MCP clients (Claude Desktop, Cursor, …)
 * into the system context of EVERY conversation where this server is enabled.
 * This is what upgrades plain-chat apps from "tools available on request" to
 * "standing context-hygiene instructions in every chat" — no hook needed.
 */
// Kept deliberately terse: these ride in EVERY conversation's context, and a
// context-saving tool must not itself be context overhead (~130 tokens).
//
// Written as conditions and actions, not offers. On Claude Desktop this string
// is the only channel that reaches the model without the user asking — MCP has
// no hook and no data path there — so "offer to run" leaves it to a model that
// will usually not, while "when X, call Y before answering" is followed. The
// thresholds keep it from firing on every turn, which would cost more context
// than it saves.
const SERVER_INSTRUCTIONS = `Context hygiene rules (always on):
1. Summarize any paste or tool result over ~2k tokens into the points you will use, then work from the summary; never carry it verbatim.
2. Reference earlier content by name; never re-quote it. Never inline base64.
3. When the conversation passes ~30 turns, or holds 3+ large pastes, or the user asks about tokens, cost, speed or limits: call profile_context BEFORE answering and act on its top finding. In a chat app pass a \`sketch\` (turn count + the large/repeated blocks, ~100 tokens), not the conversation. Do not estimate token counts yourself.
4. If optimize_context returns a pruned-turns digest, you write the ≤150-token replacement summary.`;

const STRATEGY_IDS = ["dedupe", "trim-tool-results", "trim-tool-calls", "strip-base64", "prune-history"] as const;

/**
 * Build a fully-configured server instance. A factory (not a singleton) so the
 * stateless HTTP mode can hand every request its own server, per the MCP SDK's
 * recommended pattern.
 */
function createServer(): McpServer {
  const server = new McpServer(
    { name: "context-doctor", version: "0.18.0" },
    { instructions: SERVER_INSTRUCTIONS }
  );

  server.tool(
  "profile_context",
  "Profile an LLM conversation or prompt: token breakdown, largest blocks, and actionable findings about wasted context (duplicates, oversized pastes or tool results, base64 blobs, long history). Two inputs, pass ONE: `conversation` (full OpenAI/Anthropic JSON or raw text, for agents, files and proxies) or `sketch` (for chat apps such as Claude Desktop or ChatGPT where you cannot export the conversation: the turn count plus the few blocks that matter, ~100 tokens to write). Call it whenever the user asks about token usage, context size, cost, speed or limits, and on your own once the conversation passes ~30 turns or holds 3+ large pastes. Act on the top finding in your reply.",
  {
    conversation: z.string().optional().describe("Conversation JSON (OpenAI or Anthropic format, or bare message array) or raw prompt text. Omit in chat apps and pass `sketch`."),
    sketch: z.object({
      turns: z.number().int().nonnegative().describe("User+assistant exchanges so far"),
      model: z.string().optional().describe("Model this chat runs as, e.g. claude-sonnet-5, gpt-5"),
      blocks: z.array(z.object({
        turn: z.number().int().positive().describe("1-based turn the block sits in"),
        kind: z.enum(["paste", "code", "tool_result", "image", "base64", "text"]),
        label: z.string().describe("Short name you can refer to later, e.g. 'the nginx config'"),
        approx_tokens: z.number().positive().optional(),
        approx_lines: z.number().positive().optional(),
        approx_words: z.number().positive().optional(),
        approx_chars: z.number().positive().optional(),
        repeated: z.number().int().positive().optional().describe("Times this same content appears (2+ = duplicate)"),
        stale: z.boolean().optional().describe("Already acted on; nothing in it is still needed"),
      })).describe("Only the blocks over ~500 tokens, repeated, or images. Plain turns need not be listed."),
    }).optional().describe("Coarse description of the conversation for chat apps. Give one size hint per block (lines, words, chars or tokens)."),
    model: z.string().optional().describe("Target model name for context-window math, e.g. claude-sonnet-5 or gpt-4o"),
  },
  async ({ conversation, sketch, model }) => {
    if (sketch) {
      return { content: [{ type: "text", text: runSketch({ ...sketch, model: sketch.model ?? model }) }] };
    }
    if (!conversation) {
      return {
        isError: true,
        content: [{ type: "text", text: "Pass either `conversation` (full JSON or text) or `sketch` (turns + large/repeated blocks). In a chat app, use `sketch`." }],
      };
    }
    const profile = profileConversation(parseConversation(conversation), model);
    return { content: [{ type: "text", text: renderProfile(profile) }] };
  }
);

server.tool(
  "optimize_context",
  "Rewrite a conversation to reclaim tokens using deterministic strategies: dedupe repeated content, trim stale tool results, strip base64 blobs, optionally prune old history. Returns the slimmed conversation JSON plus a savings summary. No LLM calls — safe and inspectable. Call this after profile_context finds recoverable waste and the user wants it fixed; add the prune-history strategy only with the user's consent, then write the replacement summary yourself as the result instructs.",
  {
    conversation: z.string().describe("Conversation JSON (OpenAI or Anthropic format, or bare message array)"),
    strategies: z.array(z.enum(STRATEGY_IDS)).optional()
      .describe("Strategies to apply. Default: dedupe, trim-tool-results, strip-base64. Add trim-tool-calls to shrink big inline file writes, or prune-history for lossy compaction of old turns."),
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
    if (saved > 0) {
      recordLedger({ ev: "optimize", src: "mcp", saved, model: (result.conversation as { model?: string })?.model });
    }
    const summary =
      `Saved ~${formatTokens(saved)} tokens (${formatTokens(result.tokensBefore)} → ${formatTokens(result.tokensAfter)}) ` +
      `via ${result.applied.length} change(s):\n` +
      result.applied.map((c) => `- [${c.strategy}] message #${c.messageIndex}: ${c.note} (~${formatTokens(c.tokensSaved)})`).join("\n");
    // Echoing a huge optimized conversation back inline would flood the very
    // context this tool exists to save. Above the cap, return the summary and
    // point at the CLI (compact JSON keeps mid-size results affordable).
    const ECHO_CAP_CHARS = 100_000;
    const conversationJson = JSON.stringify(result.conversation);
    const content: Array<{ type: "text"; text: string }> = [
      { type: "text", text: summary },
      conversationJson.length <= ECHO_CAP_CHARS
        ? { type: "text", text: conversationJson }
        : {
            type: "text",
            text:
              `[optimized conversation is ${conversationJson.length} chars — too large to echo into this context. ` +
              `Tell the user the savings above and that \`npx context-doctor optimize <file> --out slim.json\` produces the file directly.]`,
          },
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

  // A prompt shows up in Claude Desktop's "+" menu, so a user can run a checkup
  // with one click instead of typing a request. It is the only proactive
  // surface MCP offers besides `instructions`.
  server.prompt(
    "context_checkup",
    "Profile this conversation's context and apply the top fix. One click, no typing.",
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Run profile_context on our conversation so far: pass a `sketch` (turn count, the model you are running as, and every block over ~500 tokens, repeated, or an image; one size hint each). " +
              "Report the total, the top three findings, and the estimated recoverable tokens in under 120 words. " +
              "Then, if the top finding is recoverable, apply it: summarize the offending content into the points still needed and tell me what you dropped. " +
              "Do not re-quote the content you are summarizing.",
          },
        },
      ],
    })
  );

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

  return server;
}

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
    "Current Claude generations have a 1M-token window (Haiku 200k), but quality degrades under heavy fill; aim to stay under ~70%.",
    "For agents: prefer compact tool-result summaries in history and re-fetch details on demand.",
  ],
  openai: [
    "Prefix caching is automatic for prompts >1024 tokens — but only on byte-identical prefixes, so keep the front of your prompt stable.",
    "Use max_completion_tokens headroom math: input + output must fit the window together.",
  ],
};

/**
 * Set a header on a Node request so every downstream reader sees it.
 *
 * `req.headers` is a parsed convenience copy; the MCP transport reconstructs a
 * Web Request from `req.rawHeaders`, so a header written to only one of them is
 * invisible to the other.
 */
function setHeader(req: import("node:http").IncomingMessage, name: string, value: string): void {
  req.headers[name] = value;
  const raw = req.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i].toLowerCase() === name) {
      raw[i + 1] = value;
      return;
    }
  }
  raw.push(name, value);
}

// -- Transport dispatch --------------------------------------------------------
// Default: stdio (Claude Desktop, Claude Code, Cursor spawn us as a child).
// --http [--port N] [--host H]: streamable-HTTP endpoint at /mcp for clients
// that connect to a URL instead of spawning a process — ChatGPT developer-mode
// connectors (which require a reachable URL), web MCP clients, remote setups.
const argv = process.argv.slice(2);
if (argv.includes("--http")) {
  const argAfter = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const port = Number(argAfter("--port")) > 0 ? Number(argAfter("--port")) : 8808;
  const host = argAfter("--host") ?? "127.0.0.1";
  const { createServer: createHttpServer } = await import("node:http");
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");

  createHttpServer(async (req, res) => {
    try {
      if (req.url === "/health") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, service: "context-doctor-mcp" }));
        return;
      }
      if (!(req.url ?? "").startsWith("/mcp")) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "MCP endpoint is /mcp" }));
        return;
      }
      if (req.method !== "POST") {
        // Stateless mode: no standalone SSE stream, no sessions to delete.
        res.statusCode = 405;
        res.setHeader("allow", "POST");
        res.end(JSON.stringify({ error: "Stateless server: POST /mcp only" }));
        return;
      }
      // The streamable-HTTP spec says a client MUST accept both
      // application/json and text/event-stream, and the SDK answers anything
      // else with a 406. Plenty of real callers send only application/json, or
      // `*/*`, or no Accept at all — and to them a 406 looks like the server
      // being broken. Our replies are single JSON-RPC responses with nothing to
      // stream, so those clients get a plain JSON body instead of a refusal.
      const accept = String(req.headers.accept ?? "");
      const askedForSse = accept.includes("text/event-stream");
      if (!askedForSse || !accept.includes("application/json")) {
        // The transport rebuilds the request from rawHeaders (via Hono), so
        // setting req.headers alone changes nothing it will ever look at.
        setHeader(req, "accept", "application/json, text/event-stream");
      }

      // Fresh server + transport per request (stateless — nothing shared).
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        // A client that never asked for a stream gets plain JSON back.
        enableJsonResponse: !askedForSse,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) res.statusCode = 500;
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  }).listen(port, host, () => {
    console.error(`context-doctor MCP (streamable HTTP) on http://${host}:${port}/mcp`);
    console.error(`ChatGPT developer-mode connectors need a URL their servers can reach — expose this via your host or a tunnel.`);
  });
} else {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
}
