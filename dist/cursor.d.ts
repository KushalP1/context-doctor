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
 * This runtime cannot read SQLite at all: no `node:sqlite` and no sqlite3
 * command. Distinct from one database failing, which listing skips, because
 * it applies to every database: swallowing it per database showed "No Cursor
 * chats found" with every chat still there (Node 20, and 22.5-22.12 without
 * the flag, when sqlite3 is not on PATH).
 */
export declare class SqliteUnavailableError extends Error {
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
/**
 * One Cursor agent reply that recorded its tokens (`tokenCount` on the
 * bubble). Cursor keeps the prompt's size and the reply's, with no cache
 * split and no price; the model is the chat's (`modelConfig.modelName`,
 * "default" for Auto) unless the reply names its own.
 */
export interface CursorReply {
    ts: number;
    input: number;
    output: number;
    model?: string;
    composerId: string;
    /** The workspace folder the chat belongs to, when Cursor recorded one. */
    folder?: string;
}
/**
 * The Claude id a Cursor model name stands for, so it gets that version's
 * list price rather than its family's: Cursor puts the version first and
 * adds its own modes ("claude-4.6-opus-high-thinking" is claude-opus-4-6,
 * "claude-3.7-sonnet" claude-3-7-sonnet). Thinking and effort levels bill as
 * output at the same rates. Undefined for anything else, and for a "fast"
 * variant, which Anthropic bills at a premium of its own (left to the
 * family's price, an estimate).
 */
export declare function cursorClaudeId(name: string | undefined): string | undefined;
/**
 * Every Cursor reply with token counts since `since`. Only chats updated
 * since then are read, each by its key range (on the author's 3 GB history
 * the chat list takes ~0.1 s, one chat's replies ~40 ms), and each chat's
 * replies are kept until it changes, so a second run reads none of them
 * again. Throws SqliteUnavailableError when this runtime cannot read SQLite.
 */
export declare function cursorUsage(since: number): CursorReply[];
export {};
