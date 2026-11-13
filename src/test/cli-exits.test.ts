/** Commands that cannot do their job exit 1 with a reason: session on a non-transcript, dashboard on a busy port. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "./sandbox.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

test("session on a file that is not a transcript exits 1, like analyze", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-session-exit-"));
  writeFileSync(join(dir, "notes.txt"), "just some notes, not a transcript\n");
  writeFileSync(join(dir, "empty.jsonl"), "");
  for (const f of ["notes.txt", "empty.jsonl"]) {
    for (const extra of [[], ["--json"]]) {
      const r = spawnSync(process.execPath, [cliPath, "session", join(dir, f), ...extra], { encoding: "utf8", env: sandboxEnv(dir) });
      assert.equal(r.status, 1, `${f} ${extra.join(" ")}: ${r.stdout}`);
      assert.match(r.stderr, /as a session: no conversation messages/);
      assert.equal(r.stdout, "", "no report printed for a non-transcript");
    }
  }
});

test("dashboard on a busy port says so and exits 1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-dash-busy-"));
  const blocker = net.createServer();
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
  const port = (blocker.address() as AddressInfo).port;
  try {
    const child = spawn(process.execPath, [cliPath, "dashboard", "--port", String(port)], { env: sandboxEnv(dir) });
    let err = "";
    child.stderr.on("data", (c) => (err += c));
    const timer = setTimeout(() => child.kill(), 10_000);
    const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    clearTimeout(timer);
    assert.equal(code, 1, err);
    assert.match(err, new RegExp(`port ${port} is already in use`));
    assert.doesNotMatch(err, /at Server\.|node:events/, "no stack trace");
  } finally {
    blocker.close();
  }
});

test("--out into a folder that does not exist says so and exits 1, with no stack trace (optimize, cache-plan)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-out-exit-"));
  writeFileSync(join(dir, "chat.json"), JSON.stringify([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]));
  writeFileSync(join(dir, "request.json"), JSON.stringify({ model: "claude-sonnet-5", system: "s", messages: [{ role: "user", content: "hi" }] }));
  const out = join(dir, "missing", "out.json");
  for (const args of [["optimize", join(dir, "chat.json")], ["cache-plan", join(dir, "request.json")]]) {
    const r = spawnSync(process.execPath, [cliPath, ...args, "--out", out], { encoding: "utf8", env: sandboxEnv(dir) });
    assert.equal(r.status, 1, `${args[0]}: ${r.stderr}`);
    assert.match(r.stderr, /could not write .*out\.json: its folder does not exist/, r.stderr);
    assert.doesNotMatch(r.stderr, /\n\s+at /, "no stack trace");
  }
});
