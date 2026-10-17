/**
 * The MCP SDK's client side, as `overhead --mcp` uses it to size configured
 * servers. The build bundles this file in place (scripts/bundle-mcp.mjs), so
 * the published dist/mcpclient.js carries the SDK and zod inside it and the
 * npm package declares no runtime dependencies: `npx context-doctor` installs
 * one package instead of about a hundred.
 */

export { Client } from "@modelcontextprotocol/sdk/client/index.js";
export { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
export { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
