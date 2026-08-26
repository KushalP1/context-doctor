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
import type { ParsedSession } from "./session.js";

const require = createRequire(import.meta.url);

/** Cursor bubble type codes. */
const BUBBLE_USER = 1;

/**
 * Cursor has shipped two chat shapes. Newer builds store per-message rows and
 * keep only headers on the composer; older ones inline the text. Both appear
 * on the same machine, so both are read.
 */
interface ComposerRecord {
  name?: string;
  composerId?: string;
  /** Legacy: entries carry their own text. */
  conversation?: Array<{ bubbleId?: string; type?: number; text?: string; toolFormerData?: unknown }>;
  /** Modern: headers only; text lives in bubbleId:<composer>:<bubble> rows. */
  fullConversationHeadersOnly?: Array<{ bubbleId: string; type: number }>;
}

/** Header list for a composer record, whichever shape it uses. */
function headersOf(data: ComposerRecord): Array<{ bubbleId?: string; type?: number; text?: string; toolFormerData?: unknown }> {
  if (Array.isArray(data.conversation) && data.conversation.length > 0) return data.conversation;
  return data.fullConversationHeadersOnly ?? [];
}

export interface CursorChat {
  composerId: string;
  title?: string;
  dbPath: string;
  messageCount: number;
}

/** Cursor's per-user storage root, per platform. */
function cursorStorageDirs(): string[] {
  const home = homedir();
  const root =
    platform() === "darwin"
      ? join(home, "Library", "Application Support", "Cursor", "User")
      : platform() === "win32"
        ? join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Cursor", "User")
        : join(home, ".config", "Cursor", "User");
  const dirs: string[] = [];
  const global = join(root, "globalStorage");
  if (existsSync(global)) dirs.push(global);
  const ws = join(root, "workspaceStorage");
  if (existsSync(ws)) {
    try {
      for (const entry of readdirSync(ws)) dirs.push(join(ws, entry));
    } catch {
      /* unreadable — skip */
    }
  }
  return dirs;
}

/** Every Cursor state database on this machine, newest first. */
export function findCursorDatabases(): string[] {
  const dbs: Array<{ path: string; mtime: number }> = [];
  for (const dir of cursorStorageDirs()) {
    const db = join(dir, "state.vscdb");
    if (!existsSync(db)) continue;
    try {
      dbs.push({ path: db, mtime: statSync(db).mtimeMs });
    } catch {
      /* unreadable — skip */
    }
  }
  return dbs.sort((a, b) => b.mtime - a.mtime).map((d) => d.path);
}

interface Row { [column: string]: string | number | null }

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
export function queryRows(dbPath: string, sql: string): Row[] {
  try {
    // Preferred: Node's built-in SQLite (22.5+).
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string, o?: unknown) => any };
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare(sql).all() as Row[];
    } finally {
      db.close();
    }
  } catch (nodeSqliteErr) {
    // Fallback: the sqlite3 CLI, if the user has it.
    try {
      const out = execFileSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
        encoding: "utf8",
        maxBuffer: 512 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"], // a missing table is expected on some DBs
      });
      return out.trim() ? (JSON.parse(out) as Row[]) : [];
    } catch {
      throw new Error(
        "reading Cursor chats needs SQLite: Node 22.5+ (built-in) or the sqlite3 command. " +
          `Neither worked here (${(nodeSqliteErr as Error).message}).`
      );
    }
  }
}

/** List Cursor chats, biggest first. */
export function listCursorChats(limit = 20): CursorChat[] {
  const chats: CursorChat[] = [];
  for (const dbPath of findCursorDatabases()) {
    let rows: Row[];
    try {
      // json_extract keeps megabyte-sized composer blobs in the database.
      rows = queryRows(
        dbPath,
        "SELECT key, json_extract(value, '$.name') AS name, " +
          "COALESCE(json_array_length(value, '$.fullConversationHeadersOnly'), " +
          "json_array_length(value, '$.conversation'), 0) AS n " +
          "FROM cursorDiskKV WHERE key LIKE 'composerData:%'"
      );
    } catch {
      continue; // no composer table (older Cursor) or no SQLite — skip
    }
    for (const row of rows) {
      const count = Number(row.n ?? 0);
      if (count === 0) continue;
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

function safeParse(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

/**
 * Assemble one Cursor chat into a conversation this tool can profile.
 * Tool calls are folded in as tool_use/tool_result blocks so the profiler's
 * tool-result findings apply to Cursor chats exactly as they do elsewhere.
 */
export function parseCursorChat(chat: CursorChat): ParsedSession {
  const id = chat.composerId.replace(/[^a-zA-Z0-9-]/g, "");
  const header = queryRows(chat.dbPath, `SELECT value FROM cursorDiskKV WHERE key = 'composerData:${id}'`)[0];
  const record: ComposerRecord = header ? (JSON.parse(String(header.value)) as ComposerRecord) : {};
  const conversation = headersOf(record);

  const bubbleRows = queryRows(chat.dbPath, `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:${id}:%'`);
  const byId = new Map<string, any>();
  for (const row of bubbleRows) {
    try {
      byId.set(String(row.key).split(":").pop() ?? "", JSON.parse(String(row.value)));
    } catch {
      /* malformed bubble — skip */
    }
  }

  const messages: Array<{ role: string; content: unknown }> = [];
  for (const entry of conversation) {
    // Legacy entries carry their own text; modern ones point at a bubble row.
    const bubble = (entry.bubbleId ? byId.get(entry.bubbleId) : undefined) ?? entry;
    const role = (bubble.type ?? entry.type) === BUBBLE_USER ? "user" : "assistant";
    const text = typeof bubble.text === "string" ? bubble.text : "";
    const tool = bubble.toolFormerData as { name?: string; rawArgs?: unknown; result?: unknown } | undefined;

    if (tool && (tool.name || tool.rawArgs || tool.result)) {
      if (text) messages.push({ role, content: text });
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
    if (!text) continue;
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
