/**
 * GitHub Copilot CLI's own record of what it sent: `session.usage_record`
 * events in `~/.copilot/session-state/<session>/events.jsonl` (or
 * `$COPILOT_HOME`), one per model call. Checked 2026-11-15 against the
 * readers that parse them (GitHub's own agent-radar collector in
 * github/awesome-copilot, qualitylayer, tokscale, agentsview) and
 * ccusage#2069 (1,142 records and no shutdown in one user's sessions).
 * GitHub documents none of it; the shape:
 *
 *   {"type":"session.usage_record","id":"…","timestamp":"…","data":{"usage":{
 *     "model":"claude-opus-4.6-1m","inputTokens":…,"outputTokens":…,
 *     "cacheReadTokens":…,"cacheWriteTokens":…,"reasoningTokens":…,
 *     "cost":1,"duration":…,"apiCallId":"…","isByok":false,
 *     "accounting":{"sourceSessionId":"…","usageId":"…"},
 *     "copilotUsage":{"totalNanoAiu":…}}}}
 *
 * - `inputTokens` holds the cached tokens too (read and written): the
 *   uncached input is what is left after both.
 * - `reasoningTokens` is part of `outputTokens`, not added again.
 * - `cost` is the request's premium-request multiplier (1, or 14 for a
 *   premium model), not dollars. `copilotUsage.totalNanoAiu` is the AI
 *   credits it used, in billionths: one credit is $0.01.
 * - The same call can be written twice (Copilot CLI 1.0.108: "count each
 *   newly recorded model call once, even when its usage event is received
 *   again"): one call is its accounting id, else its API call id, else the
 *   event's id.
 * - A compaction (`session.compaction_complete`, `compactionTokensUsed`) is
 *   a model call of its own, unless a usage record already names its
 *   request.
 * - Where it ran: `session.start` (and `session.resume`) carry
 *   `data.context` with `cwd`, `gitRoot`, `branch` and `repository`.
 *
 * Sessions from Copilot CLI versions that write no usage records (only
 * cumulative `session.shutdown` totals) are not read: their per-resume
 * figures cannot be told apart reliably (ccusage's notes on it run a page).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pick, rowsOf, type Extractor } from "./scan.js";

/** One Copilot CLI model call, as the session recorded it. */
export interface CopilotCall {
  ts: number;
  session: string;
  /** The model as Copilot named it, less the context-size suffix ("-1m") and a BYOK provider's id. */
  model: string;
  /** Uncached input (inputTokens less both cache counts). */
  input: number;
  read: number;
  write: number;
  output: number;
  /** AI credits it used (totalNanoAiu / 1e9); absent when the record has none. */
  credits?: number;
  /** Premium requests it counted (the legacy `cost` multiplier); absent when the record has none. */
  premium?: number;
  /** Billed to the user's own key (BYOK), not the Copilot plan. */
  byok?: boolean;
  /** Where the session ran, from session.start's context. */
  cwd?: string;
  gitRoot?: string;
  branch?: string;
}

