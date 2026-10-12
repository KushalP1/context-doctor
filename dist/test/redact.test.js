/** `--redact`: no file names, paths or subagent briefs in a report meant for pasting. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConversation } from "../parse.js";
import { profileConversation } from "../profile.js";
import { renderProfile } from "../report.js";
import { renderSubagents, subagentReport } from "../subagents.js";
test("a finding that names a file by its bare name does not leak it, whatever its type", () => {
    const messages = [];
    for (let i = 0; i < 3; i++) {
        messages.push({ role: "assistant", content: [{ type: "tool_use", id: `r${i}`, name: "Read", input: { file_path: "/Users/me/Documents/Q3-layoffs-draft.docx" } }] });
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `r${i}`, content: "Confidential. ".repeat(300) }] });
    }
    const profile = profileConversation(parseConversation(JSON.stringify({ messages })), "claude-opus-5-5");
    assert.ok(renderProfile(profile).includes("Q3-layoffs-draft.docx was read 3 times"), "the finding names the file");
    const redacted = renderProfile(profile, { redact: true });
    assert.ok(!redacted.includes("Q3-layoffs"), redacted);
    assert.ok(!redacted.includes("Documents"));
    assert.match(redacted, /\[file\] was read 3 times/);
    assert.match(redacted, /tokens/, "figures stay");
});
test("renderSubagents with redact hides each subagent's brief", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-redact-subs-"));
    const transcript = join(dir, "s.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
    mkdirSync(join(dir, "s", "subagents"), { recursive: true });
    writeFileSync(join(dir, "s", "subagents", "agent-a.jsonl"), [
        { type: "user", isSidechain: true, timestamp: "2026-10-01T10:00:00.000Z", message: { role: "user", content: "Draft the termination letters for the Q3 layoffs" } },
        { type: "assistant", isSidechain: true, timestamp: "2026-10-01T10:01:00.000Z", message: { id: "m1", role: "assistant", model: "claude-haiku-4-5", content: "x", usage: { input_tokens: 5_000, output_tokens: 10 } } },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const report = subagentReport(transcript);
    assert.match(renderSubagents(report) ?? "", /termination letters/);
    const redacted = renderSubagents(report, undefined, 5, { redact: true }) ?? "";
    assert.ok(!redacted.includes("termination"), redacted);
    assert.match(redacted, /\[redacted\]/);
    assert.match(redacted, /1 subagent\(s\) made 1 API calls/, "the numbers stay");
});
