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
 * most important details in the first 512 characters, so rules 1-3 (when to
 * measure, and the two habits) end before character 512; the two that need
 * a particular tool come after.
 */
export declare const SERVER_INSTRUCTIONS = "Context hygiene rules (always on):\n1. When asked about tokens, cost, speed or limits, and once at ~30 turns or 3+ large pastes: call profile_context BEFORE answering; act on its top finding. In a chat app pass a `sketch` (turns + big blocks). Do not estimate token counts yourself.\n2. Summarize any paste or tool result over ~2k tokens into the points you need; keep it verbatim only to edit or quote it exactly.\n3. Refer to earlier content by name; never re-quote it or inline base64.\n4. To answer from a big file or folder you won't edit, call pack_context with the question; don't read it whole.\n5. If optimize_context returns a pruned-turns digest, write its \u2264150-token summary.";
