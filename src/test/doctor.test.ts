/** doctor must always produce a diagnosis and exit 0, even on a bare machine. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

test("doctor runs, checks the MCP handshake, and exits 0", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ctxdoc-doctor-"));
  const out = await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, "doctor"],
      { env: { ...process.env, CONTEXT_DOCTOR_HOOK_STATE: join(stateDir, "state.json") }, timeout: 20000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
  assert.ok(out.includes("CONTEXT DOCTOR — self-check"));
  assert.ok(out.includes("MCP server handshake"));
  assert.ok(/✓ MCP server handshake/.test(out), "our own server must pass its own handshake");
  assert.ok(out.includes("Ledger"));
});
