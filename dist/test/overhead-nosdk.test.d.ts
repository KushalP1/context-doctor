/**
 * `overhead --mcp` from the Claude Code plugin: the plugin runs dist/ from a
 * git checkout with no node_modules, so the MCP SDK cannot load. That must be
 * a note per server, not an ERR_MODULE_NOT_FOUND crash that loses the report.
 */
export {};
