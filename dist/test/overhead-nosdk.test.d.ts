/**
 * dist/ with no node_modules anywhere above it: how the Claude Code plugin
 * runs (a git checkout), and what the npm package now is (it declares no
 * runtime dependencies; the MCP SDK and zod are bundled into dist/mcp.js and
 * dist/mcpclient.js). `overhead --mcp` used to note "MCP SDK not installed"
 * there; it now measures the servers, and the server itself starts.
 */
export {};
