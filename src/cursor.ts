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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ParsedSession } from "./session.js";
import { readSideEntry, writeSideEntry } from "./scan.js";

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
 * This runtime cannot read SQLite at all: no `node:sqlite` and no sqlite3
 * command. Distinct from one database failing, which listing skips, because
 * it applies to every database: swallowing it per database showed "No Cursor
 * chats found" with every chat still there (Node 20, and 22.5-22.12 without
 * the flag, when sqlite3 is not on PATH).
 */
export class SqliteUnavailableError extends Error {}

/** Node's built-in SQLite, when this runtime has it (22.13+, or 22.5+ with --experimental-sqlite). */
function nodeSqlite(): { DatabaseSync: new (p: string, o?: unknown) => any } | undefined {
  // Node 22-25 warns that SQLite is experimental on first load, on stderr,
  // in the middle of a report: not something the user can act on.
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning).includes("SQLite")) return;
    return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return require("node:sqlite") as { DatabaseSync: new (p: string, o?: unknown) => any };
  } catch {
    return undefined;
  } finally {
    process.emitWarning = emit;
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
export function queryRows(dbPath: string, sql: string): Row[] {
  // Preferred: Node's built-in SQLite (22.5+).
  const sqlite = nodeSqlite();
  let nodeSqliteErr: unknown;
  if (sqlite) {
    try {
      const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      try {
        return db.prepare(sql).all() as Row[];
      } finally {
        db.close();
      }
    } catch (e) {
      nodeSqliteErr = e;
    }
  }
  // Fallback: the sqlite3 CLI, if the user has it.
  const cli = (target: string) => execFileSync("sqlite3", ["-readonly", "-json", target, sql], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"], // a missing table is expected on some DBs
  });
  try {
    let out: string;
    try {
      out = cli(dbPath);
    } catch (e) {
      // macOS's own sqlite3 cannot open a WAL database read-only once its
      // -wal and -shm files are gone, which is how Cursor leaves it when it
      // quits ("unable to open database file"): every Cursor read failed
      // there on Node < 22.13. With no -wal file nothing is writing it, so
      // it is read as immutable.
      if ((e as NodeJS.ErrnoException).code === "ENOENT" || existsSync(`${dbPath}-wal`)) throw e;
      out = cli(`${pathToFileURL(dbPath).href}?immutable=1`);
    }
    return out.trim() ? (JSON.parse(out) as Row[]) : [];
  } catch (cliErr) {
    // Neither backend exists: the same answer for every database, so say it once.
    if (!sqlite && (cliErr as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SqliteUnavailableError(
        "reading Cursor chats needs SQLite: Node 22.13+ (built-in; 22.5+ with --experimental-sqlite) or the sqlite3 command. " +
          "Neither is available here."
      );
    }
    // A backend ran and this database failed (no such table, locked, corrupt).
    throw new Error(`${dbPath}: ${((nodeSqliteErr ?? cliErr) as Error).message}`);
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
          // json_valid is not optional: SQLite's JSON functions raise on
          // malformed input, and one non-JSON row under a composerData: key
          // aborts the WHOLE query. cursorDiskKV is a general-purpose store,
          // so that row exists sooner or later — and the user then sees
          // "No Cursor chats found" with every real chat sitting right there.
          "FROM cursorDiskKV WHERE key LIKE 'composerData:%' AND json_valid(value)"
      );
    } catch (e) {
      // No SQLite at all fails every database alike: report it (the CLI says
      // what to install) instead of "No Cursor chats found".
      if (e instanceof SqliteUnavailableError) throw e;
      continue; // no composer table (older Cursor), or this database is unreadable — skip
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

// ---------------------------------------------------------------------------
// Spend: the token counts on Cursor's agent replies
// ---------------------------------------------------------------------------

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

/** Kept per database: each chat's replies [ts, input, output, model], valid while its lastUpdatedAt is unchanged. */
interface CursorSpendCache { composers: Record<string, { lu: number; rows: Array<[number, number, number, string | null]> }> }

const CURSOR_SPEND = "cursor-spend.1";

/** Chat id -> workspace folder, from each workspace's own state (composer.composerData, workspace.json). */
function cursorFolders(): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of cursorStorageDirs()) {
    let folder: string | undefined;
    try {
      const f = JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8"))?.folder;
      if (typeof f === "string" && f.startsWith("file://")) folder = decodeURIComponent(f.slice("file://".length));
    } catch {
      continue; // globalStorage, or a multi-root workspace: no one folder
    }
    if (!folder || !existsSync(join(dir, "state.vscdb"))) continue;
    try {
      const row = queryRows(join(dir, "state.vscdb"), "SELECT value FROM ItemTable WHERE key = 'composer.composerData'")[0];
      const all = JSON.parse(String(row?.value ?? "{}"))?.allComposers;
      if (Array.isArray(all)) for (const c of all) if (typeof c?.composerId === "string") out.set(c.composerId, folder);
    } catch {
      /* an older or unreadable workspace database */
    }
  }
  return out;
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
export function cursorClaudeId(name: string | undefined): string | undefined {
  const m = /^claude-(\d+)(?:\.(\d{1,2}))?-(opus|sonnet|haiku|fable|mythos)((?:-[a-z0-9]+)*)$/i.exec(name ?? "");
  if (!m || /-fast\b/i.test(m[4])) return undefined;
  const [, major, minor, family] = m;
  const fam = family.toLowerCase();
  // Claude 3's ids put the version first too (claude-3-5-sonnet); from Claude 4 on, the family does.
  return Number(major) < 4
    ? `claude-${major}${minor ? `-${minor}` : ""}-${fam}`
    : `claude-${fam}-${major}${minor ? `-${minor}` : ""}`;
}

/** A time Cursor wrote: epoch ms (as a number or digits) or an ISO string. */
function cursorTime(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? (/^\d+$/.test(v) ? Number(v) : Date.parse(v)) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Every Cursor reply with token counts since `since`. Only chats updated
 * since then are read, each by its key range (on the author's 3 GB history
 * the chat list takes ~0.1 s, one chat's replies ~40 ms), and each chat's
 * replies are kept until it changes, so a second run reads none of them
 * again. Throws SqliteUnavailableError when this runtime cannot read SQLite.
 */
export function cursorUsage(since: number): CursorReply[] {
  const out: CursorReply[] = [];
  let folders: Map<string, string> | undefined;
  for (const dbPath of findCursorDatabases()) {
    let composers: Row[];
    try {
      // A key range, not LIKE: it walks the primary key's index.
      composers = queryRows(
        dbPath,
        "SELECT key, json_extract(value, '$.lastUpdatedAt') AS lu, json_extract(value, '$.createdAt') AS ca, json_extract(value, '$.modelConfig.modelName') AS mn " +
          "FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;' AND json_valid(value)"
      );
    } catch (e) {
      if (e instanceof SqliteUnavailableError) throw e;
      continue; // no chats in this database
    }
    const kept = readSideEntry<CursorSpendCache>(dbPath, CURSOR_SPEND) ?? { composers: {} };
    let changed = false;
    for (const c of composers) {
      const id = String(c.key).slice("composerData:".length);
      const lu = cursorTime(c.lu) ?? cursorTime(c.ca) ?? 0;
      if (lu < since || !/^[\w-]+$/.test(id)) continue;
      let rows = kept.composers[id]?.lu === lu ? kept.composers[id].rows : undefined;
      if (!rows) {
        rows = [];
        let bubbles: Row[] = [];
        try {
          bubbles = queryRows(
            dbPath,
            "SELECT json_extract(value, '$.tokenCount.inputTokens') AS i, json_extract(value, '$.tokenCount.outputTokens') AS o, " +
              "json_extract(value, '$.createdAt') AS ca, json_extract(value, '$.timingInfo.clientStartTime') AS cs, json_extract(value, '$.modelInfo.modelName') AS mn " +
              `FROM cursorDiskKV WHERE key >= 'bubbleId:${id}:' AND key < 'bubbleId:${id};' AND json_valid(value)`
          );
        } catch {
          /* an unreadable chat: nothing from it */
        }
        for (const b of bubbles) {
          const i = Number(b.i) > 0 ? Number(b.i) : 0, o = Number(b.o) > 0 ? Number(b.o) : 0;
          if (i + o === 0) continue;
          // A reply without a time of its own is placed at the chat's last update.
          rows.push([cursorTime(b.ca) ?? cursorTime(b.cs) ?? lu, i, o, typeof b.mn === "string" && b.mn ? b.mn : null]);
        }
        kept.composers[id] = { lu, rows };
        changed = true;
      }
      if (rows.length && !folders) folders = cursorFolders();
      const chatModel = typeof c.mn === "string" && c.mn ? c.mn : undefined;
      for (const [ts, input, output, mn] of rows) {
        if (ts < since) continue;
        const r: CursorReply = { ts, input, output, composerId: id };
        const model = mn ?? chatModel;
        if (model) r.model = model;
        const folder = folders?.get(id);
        if (folder) r.folder = folder;
        out.push(r);
      }
    }
    if (changed) writeSideEntry(dbPath, CURSOR_SPEND, kept);
  }
  return out.sort((a, b) => a.ts - b.ts);
}
