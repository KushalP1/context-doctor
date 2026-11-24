/**
 * Which MCP servers Claude Code hands context-doctor's mod, and how
 * (ROADMAP H3): the evidence `fix`'s desktop-tools-defer and `doctor` read
 * before anyone applies the lever.
 *
 * The mod's `tool.describe` hook (Claude Code 2.1.326+) sees each tool once
 * per session with its server's transport (`mcpServer.type`) and whether the
 * engine already lists it behind tool search (`isDeferred`). It keeps that in
 * memory, per server, and hands it to `context-doctor mod measure` after the
 * turn (the CLI it already runs), which appends one line per session here,
 * changes only: a second measure of the same session with the same servers
 * writes nothing. The mod draws nothing and moves nothing for this; with
 * CONTEXT_DOCTOR_DEFER_MCP unset it only watches.
 *
 * `~/.claude/.context-doctor-tools.jsonl` (beside the session-cost ledger),
 * capped as that one is: past 128 KB it keeps its newest 96 KB (a line is
 * ~400 bytes: months of sessions). Off: CONTEXT_DOCTOR_NO_COST_LOG=1, as the
 * session-cost ledger.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { statePath } from "./ledger.js";
import { APP_TOOL_SERVERS } from "./mod/logic.js";

/** One server as the mod saw it in a session. */
export interface ToolServerSeen {
  server: string;
  /** `mcpServer.type`: stdio, http, sse, ws, sdk (in-process, the Desktop app's own), sse-ide, ws-ide, claudeai-proxy. */
  type: string;
  /** Its tools the engine described in that session. */
  tools: number;
  /** Every one of them came already behind tool search (the engine's own rule). */
  deferredByHost: boolean;
  /** The mod put them behind tool search (CONTEXT_DOCTOR_DEFER_MCP named the server). */
  movedByUs: boolean;
}

/** One session's servers. */
export interface ToolsLine {
  ts: number;
  sid: string;
  /** `session.start`'s surface: desktop, terminal, vscode; absent when the engine gave none. */
  surface?: string;
  servers: ToolServerSeen[];
}

export function toolsLogPath(): string {
  return join(dirname(statePath()), ".context-doctor-tools.jsonl");
}

const ROTATE_AT = 128 * 1024;
const KEEP_BYTES = 96 * 1024;
const MAX_SERVERS = 60;

const NAME = /^[A-Za-z0-9_.-]{1,80}$/;
const TYPE = /^[a-z-]{1,20}$/;

/** The servers as the mod sent them, cleaned: valid names and types only, each once, sorted by name. */
export function cleanServers(list: unknown): ToolServerSeen[] {
  if (!Array.isArray(list)) return [];
  const out = new Map<string, ToolServerSeen>();
  for (const s of list) {
    if (!s || typeof s !== "object") continue;
    const { server, type, tools, deferredByHost, movedByUs } = s as Record<string, unknown>;
    if (typeof server !== "string" || !NAME.test(server) || typeof type !== "string" || !TYPE.test(type) || out.has(server)) continue;
    const n = typeof tools === "number" && Number.isFinite(tools) && tools >= 0 ? Math.min(10_000, Math.round(tools)) : 0;
    out.set(server, { server, type, tools: n, deferredByHost: deferredByHost === true, movedByUs: movedByUs === true });
    if (out.size >= MAX_SERVERS) break;
  }
  return [...out.values()].sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : 0));
}

function parseLine(line: string): ToolsLine | undefined {
  let e: any;
  try { e = JSON.parse(line); } catch { return undefined; }
  if (!e || typeof e !== "object" || typeof e.ts !== "number" || !Number.isFinite(e.ts) || typeof e.sid !== "string") return undefined;
  const servers = cleanServers(e.servers);
  if (!servers.length) return undefined;
  return { ts: e.ts, sid: e.sid, ...(typeof e.surface === "string" && TYPE.test(e.surface) ? { surface: e.surface } : {}), servers };
}

function tail(path: string, bytes: number): string {
  const size = statSync(path).size;
  const n = Math.min(size, bytes);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Append a session's servers, unless its last line says the same (the mod
 * sends them again only when they changed, and a second window of the same
 * session may send them too). Never throws. True when a line was written.
 */
export function recordToolServers(line: { ts: number; sid: string; surface?: string; servers: unknown }, path = toolsLogPath()): boolean {
  if (!/^[\w.-]{1,100}$/.test(line.sid)) return false;
  const servers = cleanServers(line.servers);
  if (!servers.length) return false;
  const out: ToolsLine = { ts: line.ts, sid: line.sid, ...(line.surface && TYPE.test(line.surface) ? { surface: line.surface } : {}), servers };
  try {
    if (existsSync(path)) {
      let last: ToolsLine | undefined;
      for (const l of tail(path, 32 * 1024).split("\n")) {
        const p = parseLine(l);
        if (p && p.sid === out.sid) last = p;
      }
      if (last && JSON.stringify(last.servers) === JSON.stringify(out.servers)) return false;
    }
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && statSync(path).size > ROTATE_AT) {
      const text = tail(path, KEEP_BYTES);
      writeFileSync(path, text.slice(text.indexOf("\n") + 1));
    }
    appendFileSync(path, JSON.stringify(out) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** Every line since `since`, each session's last only (a session's servers grow as they connect). */
export function readToolLines(since = 0, path = toolsLogPath()): ToolsLine[] {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return []; }
  const bySid = new Map<string, ToolsLine>();
  for (const l of text.split("\n")) {
    const p = parseLine(l);
    if (p && p.ts >= since) bySid.set(p.sid, p);
  }
  return [...bySid.values()].sort((a, b) => a.ts - b.ts);
}

