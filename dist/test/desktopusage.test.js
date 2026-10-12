/** Desktop chat tool use, read from Desktop's own MCP server log. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeDesktopUsage, desktopUsage } from "../desktopusage.js";
const line = (day, method) => `${day}T10:00:00.000Z [context-doctor] [info] Message from client: method="${method}" id=1 params { metadata: undefined }`;
test("counts launches, listings and calls, with the date of the last call", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-desk-"));
    writeFileSync(join(dir, "mcp-server-context-doctor.log"), [
        line("2026-10-01", "initialize"), line("2026-10-01", "tools/list"),
        line("2026-10-02", "initialize"), line("2026-10-02", "tools/list"), line("2026-10-03", "tools/call"),
    ].join("\n"));
    const u = desktopUsage(dir);
    assert.deepEqual(u, { launches: 2, toolLists: 2, toolCalls: 1, lastCall: "2026-10-03" });
    assert.match(describeDesktopUsage(u, 32), /called 1 time\(s\) \(last 2026-10-03\); your 32 Code-tab sessions this week use the hook instead/);
    assert.match(describeDesktopUsage(u), /context_checkup/);
});
test("no Desktop log means nothing to report", () => {
    assert.equal(desktopUsage(mkdtempSync(join(tmpdir(), "cd-desk-"))), undefined);
});
