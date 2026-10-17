// Bundle the two files that use the MCP SDK, with the SDK and zod inside
// them, so nothing in dist/ needs node_modules:
//  - dist/mcp.js, the MCP server: bundled to dist/mcp.bundle.js (the path the
//    Claude Code plugin runs; Claude Code copies a plugin from git and only
//    newer versions install its dependencies), and that bundle is then
//    written over dist/mcp.js itself, the file the npm bin, `context-doctor
//    mcp`, doctor's handshake and the .mcpb run;
//  - dist/mcpclient.js, the SDK's client for `overhead --mcp`, in place.
// The npm package therefore declares no runtime dependencies: a cold
// `npx context-doctor` installs one package instead of about a hundred.
import { copyFileSync } from "node:fs";
import { build } from "esbuild";
const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  logLevel: "warning",
  allowOverwrite: true,
  // Some dependencies still call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __cdRequire } from 'module'; const require = __cdRequire(import.meta.url);" },
};
await build({ ...common, entryPoints: ["dist/mcp.js"], outfile: "dist/mcp.bundle.js" });
copyFileSync("dist/mcp.bundle.js", "dist/mcp.js");
await build({ ...common, entryPoints: ["dist/mcpclient.js"], outfile: "dist/mcpclient.js" });
