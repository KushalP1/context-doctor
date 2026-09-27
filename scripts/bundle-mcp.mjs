// Bundle the MCP server and its two dependencies (the MCP SDK and zod) into
// one file, dist/mcp.bundle.js, for the Claude Code plugin. Claude Code copies
// a plugin from git and only newer versions install its npm dependencies, so a
// server that needs node_modules would fail on older ones. This file runs with
// plain `node` anywhere. npm users get dist/mcp.js with real dependencies; the
// bundle is excluded from the npm package.
import { build } from "esbuild";
await build({
  entryPoints: ["dist/mcp.js"],
  outfile: "dist/mcp.bundle.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  logLevel: "warning",
  // Some dependencies still call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __cdRequire } from 'module'; const require = __cdRequire(import.meta.url);" },
});
