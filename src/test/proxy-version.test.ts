/** Autopilot self-heal: a proxy still serving an old version is restarted onto the installed build, at most once an hour. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autopilotPaths, ensureProxyUp, installedVersion } from "../autopilot.js";

test("installedVersion reads the package a CLI path belongs to", () => {
  const pkg = mkdtempSync(join(tmpdir(), "cd-pkg-"));
  mkdirSync(join(pkg, "dist"));
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "9.9.9" }));
  assert.equal(installedVersion(join(pkg, "dist", "cli.js")), "9.9.9");
  assert.equal(installedVersion("/nowhere/dist/cli.js"), undefined);
});

test("an outdated proxy triggers one restart attempt, then waits an hour", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, service: "context-doctor-proxy", autopilot: true, version: "0.25.0" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const home = mkdtempSync(join(tmpdir(), "cd-home-"));
    const paths = autopilotPaths(home);
    mkdirSync(join(home, ".claude"), { recursive: true });
    const pkg = mkdtempSync(join(tmpdir(), "cd-pkg-"));
    mkdirSync(join(pkg, "dist"));
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "0.29.0" }));
    writeFileSync(join(pkg, "dist", "cli.js"), "");
    writeFileSync(paths.config, JSON.stringify({ port: (server.address() as { port: number }).port, node: process.execPath, cli: join(pkg, "dist", "cli.js") }));
    const marker = join(home, ".claude", ".context-doctor-proxy-restart");
    await ensureProxyUp(paths);
    assert.ok(existsSync(marker), "a restart was due and attempted");
    writeFileSync(paths.config, JSON.stringify({ port: (server.address() as { port: number }).port, node: process.execPath, cli: join(pkg, "dist", "cli.js") }));
    const first = readFileSync(marker, "utf8");
    await new Promise((r) => setTimeout(r, 5));
    await ensureProxyUp(paths);
    assert.equal(readFileSync(marker, "utf8"), first, "no second attempt within the hour");
  } finally {
    server.close();
  }
});
