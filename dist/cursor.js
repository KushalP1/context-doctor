/**
 * Cursor chat history: profile the conversations Cursor stores locally.
 *
 * Cursor keeps chats in SQLite (`state.vscdb`) rather than files:
 *   composerData:<composerId>  → { name, conversation: [{bubbleId, type}] }
 *   bubbleId:<composerId>:<id> → { type: 1|2, text, toolFormerData, ... }
 * Message text lives in the per-bubble rows, so a conversation is assembled by
 * walking the header list and looking up each bubble.
 *
 * Reading needs SQLite. Node 22.5+ ships `node:sqlite`; older runtimes fall
 * back to the `sqlite3` CLI when it is installed. When neither is available we
 * say so plainly instead of failing obscurely.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { join } from "node:path";
const require = createRequire(import.meta.url);
/** Cursor bubble type codes. */
const BUBBLE_USER = 1;
/** Header list for a composer record, whichever shape it uses. */
function headersOf(data) {
    if (Array.isArray(data.conversation) && data.conversation.length > 0)
        return data.conversation;
    return data.fullConversationHeadersOnly ?? [];
}
/** Cursor's per-user storage root, per platform. */
function cursorStorageDirs() {
    const home = homedir();
    const root = platform() === "darwin"
        ? join(home, "Library", "Application Support", "Cursor", "User")
        : platform() === "win32"
            ? join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Cursor", "User")
            : join(home, ".config", "Cursor", "User");
    const dirs = [];
    const global = join(root, "globalStorage");
    if (existsSync(global))
        dirs.push(global);
    const ws = join(root, "workspaceStorage");
    if (existsSync(ws)) {
        try {
            for (const entry of readdirSync(ws))
                dirs.push(join(ws, entry));
        }
        catch {
            /* unreadable — skip */
        }
    }
    return dirs;
}
/** Every Cursor state database on this machine, newest first. */
export function findCursorDatabases() {
    const dbs = [];
    for (const dir of cursorStorageDirs()) {
        const db = join(dir, "state.vscdb");
        if (!existsSync(db))
            continue;
        try {
            dbs.push({ path: db, mtime: statSync(db).mtimeMs });
        }
        catch {
            /* unreadable — skip */
        }
    }
    return dbs.sort((a, b) => b.mtime - a.mtime).map((d) => d.path);
}
/**
 * This runtime cannot read SQLite at all: no `node:sqlite` and no sqlite3
 * command. Distinct from one database failing, which listing skips, because
 * it applies to every database: swallowing it per database showed "No Cursor
 * chats found" with every chat still there (Node 20, and 22.5-22.12 without
 * the flag, when sqlite3 is not on PATH).
 */
export class SqliteUnavailableError extends Error {
}
/** Node's built-in SQLite, when this runtime has it (22.13+, or 22.5+ with --experimental-sqlite). */
function nodeSqlite() {
    try {
        return require("node:sqlite");
    }
    catch {
        return undefined;
    }
}
/**
 * Run a read-only query against a Cursor database.
 *
 * Two hard rules learned the expensive way:
 *  - NEVER copy the file. A real Cursor history is gigabytes; snapshotting it
 *    per invocation fills the disk.
 *  - Project in SQL, not in JS. Composer rows hold megabytes of JSON each, so
 *    listing pulls only the fields it needs via json_extract.
 * SQLite allows concurrent readers, so opening the live database read-only is
 * safe while Cursor is running.
 */
