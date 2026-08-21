/** watch: emits a status line on growth, surfaces new findings once. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

function line(role: string, content: string): string {
  return JSON.stringify({ type: role, message: { role, content } }) + "\n";
}

test("watch reports growth and new findings live", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxdoc-watch-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(file, line("user", "hello there"));

  const child = spawn(process.execPath, [cliPath, "watch", file, "--interval-ms", "150"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));

  try {
    // First tick: initial line.
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(/tokens/.test(out), `initial status line expected, got: ${out}`);

    // Grow the file with an oversized tool result → new status + a finding.
    appendFileSync(
      file,
      line("assistant", JSON.stringify([{ type: "tool_use", id: "t1", name: "search", input: {} }])) +
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "data ".repeat(3000) }] } }) +
        "\n"
    );
    await new Promise((r) => setTimeout(r, 700));
    const statusLines = out.split("\n").filter((l) => l.includes("tokens"));
    assert.ok(statusLines.length >= 2, `expected a second status line after growth: ${out}`);
    assert.ok(out.includes("⚠"), `expected a finding to surface: ${out}`);
  } finally {
    child.kill();
  }
});
