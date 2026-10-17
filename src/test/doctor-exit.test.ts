/**
 * doctor's verdict must be readable by a script and consistent across apps:
 * exit 1 when a check fails; an app config that is absent or an empty stub
 * (what uninstall leaves) is "not installed" everywhere; a hook is not an
 * issue for an app reported as not there; and doctor itself creates nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEmptyStub } from "../install.js";
import { sandboxEnv } from "./sandbox.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

function doctor(home: string): Promise<{ code: number; out: string; err: string }> {
  // PATH holds only node: a gemini binary on the developer's PATH would count as Gemini CLI.
  const env = { ...sandboxEnv(home), PATH: dirname(process.execPath) };
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, "doctor"], { env, cwd: home, timeout: 30_000 }, (error, stdout, stderr) =>
      resolve({ code: error ? (error as { code?: number }).code ?? 1 : 0, out: stdout, err: stderr })
    );
  });
}

const line = (out: string, label: string) => out.split("\n").find((l) => l.slice(2).startsWith(label)) ?? "";

test("isEmptyStub: {} and empty containers only", () => {
  assert.ok(isEmptyStub({}));
  assert.ok(isEmptyStub({ mcpServers: {} }));
  assert.ok(isEmptyStub({ hooks: {} }));
  assert.ok(isEmptyStub({ version: 1, hooks: {} }, ["version"]));
  assert.ok(!isEmptyStub({ version: 1, hooks: {} }), "version only counts where install writes it");
  assert.ok(!isEmptyStub({ mcpServers: { other: {} } }));
  assert.ok(!isEmptyStub({ theme: "dark" }));
  assert.ok(!isEmptyStub([]));
});

test("absent configs and empty stubs both read as not installed, hooks included, exit 0", async () => {
  const absent = mkdtempSync(join(tmpdir(), "ctxdoc-dx-absent-"));
  mkdirSync(join(absent, ".claude"));
  mkdirSync(join(absent, ".cursor"));
  const stub = mkdtempSync(join(tmpdir(), "ctxdoc-dx-stub-"));
  mkdirSync(join(stub, ".claude"));
  mkdirSync(join(stub, ".cursor"));
  writeFileSync(join(stub, ".claude.json"), JSON.stringify({ mcpServers: {} }));
  writeFileSync(join(stub, ".claude", "settings.json"), JSON.stringify({ hooks: {} }));
  writeFileSync(join(stub, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: {} }));
  writeFileSync(join(stub, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: {} }));

  for (const home of [absent, stub]) {
    const r = await doctor(home);
    assert.equal(r.code, 0, r.out);
    for (const label of ["Claude Code", "Every-prompt hook", "Cursor ", "Cursor hook"]) {
      assert.match(line(r.out, label), /^– /, `${label} in ${home}:\n${r.out}`);
    }
    assert.ok(!/✗/.test(r.out), r.out);
    assert.ok(!/issue\(s\) found/.test(r.out));
  }
  assert.match(line((await doctor(stub)).out, "Cursor "), /not installed/);
});

test("a failed check makes the exit code 1", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxdoc-dx-fail-"));
  mkdirSync(join(home, ".claude"));
  // Claude Code is here (its own state file), but nothing of ours is.
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ numStartups: 7, mcpServers: { other: { command: "x" } } }));
  const r = await doctor(home);
  assert.equal(r.code, 1);
  assert.match(line(r.out, "Claude Code"), /^✗ .*no context-doctor entry/);
  assert.match(line(r.out, "Every-prompt hook"), /^✗ .*not registered/, "the hook of an app that is there is an issue");
  assert.match(r.out, /issue\(s\) found/);
});

test("doctor creates nothing: no ~/.claude on a machine without one", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxdoc-dx-bare-"));
  const r = await doctor(home);
  assert.equal(r.code, 0, r.out);
  assert.match(line(r.out, "Ledger"), /^✓ /);
  assert.ok(!existsSync(join(home, ".claude")), "doctor made ~/.claude");
});
