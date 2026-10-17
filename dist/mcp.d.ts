#!/usr/bin/env node
/**
 * context-doctor MCP server (stdio).
 *
 * Plug into Claude Desktop, Claude Code, Cursor, Codex, Gemini CLI or any MCP
 * client that launches a local command:
 *
 *   { "mcpServers": { "context-doctor": { "command": "npx", "args": ["-y", "context-doctor", "mcp"] } } }
 *
 * ChatGPT launches nothing locally: it connects only to a URL (a developer-mode
 * connector), which `--http` serves (see the transport dispatch at the end).
 *
 * Tools:
 *   profile_context   — analyze a conversation/prompt, report token breakdown + findings
 *   optimize_context  — apply safe strategies, return the slimmed conversation
 *   context_best_practices — curated checklist for a given provider/use case
 *   pack_context      — only the chunks of big files a question needs, within a token budget
 */
export {};
