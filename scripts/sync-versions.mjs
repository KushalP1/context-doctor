// Run by `npm version` (the "version" lifecycle script) after package.json is
// bumped: copies the new version everywhere else it is written, rebuilds the
// committed dist/, and stages it all so the version commit is complete.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const edit = (file, fn) => writeFileSync(file, fn(readFileSync(file, "utf8")));

edit("server.json", (s) => {
  const j = JSON.parse(s);
  j.version = version;
  for (const p of j.packages ?? []) p.version = version;
  return JSON.stringify(j, null, 2) + "\n";
});
// The Claude Code plugin: the plugin directory asks for a version, and Claude
// Code offers a plugin update when it changes.
edit(".claude-plugin/plugin.json", (s) => s.replace(/"version": "[^"]+"/, `"version": "${version}"`));
edit("src/mcp.ts", (s) => s.replace(/\{ name: "context-doctor", version: "[^"]+" \}/, `{ name: "context-doctor", version: "${version}" }`));
edit("src/proxy.ts", (s) => s.replace(/export const PROXY_VERSION = "[^"]+";/, `export const PROXY_VERSION = "${version}";`));
// The GitHub Action as the docs tell people to pin it: the tag this version gets.
for (const f of ["README.md", "docs/ci.md"]) edit(f, (s) => s.replace(/KushalP1\/context-doctor@v\d+\.\d+\.\d+/g, `KushalP1/context-doctor@v${version}`));

execSync("npm run build", { stdio: "inherit" });
execSync("git add server.json .claude-plugin/plugin.json src/mcp.ts src/proxy.ts README.md docs/ci.md dist", { stdio: "inherit" });
console.log(`synced ${version} into server.json, the plugin manifest, the MCP server, the proxy and the Action pins in the docs; dist rebuilt`);
