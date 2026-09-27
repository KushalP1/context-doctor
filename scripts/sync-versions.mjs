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
edit("src/mcp.ts", (s) => s.replace(/\{ name: "context-doctor", version: "[^"]+" \}/, `{ name: "context-doctor", version: "${version}" }`));
edit("src/proxy.ts", (s) => s.replace(/export const PROXY_VERSION = "[^"]+";/, `export const PROXY_VERSION = "${version}";`));

execSync("npm run build", { stdio: "inherit" });
execSync("git add server.json src/mcp.ts src/proxy.ts dist", { stdio: "inherit" });
console.log(`synced ${version} into server.json, the MCP server and the proxy; dist rebuilt`);