/** Copilot's home: $COPILOT_HOME when set (and `home` is this user's), else <home>/.copilot. */
export function copilotDataDir(home = homedir()): string {
  return home === homedir() && process.env.COPILOT_HOME ? process.env.COPILOT_HOME : join(home, ".copilot");
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** "claude-opus-4.6-1m" -> "claude-opus-4.6"; "<provider uuid>/gpt-x" -> "gpt-x". */
export function copilotModel(raw: string): string {
  return raw.replace(/^[0-9a-f]{8}-[0-9a-f-]{27}\//i, "").replace(/-1m(?:-internal)?$/i, "");
}

/**
 * What `spend` takes from a Copilot CLI session: each usage record's
 * numbers and ids, each compaction's, and each start's context. No message
 * text, no tool call.
 */
export const COPILOT_USAGE_ROWS: Extractor<Record<string, never>> = {
  id: "copilot-usage.1",
  init: () => ({}),
  line(line, row, out) {
    if (!line.includes('"session.usage_record"') && !line.includes('"session.compaction_complete"') && !line.includes('"session.start"') && !line.includes('"session.resume"')) return;
    let e: Record<string, any>;
    try { e = row(); } catch { return; }
    const d = e?.data;
    if (!d || typeof d !== "object") return;
    if (e.type === "session.start" || e.type === "session.resume") {
      const c = d.context;
      if (c && typeof c === "object") out.push({ k: "ctx", ...pick(c, ["cwd", "gitRoot", "branch", "repository"]) });
      return;
    }
    const ts = typeof e.timestamp === "string" ? e.timestamp : "";
    if (e.type === "session.usage_record") {
      const u = d.usage;
      if (!u || typeof u !== "object") return;
      const acc = u.accounting && typeof u.accounting === "object" ? u.accounting : {};
      out.push({
        k: "u", ts, ...(typeof e.id === "string" ? { id: e.id } : {}),
        ...pick(u, ["model", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "cost", "apiCallId", "isByok"]),
        ...(text(acc.sourceSessionId) && text(acc.usageId) ? { acc: `${acc.sourceSessionId}\u0000${acc.usageId}`, usageId: acc.usageId } : {}),
        ...(typeof u.copilotUsage?.totalNanoAiu === "number" ? { nano: u.copilotUsage.totalNanoAiu } : {}),
        ...(u.provider && typeof u.provider === "object" && typeof u.provider.kind === "string" ? { provider: u.provider.kind } : {}),
      });
      return;
    }
    if (e.type === "session.compaction_complete" && d.compactionTokensUsed && typeof d.compactionTokensUsed === "object") {
      const u = d.compactionTokensUsed;
      out.push({
        k: "c", ts, ...(typeof e.id === "string" ? { id: e.id } : {}), ...(text(d.requestId) ? { requestId: d.requestId } : {}),
        ...(text(d.behaviorModelId) ? { behavior: d.behaviorModelId } : {}),
        ...pick(u, ["model", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]),
        ...(typeof u.copilotUsage?.totalNanoAiu === "number" ? { nano: u.copilotUsage.totalNanoAiu } : {}),
      });
    }
  },
};

/** A record's call, priced by nobody yet. */
function call(r: Record<string, any>, session: string, ctx: Record<string, string>): CopilotCall | undefined {
  const ts = Date.parse(r.ts);
  const model = text(r.model) ?? text(r.behavior);
  if (!Number.isFinite(ts)) return undefined;
  const read = num(r.cacheReadTokens), write = num(r.cacheWriteTokens);
  const c: CopilotCall = { ts, session, model: model ? copilotModel(model) : "unknown", input: Math.max(0, num(r.inputTokens) - read - write), read, write, output: num(r.outputTokens) };
  if (c.input + c.read + c.write + c.output === 0 && !num(r.nano)) return undefined;
  if (typeof r.nano === "number" && r.nano >= 0) c.credits = r.nano / 1e9;
  if (typeof r.cost === "number" && r.cost >= 0) c.premium = r.cost;
  if (r.isByok === true || (typeof r.provider === "string" && r.provider !== "copilot" && r.provider !== "loki")) c.byok = true;
  if (ctx.cwd) c.cwd = ctx.cwd;
  if (ctx.gitRoot) c.gitRoot = ctx.gitRoot;
  if (ctx.branch) c.branch = ctx.branch;
  return c;
}

/** The model calls of one session's events file between `since` and `until`, each once. Throws when it cannot be read. */
export function copilotFileCalls(file: string, session: string, since: number, until = Infinity): CopilotCall[] {
  const calls = new Map<string, CopilotCall>();
  const compactions: Array<[string | undefined, CopilotCall]> = [];
  const named = new Set<string>();
  let ctx: Record<string, string> = {};
  let anon = 0;
  for (const r of rowsOf<any>(file, COPILOT_USAGE_ROWS)) {
    if (r.k === "ctx") { ctx = { ...ctx, ...Object.fromEntries(Object.entries(r).filter(([k, v]) => k !== "k" && typeof v === "string")) as Record<string, string> }; continue; }
    const c = call(r, session, ctx);
    if (r.k === "u") {
      for (const id of [r.apiCallId, r.usageId]) if (text(id)) named.add(id);
      if (!c) continue;
      // The same call written again replaces the first copy.
      calls.set(r.acc ?? text(r.apiCallId) ?? text(r.id) ?? `#${anon++}`, c);
    } else if (r.k === "c" && c) compactions.push([text(r.requestId), c]);
  }
  for (const [req, c] of compactions) if (!req || !named.has(req)) calls.set(`compaction\u0000${req ?? anon++}`, c);
  return [...calls.values()].filter((c) => c.ts >= since && c.ts <= until).sort((a, b) => a.ts - b.ts);
}

/** Each session's events file written since `since`: `session-state/<id>/events.jsonl`, and the flat `session-state/<id>.jsonl` some versions write. */
export function copilotSessionFiles(since: number, home = homedir()): Array<{ file: string; session: string }> {
  const root = join(copilotDataDir(home), "session-state");
  if (!existsSync(root)) return [];
  const out: Array<{ file: string; session: string }> = [];
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  for (const name of names) {
    const flat = name.endsWith(".jsonl");
    const file = flat ? join(root, name) : join(root, name, "events.jsonl");
    try {
      const st = statSync(file);
      if (st.isFile() && st.mtimeMs >= since) out.push({ file, session: flat ? name.slice(0, -6) : name });
    } catch { /* not a session */ }
  }
  return out;
}

/** Every Copilot CLI model call between `since` and `until`. An unreadable session is skipped. */
export function copilotCalls(since: number, until = Infinity, home = homedir()): CopilotCall[] {
  const out: CopilotCall[] = [];
  for (const { file, session } of copilotSessionFiles(since, home)) {
    try { out.push(...copilotFileCalls(file, session, since, until)); } catch { /* unreadable: skipped */ }
  }
  return out;
}
