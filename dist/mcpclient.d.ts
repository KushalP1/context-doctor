/**
 * The MCP SDK's client side (the v2 packages), as `overhead --mcp` uses it to
 * size configured servers. The build bundles this file in place
 * (scripts/bundle-mcp.mjs), so the published dist/mcpclient.js carries the
 * SDK and zod inside it and the npm package declares no runtime dependencies:
 * `npx context-doctor` installs one package instead of about a hundred.
 */
export { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
export { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
