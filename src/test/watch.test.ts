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

  // Wait for a condition rather than sleeping a fixed time: fixed sleeps make
  // this test flaky under parallel load (it fails in the full suite while
  // passing alone), and a deadline is both faster and deterministic.
  const waitFor = async (predicate: () => boolean, what: string, deadlineMs = 10_000): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timed out waiting for ${what}; output so far:\n${out}`);
  };

  try {
    // First tick: initial line.
    await waitFor(() => /tokens/.test(out), "the initial status line");

    // Grow the file with an oversized tool result → new status + a finding.
    appendFileSync(
      file,
      line("assistant", JSON.stringify([{ type: "tool_use", id: "t1", name: "search", input: {} }])) +
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "data ".repeat(3000) }] } }) +
        "\n"
    );
    await waitFor(() => out.split("\n").filter((l) => l.includes("tokens")).length >= 2, "a second status line after growth");
    await waitFor(() => out.includes("⚠"), "a finding to surface");
  } finally {
    child.kill();
  }
});

test("watch follows a plain conversation JSON file (agent traces), not only session transcripts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-watch-json-"));
  const file = join(dir, "trace.json");
  writeFileSync(file, JSON.stringify({ model: "claude-opus-5", messages: [{ role: "user", content: "hi" }] }));
  const child = spawn(process.execPath, [cliPath, "watch", file, "--interval-ms", "200"]);
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  // Wait for output rather than sleeping a fixed time: a loaded CI runner can
  // take well over a second to start node.
  const waitFor = async (re: RegExp, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!re.test(out)) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${re}; got: ${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  try {
    await waitFor(/1 messages/);
    writeFileSync(file, JSON.stringify({ model: "claude-opus-5", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "x".repeat(40000) }] }));
    await waitFor(/2 messages/);
  } finally {
    child.kill();
  }
  assert.match(out, /~15k tokens \(\+15k\)/);
});
