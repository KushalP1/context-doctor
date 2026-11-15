/**
 * Cline's record of what it sent. Checked 2026-11-15 against ccusage's Cline
 * loader (rust/adapters/cline) and its docs:
 *
 *  - The editor extension keeps each task in its `globalStorage` folder
 *    (`saoudrizwan.claude-dev`, under VS Code, VS Code Insiders, Cursor,
 *    Windsurf or VSCodium): `tasks/<task>/ui_messages.json`, a JSON array.
 *    A request is a `say: "api_req_started"` message whose `text` is JSON
 *    with `tokensIn` (uncached), `tokensOut`, `cacheReads`, `cacheWrites`;
 *    its model is `modelInfo.modelId`. One marked `partial` is still being
 *    written; `deleted_api_reqs` and `subagent_usage` are roll-ups of
 *    requests counted elsewhere: none is counted.
 *  - Older Cline CLI versions keep tasks the same way in `~/.cline/data/tasks`.
 *  - The Cline CLI keeps sessions in `~/.cline/data/sessions/<id>/<id>.messages.json`:
 *    assistant messages with `modelInfo.id` and `metrics` (`inputTokens`
 *    including both cache counts, `outputTokens`, `cacheReadTokens`,
 *    `cacheWriteTokens`).
 *
 * `CLINE_DATA_DIR` (a comma list) replaces the places searched. A request
 * from an older extension with no `modelInfo` takes the task's model at that
 * time from `task_metadata.json` (`model_usage`), else is counted unpriced.
 * The folder a task ran in is `cwdOnTaskInitialization` in the extension's
 * `state/taskHistory.json`, when that file is there. Nothing else is read:
 * the `text` of a request also holds the prompt, which is never kept.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One Cline request. */
export interface ClineCall {
  ts: number;
  /** "task:<id>" (the extension, the older CLI) or "cli:<id>" (a CLI session). */
  session: string;
  model?: string;
  input: number;
  read: number;
  write: number;
  output: number;
  cwd?: string;
}

const EDITORS = ["Code", "Code - Insiders", "Cursor", "Windsurf", "VSCodium"];

/** Every folder Cline may keep data in, those that exist. Each OS's spot is checked on every OS, as the files may have been copied. */
export function clineRoots(home = homedir()): string[] {
  const own = home === homedir();
  if (own && process.env.CLINE_DATA_DIR) return process.env.CLINE_DATA_DIR.split(",").map((s) => s.trim()).filter((s) => s && existsSync(s));
  const bases = [
    join(home, "Library", "Application Support"),
    own && process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : join(home, ".config"),
    own && process.env.APPDATA ? process.env.APPDATA : join(home, "AppData", "Roaming"),
  ];
  const roots = [...new Set(bases)].flatMap((b) => EDITORS.map((e) => join(b, e, "User", "globalStorage", "saoudrizwan.claude-dev")));
  roots.push(join(home, ".cline"));
  return roots.filter((r) => existsSync(r));
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const isUnknown = (m: string | undefined) => !m || m.toLowerCase() === "unknown";

function readJson(file: string): any {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}
function list(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
function newer(file: string, since: number): boolean {
  try { return statSync(file).mtimeMs >= since; } catch { return false; }
}

/** The extension's task folders: task id to the folder it started in. */
function taskFolders(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const h = readJson(join(root, "state", "taskHistory.json"));
  for (const t of Array.isArray(h) ? h : []) if (text(t?.id) && text(t?.cwdOnTaskInitialization)) out.set(t.id, t.cwdOnTaskInitialization);
  return out;
}

/** One task's requests (ui_messages.json). */
function taskCalls(dir: string, id: string, cwd: string | undefined): ClineCall[] {
  const msgs = readJson(join(dir, "ui_messages.json"));
  if (!Array.isArray(msgs)) return [];
  // The model in use at each time, for a request that does not name its own.
  const meta = readJson(join(dir, "task_metadata.json"));
  const uses = (Array.isArray(meta?.model_usage) ? meta.model_usage : []).filter((u: any) => typeof u?.ts === "number" && text(u?.model_id)).sort((a: any, b: any) => a.ts - b.ts);
  const out: ClineCall[] = [];
  for (const m of msgs) {
    if (m?.type !== "say" || m.say !== "api_req_started" || m.partial === true || typeof m.ts !== "number" || typeof m.text !== "string") continue;
    let t: any;
    try { t = JSON.parse(m.text); } catch { continue; }
    if (typeof t?.tokensIn !== "number" || typeof t?.tokensOut !== "number") continue;
    const c: ClineCall = { ts: m.ts, session: `task:${id}`, input: count(t.tokensIn), read: count(t.cacheReads), write: count(t.cacheWrites), output: count(t.tokensOut) };
    if (c.input + c.read + c.write + c.output === 0) continue;
    let model = text(m.modelInfo?.modelId);
    if (isUnknown(model)) model = text([...uses].reverse().find((u: any) => u.ts <= m.ts)?.model_id);
    if (!isUnknown(model)) c.model = model;
    if (cwd) c.cwd = cwd;
    out.push(c);
  }
  return out;
}

/** One CLI session's requests (<id>.messages.json). */
function sessionCalls(file: string, id: string): ClineCall[] {
  const doc = readJson(file);
  const msgs = Array.isArray(doc?.messages) ? doc.messages : [];
  const cwd = text(doc?.cwd) ?? text(doc?.workspaceRoot);
  const out: ClineCall[] = [];
  for (const m of msgs) {
    if (m?.role !== "assistant" || !m.metrics || typeof m.metrics !== "object") continue;
    const ts = typeof m.ts === "number" ? m.ts : Date.parse(String(m.timestamp ?? ""));
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const x = m.metrics;
    if (typeof x.inputTokens !== "number" || typeof x.outputTokens !== "number") continue;
    const read = count(x.cacheReadTokens), write = count(x.cacheWriteTokens);
    const c: ClineCall = { ts, session: `cli:${id}`, input: Math.max(0, count(x.inputTokens) - read - write), read, write, output: count(x.outputTokens) };
    if (c.input + c.read + c.write + c.output === 0) continue;
    const model = text(m.modelInfo?.id);
    if (!isUnknown(model)) c.model = model;
    if (cwd) c.cwd = cwd;
    out.push(c);
  }
  return out;
}

/** Every Cline request between `since` and `until`, from every place it keeps data. A file that cannot be read is skipped. */
export function clineCalls(since: number, until = Infinity, home = homedir()): ClineCall[] {
  const out: ClineCall[] = [];
  const seen = new Set<string>();
  const keep = (cs: ClineCall[]) => {
    for (const c of cs) {
      const k = `${c.session}\u0000${c.ts}\u0000${c.input}\u0000${c.output}`;
      if (c.ts < since || c.ts > until || seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
  };
  for (const root of clineRoots(home)) {
    const folders = taskFolders(root);
    for (const tasks of [join(root, "tasks"), join(root, "data", "tasks")]) {
      for (const id of list(tasks)) {
        const dir = join(tasks, id);
        if (newer(join(dir, "ui_messages.json"), since)) keep(taskCalls(dir, id, folders.get(id)));
      }
    }
    for (const sessions of [join(root, "sessions"), join(root, "data", "sessions")]) {
      for (const id of list(sessions)) {
        const file = join(sessions, id, `${id}.messages.json`);
        if (newer(file, since)) keep(sessionCalls(file, id));
      }
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}
