/**
 * config.toml is the user's file and is edited without a TOML library, so
 * every shape of our table a person (or Codex itself) can write must be
 * found, and anything that cannot be edited line by line must be refused
 * rather than turned into invalid TOML.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeCodexMcpTable, upsertCodexMcpTable } from "../install.js";
import { sandboxEnv } from "./sandbox.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const entry = { command: "node", args: ["/p/mcp.js"] };
const headers = (toml: string) => (toml.match(/^\s*\[\s*mcp_servers\s*\.\s*["']?context-doctor["']?\s*\]/gm) ?? []).length;

test("a header with a trailing comment or a quoted key is our table, not a reason to append a second one", () => {
  for (const header of ["[mcp_servers.context-doctor] # added by context-doctor", '[mcp_servers."context-doctor"]', "[ mcp_servers.'context-doctor' ]"]) {
    const toml = `model = "x"\n\n${header}\ncommand = "old"\nargs = []\n\n[mcp_servers.github]\ncommand = "npx"\n`;
    const next = upsertCodexMcpTable(toml, entry);
    assert.equal(headers(next), 1, `one table for ${header}:\n${next}`);
    assert.ok(!next.includes('"old"'), "the old command is replaced");
    assert.match(next, /\[mcp_servers\.github\]\ncommand = "npx"/);
    const removed = removeCodexMcpTable(next);
    assert.ok(!removed.includes("context-doctor"), `removal finds it too:\n${removed}`);
  }
});

test("inline-table and dotted-key definitions are refused, not duplicated", () => {
  const inline = `[mcp_servers]\ncontext-doctor = { command = "npx", args = ["-y", "context-doctor", "mcp"] }\n`;
  const dotted = `mcp_servers.context-doctor.command = "npx"\nmcp_servers.context-doctor.args = ["-y", "context-doctor", "mcp"]\n`;
  const dottedInTable = `[mcp_servers]\n"context-doctor".command = "npx"\n`;
  for (const toml of [inline, dotted, dottedInTable]) {
    assert.throws(() => upsertCodexMcpTable(toml, entry), /inline table or dotted keys/, toml);
    assert.throws(() => removeCodexMcpTable(toml), /inline table or dotted keys/, toml);
  }
});

test("removal takes our subtables with it and leaves the comment that belongs to the next table", () => {
  const toml =
    `[mcp_servers.context-doctor]\ncommand = "node"\nargs = []\n\n` +
    `[mcp_servers.context-doctor.env]\nFOO = "1"\n\n` +
    `# GitHub server, for PR review\n[mcp_servers.github]\ncommand = "npx"\n`;
  const removed = removeCodexMcpTable(toml);
  assert.ok(!removed.includes("context-doctor"), `no orphaned subtable:\n${removed}`);
  assert.match(removed, /# GitHub server, for PR review\n\[mcp_servers\.github\]/, "the comment stays with its table");

  // Upserting keeps the user's env subtable and the next table's comment.
  const updated = upsertCodexMcpTable(toml, entry);
  assert.match(updated, /\[mcp_servers\.context-doctor\.env\]\nFOO = "1"/);
  assert.match(updated, /# GitHub server, for PR review\n\[mcp_servers\.github\]/);
  assert.equal(upsertCodexMcpTable(updated, entry), updated, "idempotent");
});

test("install refuses an inline definition with a clear message and leaves the file as it was", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxdoc-codexinline-"));
  mkdirSync(join(home, ".codex"), { recursive: true });
  const toml = `[mcp_servers]\ncontext-doctor = { command = "npx", args = ["-y", "context-doctor", "mcp"] }\n`;
  writeFileSync(join(home, ".codex", "config.toml"), toml);
  const r = await new Promise<{ code: number; err: string }>((resolve) => {
    execFile(process.execPath, [cliPath, "install"], { env: sandboxEnv(home) }, (error, _stdout, stderr) =>
      resolve({ code: error ? (error as { code?: number }).code ?? 1 : 0, err: stderr })
    );
  });
  assert.equal(r.code, 1, "a target that could not be configured fails the run");
  assert.match(r.err, /✗ Codex MCP: .*inline table or dotted keys/);
  assert.equal(readFileSync(join(home, ".codex", "config.toml"), "utf8"), toml, "not one byte changed");
});
