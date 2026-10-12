/**
 * The background service and the proxy must never fight over the port, and
 * `off` must leave Claude Code pointing somewhere that works. Pinned:
 *  - the hook's self-heal asks launchd/systemd to start their proxy instead
 *    of spawning a second, detached one (which took the port and left the
 *    managed job crash-looping on EADDRINUSE: 45 crashes in one real log);
 *  - a proxy that finds its port served by another context-doctor proxy says
 *    so in one line and exits 0, and the service restarts only on failure;
 *  - `off` touches no service a throwaway HOME did not install (launchd,
 *    systemd and Task Scheduler name it globally);
 *  - a damaged autopilot config neither makes `on` record the proxy URL as
 *    the one to restore nor makes `off` leave the proxy URL in settings.
 * Every service-manager call here goes to a recorder: tests never reach the
 * real launchd or systemd.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { autopilotOff, autopilotPaths, baseUrlToRestore, ensureProxyUp, launchdPlist, proxyUrl, systemdUnit, type ServiceExec } from "../autopilot.js";
import { startProxy } from "../proxy.js";
import { freePort } from "./freeport.js";

const recorder = () => {
  const calls: string[] = [];
  const exec: ServiceExec = (cmd, args) => (calls.push([cmd, ...args].join(" ")), true);
  return { calls, exec };
};

/** A throwaway HOME with autopilot configured on a dead port; its "cli" only drops a marker file when started. */
async function home(withService: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "cd-svc-"));
  const paths = autopilotPaths(dir);
  mkdirSync(join(dir, ".claude"), { recursive: true });
  const marker = join(dir, "spawned");
  const cli = join(dir, "fake-cli.cjs");
  writeFileSync(cli, `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");`);
  writeFileSync(paths.config, JSON.stringify({ port: await freePort(), node: process.execPath, cli }));
  if (withService && process.platform === "darwin") {
    mkdirSync(join(dir, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(dir, "Library", "LaunchAgents", "com.gai-ventures.context-doctor.proxy.plist"), "<plist/>");
  }
  if (withService && process.platform === "linux") {
    mkdirSync(join(dir, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(join(dir, ".config", "systemd", "user", "context-doctor-proxy.service"), "[Service]\n");
  }
  return { dir, paths, marker };
}

test("the service restarts the proxy only when it fails", () => {
  const plist = launchdPlist(["/usr/bin/node", "/x/cli.js", "proxy"], "/tmp/l.log");
  assert.match(plist, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.match(systemdUnit(["/usr/bin/node", "/x/cli.js", "proxy"], "/tmp/l.log"), /^Restart=on-failure$/m);
});

const managed = process.platform === "darwin" || process.platform === "linux";
test("self-heal asks the service manager when one owns the proxy; no detached second copy", { skip: !managed }, async () => {
  const { paths, marker } = await home(true);
  const { calls, exec } = recorder();
  await ensureProxyUp(paths, exec);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(existsSync(marker), false, "no detached proxy was started");
  assert.equal(calls.length, 1);
  assert.match(calls[0], process.platform === "darwin" ? /^launchctl kickstart gui\/\d*\/com\.gai-ventures\.context-doctor\.proxy$/ : /^systemctl --user start context-doctor-proxy\.service$/);
});

test("self-heal without a service manager starts the proxy itself", async () => {
  const { paths, marker } = await home(false);
  const { calls, exec } = recorder();
  await ensureProxyUp(paths, exec);
  for (let i = 0; i < 40 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(marker), "detached proxy started");
  assert.deepEqual(calls, []);
});

test("off in a HOME that installed no service calls no service manager", async () => {
  const { paths } = await home(false);
  const { calls, exec } = recorder();
  await autopilotOff(paths, exec);
  assert.deepEqual(process.platform === "win32" ? calls.filter((c) => !c.startsWith("schtasks")) : calls, []);
});

test("off with a service this HOME installed stops that one", { skip: !managed }, async () => {
  const { paths } = await home(true);
  const { calls, exec } = recorder();
  await autopilotOff(paths, exec);
  assert.ok(calls.length >= 1);
  assert.match(calls[0], process.platform === "darwin" ? /^launchctl bootout / : /^systemctl --user disable --now /);
});

test("damaged config: off still removes the proxy URL from settings.json", async () => {
  const { paths } = await home(false);
  writeFileSync(paths.settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: proxyUrl(8787), OTHER: "1" } }));
  writeFileSync(paths.config, '{"port": 87');
  const { exec } = recorder();
  const lines = await autopilotOff(paths, exec);
  assert.deepEqual(JSON.parse(readFileSync(paths.settings, "utf8")).env, { OTHER: "1" });
  assert.match(lines.join("\n"), /no longer routed/);
});

test("off never restores the proxy URL itself, even when a config recorded it", async () => {
  const { paths } = await home(false);
  writeFileSync(paths.settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: proxyUrl(8787) } }));
  writeFileSync(paths.config, JSON.stringify({ port: 8787, previousBaseUrl: proxyUrl(8787), node: process.execPath, cli: "/x" }));
  await autopilotOff(paths, recorder().exec);
  assert.equal(JSON.parse(readFileSync(paths.settings, "utf8")).env, undefined);
});

test("damaged config: on does not record the proxy URL as the one to restore", async () => {
  const { paths } = await home(false);
  writeFileSync(paths.config, "{");
  assert.equal(baseUrlToRestore(paths, 8787, proxyUrl(8787)), null);
  assert.equal(baseUrlToRestore(paths, 8787, "https://gateway.example.com"), "https://gateway.example.com");
  writeFileSync(paths.config, JSON.stringify({ port: 8787, previousBaseUrl: "https://gateway.example.com", node: "n", cli: "c" }));
  assert.equal(baseUrlToRestore(paths, 8787, proxyUrl(8787)), "https://gateway.example.com", "a readable config keeps what it recorded");
});

/** Start the CLI proxy on `port` and collect how it ends. */
function runCli(port: number): Promise<{ code: number | null; err: string }> {
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  const child = spawn(process.execPath, [cli, "proxy", "--autopilot", "--port", String(port)], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr!.on("data", (d) => (err += d));
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  return new Promise((r) => child.once("exit", (code) => { clearTimeout(timer); r({ code, err }); }));
}

test("a port already served by a context-doctor proxy: one line, exit 0", async () => {
  const px = startProxy({ port: 0 });
  await new Promise<void>((r) => px.once("listening", r));
  try {
    const { code, err } = await runCli((px.address() as AddressInfo).port);
    assert.equal(code, 0, err);
    assert.match(err, /already served by a context-doctor proxy/);
    assert.doesNotMatch(err, /Unhandled|at Server\.setupListenHandle/);
  } finally {
    px.close();
  }
});

test("a port held by another program: one line, exit 1", async () => {
  const other = http.createServer((_q, r) => r.end("not us"));
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  try {
    const { code, err } = await runCli((other.address() as AddressInfo).port);
    assert.equal(code, 1, err);
    assert.match(err, /in use by another program/);
    assert.doesNotMatch(err, /Unhandled|at Server\.setupListenHandle/);
  } finally {
    other.close();
  }
});
