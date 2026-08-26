/** watch: emits a status line on growth, surfaces new findings once. */
import { test } from "node:test";
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
function line(role, content) {
    return JSON.stringify({ type: role, message: { role, content } }) + "\n";
}
test("watch reports growth and new findings live", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxdoc-watch-"));
    const file = join(dir, "trace.jsonl");
    writeFileSync(file, line("user", "hello there"));
    const child = spawn(process.execPath, [cliPath, "watch", file, "--interval-ms", "150"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    // Wait for a condition rather than sleeping a fixed time: fixed sleeps make
    // this test flaky under parallel load (it fails in the full suite while
    // passing alone), and a deadline is both faster and deterministic.
    const waitFor = async (predicate, what, deadlineMs = 10_000) => {
        const start = Date.now();
        while (Date.now() - start < deadlineMs) {
            if (predicate())
                return;
            await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(`timed out waiting for ${what}; output so far:\n${out}`);
    };
    try {
        // First tick: initial line.
        await waitFor(() => /tokens/.test(out), "the initial status line");
        // Grow the file with an oversized tool result → new status + a finding.
        appendFileSync(file, line("assistant", JSON.stringify([{ type: "tool_use", id: "t1", name: "search", input: {} }])) +
            JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "data ".repeat(3000) }] } }) +
            "\n");
        await waitFor(() => out.split("\n").filter((l) => l.includes("tokens")).length >= 2, "a second status line after growth");
        await waitFor(() => out.includes("⚠"), "a finding to surface");
    }
    finally {
        child.kill();
    }
});
