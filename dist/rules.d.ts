/**
 * The standing context rules: the one text every surface without a hook of
 * its own gets. The MCP server sends it as its `instructions` (Claude
 * Desktop, Cursor, ChatGPT and any MCP client that passes them on), and the
 * GitHub Copilot sessionStart hook adds it as context, since the Copilot CLI
 * includes only some MCP servers' instructions unless started with
 * --allow-all-mcp-server-instructions. Kept in a module of its own so both
 * read the same words and neither pulls in the other's dependencies.
 */
/**
 * The standing rules every chat gets. ChatGPT's MCP guide says to keep the
 * most important details in the first 512 characters, so rules 1-4 (when to
 * measure, the handoff, and the two habits) end exactly at character 512: a
 * client that keeps only that much gets whole rules, none cut mid-sentence
 * (mcp-http.test.ts pins the boundary). The two that need a particular tool
 * come after. Rule 2 is the only real cut a chat app allows: its history
 * cannot be edited, so a long chat moves to a new one (save_handoff).
 */
export declare const SERVER_INSTRUCTIONS = "Context hygiene rules (always on):\n1. When asked about tokens, cost, speed or limits, and once at ~30 turns or 3+ large pastes: call profile_context BEFORE answering; in a chat app pass a `sketch`. Act on its top finding. Do not estimate token counts yourself.\n2. When a chat grows long, offer a handoff once (save_handoff): only a new chat cuts its history.\n3. Summarize any paste or tool result over ~2k tokens into the points you need.\n4. Refer to earlier content by name; never re-quote it or inline base64.\n5. For a big file you won't edit, call pack_context with the question; don't read it whole.\n6. If optimize_context returns a pruned-turns digest, write its \u2264150-token summary.";