/** A Desktop session: the surface says so, or (no surface given) the app's own servers are in it. */
export function isDesktopLine(l: ToolsLine): boolean {
  return l.surface === "desktop" || (l.surface === undefined && l.servers.some((s) => APP_TOOL_SERVERS.includes(s.server)));
}

/** The newest Desktop session the mod recorded, or undefined. */
export function newestDesktop(lines: ToolsLine[]): ToolsLine | undefined {
  return [...lines].reverse().find(isDesktopLine);
}

const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/** "Claude_Browser (sdk, 12 tools)". */
const seenText = (s: ToolServerSeen) => `${s.server} (${s.type}, ${s.tools} tool${s.tools === 1 ? "" : "s"})`;

const list = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/**
 * What the newest Desktop session says of the servers the lever would name:
 * those that arrive whole (the setting reaches them), those Claude Code
 * already keeps behind tool search (nothing to do), those the mod was never
 * shown (the setting would not reach them). Undefined with no Desktop session
 * on record: not yet known.
 */
export interface AppToolsVerdict {
  at: number;
  reach: ToolServerSeen[];
  hostDefers: ToolServerSeen[];
  unseen: string[];
}

export function appToolsVerdict(lines: ToolsLine[], servers: readonly string[]): AppToolsVerdict | undefined {
  const d = newestDesktop(lines);
  if (!d) return undefined;
  const reach: ToolServerSeen[] = [], hostDefers: ToolServerSeen[] = [], unseen: string[] = [];
  for (const name of servers) {
    const s = d.servers.find((x) => x.server === name);
    if (!s) unseen.push(name);
    else if (s.deferredByHost) hostDefers.push(s);
    else reach.push(s);
  }
  return { at: d.ts, reach, hostDefers, unseen };
}

/** The verdict's sentences, for fix's lines. */
export function verdictLines(v: AppToolsVerdict): string[] {
  const out: string[] = [];
  const when = `your Desktop session of ${day(v.at)}`;
  if (v.reach.length) out.push(`Seen in ${when}: ${list(v.reach.map(seenText))} ${v.reach.length === 1 ? "arrives" : "arrive"} whole${v.reach.every((s) => s.type === "sdk") ? " as in-process (sdk) servers" : ""}, and Claude Code tells context-doctor's mod which server each tool is from, so this setting reaches ${v.reach.length === 1 ? "it" : "them"}.`);
  if (v.hostDefers.length) out.push(`Claude Code already keeps ${list(v.hostDefers.map((s) => s.server))} behind tool search (${when}): nothing to move there.`);
  if (v.unseen.length) out.push(`Claude Code did not show context-doctor's mod ${list(v.unseen)}'s tools in ${when}, so the setting would not reach ${v.unseen.length === 1 ? "it" : "them"} there.`);
  return out;
}

/** Sessions in which the mod moved a server's tools behind tool search, and the first of them. */
export function movedSessions(lines: ToolsLine[]): { sessions: number; since?: number; servers: string[] } {
  const moved = lines.filter((l) => l.servers.some((s) => s.movedByUs));
  const servers = [...new Set(moved.flatMap((l) => l.servers.filter((s) => s.movedByUs).map((s) => s.server)))].sort();
  return { sessions: moved.length, ...(moved.length ? { since: moved[0].ts } : {}), servers };
}

/**
 * `doctor`'s line: the servers the newest Desktop session handed the mod,
 * their type, and what desktop-tools-defer would do with them. A fact, not a
 * fault. Undefined when the mod recorded no Desktop session.
 */
export function appToolsCheckText(lines: ToolsLine[]): string | undefined {
  const d = newestDesktop(lines);
  if (!d) return undefined;
  const parts = d.servers.map((s) => `${seenText(s)}${s.movedByUs ? ", moved behind tool search by context-doctor" : s.deferredByHost ? ", behind tool search already" : ", sent whole"}`);
  const whole = d.servers.filter((s) => !s.deferredByHost && !s.movedByUs && APP_TOOL_SERVERS.includes(s.server)).map((s) => s.server);
  const moved = movedSessions(lines);
  const tail = moved.sessions
    ? `; moved behind tool search in ${moved.sessions} session${moved.sessions === 1 ? "" : "s"} since ${day(moved.since!)}`
    : whole.length
      ? `; context-doctor fix --apply desktop-tools-defer would move ${list(whole)} (it reaches them)`
      : "";
  return `your Desktop session of ${day(d.ts)} handed context-doctor's mod ${parts.join("; ")}${tail}`;
}

/** The ledger's lines of the last `days`, never throwing. */
export function recentToolLines(days = 30, now = Date.now(), path = toolsLogPath()): ToolsLine[] {
  try { return readToolLines(now - days * 86_400_000, path); } catch { return []; }
}
