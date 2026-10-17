/** Autopilot keeps Claude Code's MCP tool search on (Claude Code turns it off behind a non-Anthropic ANTHROPIC_BASE_URL). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autopilotOff, autopilotPaths, ensureProxyUp, keepToolSearch, proxyUrl } from "../autopilot.js";

test("keepToolSearch sets auto only when the user has not chosen", () => {
  const env: Record<string, string> = {};
  assert.equal(keepToolSearch(env), true);
  assert.equal(env.ENABLE_TOOL_SEARCH, "auto");
  const theirs: Record<string, string> = { ENABLE_TOOL_SEARCH: "false" };
  assert.equal(keepToolSearch(theirs), false);
  assert.equal(theirs.ENABLE_TOOL_SEARCH, "false");
});

test("an install from before the fix gets tool search on from the self-heal, once; off removes only ours", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, service: "context-doctor-proxy", autopilot: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const port = (server.address() as { port: number }).port;
    const home = mkdtempSync(join(tmpdir(), "cd-ts-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    const paths = autopilotPaths(home);
    writeFileSync(paths.settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: proxyUrl(port), OTHER: "x" } }));
    writeFileSync(paths.config, JSON.stringify({ port, node: process.execPath, cli: "/nowhere/dist/cli.js" }));
    await ensureProxyUp(paths);
    const env = JSON.parse(readFileSync(paths.settings, "utf8")).env;
    assert.equal(env.ENABLE_TOOL_SEARCH, "auto");
    assert.equal(JSON.parse(readFileSync(paths.config, "utf8")).setToolSearch, true);
    await autopilotOff(paths, () => true);
    const after = JSON.parse(readFileSync(paths.settings, "utf8")).env;
    assert.equal(after.ENABLE_TOOL_SEARCH, undefined, "ours is removed");
    assert.equal(after.ANTHROPIC_BASE_URL, undefined);
    assert.equal(after.OTHER, "x");
  } finally {
    server.close();
  }
});
