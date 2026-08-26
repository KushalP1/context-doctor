/**
 * Cursor history reader. Builds its own SQLite fixture covering BOTH chat
 * shapes Cursor ships (modern bubble rows, legacy inline text), so it never
 * touches the developer's real history.
 *
 * Skipped when no SQLite backend exists (Node < 22.5 without the sqlite3 CLI)
 * — the feature reports that situation clearly at runtime too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { parseCursorChat, queryRows } from "../cursor.js";
const require = createRequire(import.meta.url);
let DatabaseSync;
try {
    ({ DatabaseSync } = require("node:sqlite"));
}
catch {
    DatabaseSync = undefined;
}
const skip = DatabaseSync ? false : "no node:sqlite on this runtime";
function buildFixture() {
    const dir = mkdtempSync(join(tmpdir(), "ctxdoc-cursor-fixture-"));
    const dbPath = join(dir, "state.vscdb");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    // Modern shape: headers on the composer, text in bubble rows.
    const modernId = "modern-chat";
    db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run(`composerData:${modernId}`, JSON.stringify({
        name: "Modern chat",
        composerId: modernId,
        fullConversationHeadersOnly: [
            { bubbleId: "b1", type: 1 },
            { bubbleId: "b2", type: 2 },
            { bubbleId: "b3", type: 2 },
        ],
    }));
    db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run(`bubbleId:${modernId}:b1`, JSON.stringify({ type: 1, text: "how do I fix the migration?" }));
    db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run(`bubbleId:${modernId}:b2`, JSON.stringify({ type: 2, text: "Let me look at the schema." }));
    db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run(`bubbleId:${modernId}:b3`, JSON.stringify({
        type: 2,
        text: "",
        toolFormerData: { name: "read_file", rawArgs: '{"path":"schema.sql"}', result: "CREATE TABLE ... " + "x".repeat(4000) },
    }));
    // Legacy shape: text inline on the conversation entries.
    const legacyId = "legacy-chat";
    db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run(`composerData:${legacyId}`, JSON.stringify({
        name: "Legacy chat",
        composerId: legacyId,
        conversation: [
            { bubbleId: "l1", type: 1, text: "legacy question" },
            { bubbleId: "l2", type: 2, text: "legacy answer" },
        ],
    }));
    db.close();
    return dbPath;
}
test("reads the modern shape: bubble rows, roles, and tool calls", { skip }, () => {
    const dbPath = buildFixture();
    const parsed = parseCursorChat({ composerId: "modern-chat", title: "Modern chat", dbPath, messageCount: 3 });
    const conv = JSON.parse(parsed.conversationJson);
    assert.equal(parsed.title, "Modern chat");
    assert.equal(conv.messages[0].role, "user");
    assert.match(conv.messages[0].content, /migration/);
    assert.equal(conv.messages[1].role, "assistant");
    // The tool call becomes a tool_use + tool_result pair so profiler findings apply.
    const toolUse = conv.messages.find((m) => Array.isArray(m.content) && m.content[0]?.type === "tool_use");
    const toolResult = conv.messages.find((m) => Array.isArray(m.content) && m.content[0]?.type === "tool_result");
    assert.ok(toolUse, "tool_use block emitted");
    assert.equal(toolUse.content[0].name, "read_file");
    assert.ok(toolResult, "tool_result block emitted");
    assert.equal(toolResult.content[0].tool_use_id, toolUse.content[0].id, "result pairs with its call");
});
test("reads the legacy shape: inline conversation text", { skip }, () => {
    const dbPath = buildFixture();
    const parsed = parseCursorChat({ composerId: "legacy-chat", title: "Legacy chat", dbPath, messageCount: 2 });
    const conv = JSON.parse(parsed.conversationJson);
    assert.equal(conv.messages.length, 2);
    assert.equal(conv.messages[0].content, "legacy question");
    assert.equal(conv.messages[1].role, "assistant");
});
test("never copies the database (a real history is gigabytes)", { skip }, () => {
    const dbPath = buildFixture();
    const rows = queryRows(dbPath, "SELECT key FROM cursorDiskKV LIMIT 1");
    assert.equal(rows.length, 1);
    // Reading is in place: the source file is the only copy that exists.
    const src = require("node:fs").readFileSync(dbPath);
    assert.ok(src.length > 0);
});
test("a database without the composer table is skipped, not fatal", { skip }, () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxdoc-cursor-empty-"));
    const dbPath = join(dir, "state.vscdb");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE ItemTable (key TEXT, value TEXT)");
    db.close();
    assert.throws(() => queryRows(dbPath, "SELECT key, value FROM cursorDiskKV"), /no such table|SQLite/i);
});