export function queryRows(dbPath, sql) {
    // Preferred: Node's built-in SQLite (22.5+).
    const sqlite = nodeSqlite();
    let nodeSqliteErr;
    if (sqlite) {
        try {
            const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
            try {
                return db.prepare(sql).all();
            }
            finally {
                db.close();
            }
        }
        catch (e) {
            nodeSqliteErr = e;
        }
    }
    // Fallback: the sqlite3 CLI, if the user has it.
    try {
        const out = execFileSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
            encoding: "utf8",
            maxBuffer: 512 * 1024 * 1024,
            stdio: ["ignore", "pipe", "ignore"], // a missing table is expected on some DBs
        });
        return out.trim() ? JSON.parse(out) : [];
    }
    catch (cliErr) {
        // Neither backend exists: the same answer for every database, so say it once.
        if (!sqlite && cliErr.code === "ENOENT") {
            throw new SqliteUnavailableError("reading Cursor chats needs SQLite: Node 22.13+ (built-in; 22.5+ with --experimental-sqlite) or the sqlite3 command. " +
                "Neither is available here.");
        }
        // A backend ran and this database failed (no such table, locked, corrupt).
        throw new Error(`${dbPath}: ${(nodeSqliteErr ?? cliErr).message}`);
    }
}
/** List Cursor chats, biggest first. */
export function listCursorChats(limit = 20) {
    const chats = [];
    for (const dbPath of findCursorDatabases()) {
        let rows;
        try {
            // json_extract keeps megabyte-sized composer blobs in the database.
            rows = queryRows(dbPath, "SELECT key, json_extract(value, '$.name') AS name, " +
                "COALESCE(json_array_length(value, '$.fullConversationHeadersOnly'), " +
                "json_array_length(value, '$.conversation'), 0) AS n " +
                // json_valid is not optional: SQLite's JSON functions raise on
                // malformed input, and one non-JSON row under a composerData: key
                // aborts the WHOLE query. cursorDiskKV is a general-purpose store,
                // so that row exists sooner or later — and the user then sees
                // "No Cursor chats found" with every real chat sitting right there.
                "FROM cursorDiskKV WHERE key LIKE 'composerData:%' AND json_valid(value)");
        }
        catch (e) {
            // No SQLite at all fails every database alike: report it (the CLI says
            // what to install) instead of "No Cursor chats found".
            if (e instanceof SqliteUnavailableError)
                throw e;
            continue; // no composer table (older Cursor), or this database is unreadable — skip
        }
        for (const row of rows) {
            const count = Number(row.n ?? 0);
            if (count === 0)
                continue;
            chats.push({
                composerId: String(row.key).slice("composerData:".length),
                title: row.name == null ? undefined : String(row.name),
                dbPath,
                messageCount: count,
            });
        }
    }
    return chats.sort((a, b) => b.messageCount - a.messageCount).slice(0, limit);
}
function safeParse(raw) {
    if (typeof raw !== "string")
        return raw ?? {};
    try {
        return JSON.parse(raw);
    }
    catch {
        return raw;
    }
}
function stringify(value) {
    return typeof value === "string" ? value : JSON.stringify(value ?? "");
}
/**
 * Assemble one Cursor chat into a conversation this tool can profile.
 * Tool calls are folded in as tool_use/tool_result blocks so the profiler's
 * tool-result findings apply to Cursor chats exactly as they do elsewhere.
 */
export function parseCursorChat(chat) {
    const id = chat.composerId.replace(/[^a-zA-Z0-9-]/g, "");
    const header = queryRows(chat.dbPath, `SELECT value FROM cursorDiskKV WHERE key = 'composerData:${id}'`)[0];
    const record = header ? JSON.parse(String(header.value)) : {};
    const conversation = headersOf(record);
    const bubbleRows = queryRows(chat.dbPath, `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:${id}:%'`);
    const byId = new Map();
    for (const row of bubbleRows) {
        try {
            byId.set(String(row.key).split(":").pop() ?? "", JSON.parse(String(row.value)));
        }
        catch {
            /* malformed bubble — skip */
        }
    }
    const messages = [];
    for (const entry of conversation) {
        // Legacy entries carry their own text; modern ones point at a bubble row.
        const bubble = (entry.bubbleId ? byId.get(entry.bubbleId) : undefined) ?? entry;
        const role = (bubble.type ?? entry.type) === BUBBLE_USER ? "user" : "assistant";
        const text = typeof bubble.text === "string" ? bubble.text : "";
        const tool = bubble.toolFormerData;
        if (tool && (tool.name || tool.rawArgs || tool.result)) {
            if (text)
                messages.push({ role, content: text });
            messages.push({
                role: "assistant",
                content: [{ type: "tool_use", id: entry.bubbleId ?? "tool", name: String(tool.name ?? "tool"), input: safeParse(tool.rawArgs) }],
            });
            if (tool.result !== undefined) {
                messages.push({
                    role: "user",
                    content: [{ type: "tool_result", tool_use_id: entry.bubbleId ?? "tool", content: stringify(tool.result) }],
                });
            }
            continue;
        }
        if (!text)
            continue;
        messages.push({ role, content: text });
    }
    return {
        conversationJson: JSON.stringify({ messages }),
        title: chat.title,
        // Cursor does not record the model per chat in a stable place; leaving it
        // unset keeps window/cost math honest rather than guessed.
        messageCount: messages.length,
        path: `${chat.dbPath}#${chat.composerId}`,
    };
}
