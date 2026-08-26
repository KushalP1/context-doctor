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
import type { ParsedSession } from "./session.js";
export interface CursorChat {
    composerId: string;
    title?: string;
    dbPath: string;
    messageCount: number;
}
/** Every Cursor state database on this machine, newest first. */
export declare function findCursorDatabases(): string[];
interface Row {
    [column: string]: string | number | null;
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
export declare function queryRows(dbPath: string, sql: string): Row[];
/** List Cursor chats, biggest first. */
export declare function listCursorChats(limit?: number): CursorChat[];
/**
 * Assemble one Cursor chat into a conversation this tool can profile.
 * Tool calls are folded in as tool_use/tool_result blocks so the profiler's
 * tool-result findings apply to Cursor chats exactly as they do elsewhere.
 */
export declare function parseCursorChat(chat: CursorChat): ParsedSession;
export {};
