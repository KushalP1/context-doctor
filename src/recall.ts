/**
 * Recall: search this session's own transcript on disk.
 *
 * What leaves the context does not leave the disk. Claude Code writes every
 * turn to its transcript, the ones a compaction summarised away and the
 * tool output autopilot cleared in flight included (the transcript keeps the
 * original), and Codex writes its rollout the same way. So when the model
 * needs a detail from before a compaction (an error message, a path, a
 * decision), it can get the few lines that matter back instead of asking the
 * user or re-running a command.
 *
 * Ranking is pack's (BM25 over structural chunks); each excerpt comes back
 * with its time, its position in the session and whether it is still in the
 * context or was compacted away. Secret-looking strings are masked with the
 * handoff masker before anything is ranked or returned. Only the session
 * itself is read: by default the one named by CLAUDE_CODE_SESSION_ID, else the
 * newest transcript of the current folder's project (or Codex rollout started
 * in this folder), never another project's; any other session only when it
 * is named.
 */

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { claudeProjectDir, forEachLine } from "./session.js";
import { packContext, type Chunk } from "./pack.js";
import { maskSecrets, stripControls } from "./handoff.js";
import { formatTokens } from "./tokens.js";

/** One transcript entry, flattened to text: what a chunk points back to. */
interface Entry {
  /** 1-based position among the session's entries. */
  n: number;
  at?: string;
  kind: string;
  text: string;
  /** Compactions after this entry: 0 means it is in the current context. */
  compactedBy: number;
}

export interface RecallHit {
  id: string;
  /** Position in the session: entry n of total. */
  n: number;
  at?: string;
  kind: string;
  /** "in context" or "before compaction k of m". */
  where: string;
  tokens: number;
  score: number;
  text: string;
}

export interface RecallResult {
  path: string;
  /** How the session was chosen, in words. */
  how: string;
  query: string;
  entries: number;
  compactions: number;
  totalTokens: number;
  hits: RecallHit[];
  /** Secret-looking strings masked across the hits. */
  masked: number;
  /** Matching excerpts that did not fit the budget. */
  more: number;
}

/** A tool output longer than this keeps its head and tail: the middle of a 5 MB log rarely answers a question. */
const ENTRY_MAX_CHARS = 200_000;
/** Beyond this much text the oldest entries are left out (and said to be). */
const TOTAL_MAX_CHARS = 40_000_000;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : b?.type === "image" || b?.type === "input_image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

function clip(text: string): string {
  if (text.length <= ENTRY_MAX_CHARS) return text;
  const half = ENTRY_MAX_CHARS / 2;
  return `${text.slice(0, half)}\n[… ${text.length - ENTRY_MAX_CHARS} characters …]\n${text.slice(-half)}`;
}

/** A tool call in one line: its name and the input that says what it did (command, path, pattern). */
function callLine(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const key = ["command", "file_path", "path", "pattern", "url", "query", "cmd", "description", "prompt"].find((k) => typeof i[k] === "string");
  const detail = key ? String(i[key]) : typeof input === "string" ? input : JSON.stringify(input ?? "");
  return `${name}: ${detail.slice(0, 2000)}`;
}

/** Claude Code transcript rows, or Codex rollout lines, as entries in order. */
export function transcriptEntries(path: string): Entry[] {
  const entries: Entry[] = [];
  const toolNames = new Map<string, string>();
  const push = (at: unknown, kind: string, text: string) => {
    const t = text.trim();
    if (t) entries.push({ n: entries.length + 1, at: typeof at === "string" ? at : undefined, kind, text: clip(t), compactedBy: 0 });
  };
  const compact = () => {
    for (const e of entries) e.compactedBy++;
  };
  forEachLine(path, (line) => {
    let e: Record<string, any>;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (!e || typeof e !== "object") return;
    // Codex rollouts: {timestamp, type, payload}.
    if (e.payload && typeof e.payload === "object" && typeof e.type === "string" && !e.message) {
      const p = e.payload;
      if (e.type === "compacted" || p.type === "context_compacted") return compact();
      if (e.type !== "response_item") return;
      if (p.type === "message" && (p.role === "user" || p.role === "assistant")) return push(e.timestamp, p.role, textOf(p.content));
      if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
        const name = String(p.name ?? (p.type === "local_shell_call" ? "shell" : p.type));
        if (typeof p.call_id === "string") toolNames.set(p.call_id, name);
        let input: unknown = p.arguments ?? p.input ?? p.action;
        if (typeof input === "string") {
          try { input = JSON.parse(input); } catch { /* keep the string */ }
        }
        return push(e.timestamp, "tool call", callLine(name, input));
      }
      if (/_call_output$/.test(String(p.type))) return push(e.timestamp, `tool output (${toolNames.get(p.call_id) ?? "tool"})`, textOf(p.output));
      return;
    }
    // Claude Code transcripts.
    if (e.isSidechain) return;
    if (e.type === "system" && e.subtype === "compact_boundary") return compact();
    if (e.isCompactSummary) return; // the summary is what the context holds now
    const m = e.message;
    if (!m) return;
    const content = m.content;
    if (e.type === "user") {
      if (typeof content === "string") return push(e.timestamp, "user", content);
      if (!Array.isArray(content)) return;
      for (const b of content) {
        if (b?.type === "tool_result") push(e.timestamp, `tool output (${toolNames.get(b.tool_use_id) ?? "tool"})`, textOf(b.content));
        else if (typeof b?.text === "string") push(e.timestamp, "user", b.text);
      }
      return;
    }
    if (e.type === "assistant" && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "text") push(e.timestamp, "assistant", String(b.text ?? ""));
        else if (b?.type === "tool_use") {
          if (typeof b.id === "string") toolNames.set(b.id, String(b.name ?? "tool"));
          push(e.timestamp, "tool call", callLine(String(b.name ?? "tool"), b.input));
        }
      }
    }
  });
  return entries;
}

/** The first line of a Codex rollout names the folder it started in. */
function codexCwd(path: string): string | undefined {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const first = buf.subarray(0, n).toString("utf8").split("\n")[0];
      const cwd = JSON.parse(first)?.payload?.cwd;
      return typeof cwd === "string" ? cwd : undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * This session's transcript, never another project's: CLAUDE_CODE_SESSION_ID,
 * then the newest transcript in this folder's Claude Code project, then the
 * newest Codex rollout of the last week started in this folder.
 */
export function currentTranscript(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), home = homedir()): { path: string; how: string } | undefined {
  const here = claudeProjectDir(cwd, home);
  const id = env.CLAUDE_CODE_SESSION_ID?.trim();
  if (id && /^[\w.-]+$/.test(id)) {
    const found = findSession(id, home);
    if (found) return { path: found, how: `this Claude Code session (${id})` };
  }
  let newest: { path: string; at: number } | undefined;
  try {
    for (const f of readdirSync(here)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(here, f);
      const at = statSync(p).mtimeMs;
      if (!newest || at > newest.at) newest = { path: p, at };
    }
  } catch {
    /* no Claude Code project for this folder */
  }
  if (newest) return { path: newest.path, how: "the newest Claude Code session in this folder" };
  const codexRoot = join(home, ".codex", "sessions");
  const since = Date.now() - 7 * 86_400_000;
  const candidates: Array<{ path: string; at: number }> = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (depth < 3) walk(p, depth + 1); }
      else if (name.endsWith(".jsonl") && st.mtimeMs >= since) candidates.push({ path: p, at: st.mtimeMs });
    }
  };
  if (existsSync(codexRoot)) walk(codexRoot, 0);
  const codex = candidates.sort((a, b) => b.at - a.at).find((c) => codexCwd(c.path) === resolve(cwd));
  return codex ? { path: codex.path, how: "the newest Codex session started in this folder" } : undefined;
}

/** A session named by id (Claude Code `<id>.jsonl` in any project, or a Codex rollout whose name holds it) or by path. */
export function findSession(idOrPath: string, home = homedir()): string | undefined {
  if ((isAbsolute(idOrPath) || idOrPath.includes("/") || idOrPath.includes("\\")) && existsSync(idOrPath)) return resolve(idOrPath);
  if (!/^[\w.-]+$/.test(idOrPath)) return undefined;
  const root = join(home, ".claude", "projects");
  let dirs: string[] = [];
  try { dirs = readdirSync(root); } catch { /* none */ }
  for (const d of dirs) {
    const p = join(root, d, `${idOrPath}.jsonl`);
    if (existsSync(p)) return p;
  }
  const codexRoot = join(home, ".codex", "sessions");
  let hit: string | undefined;
  const walk = (dir: string, depth: number) => {
    if (hit) return;
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const p = join(dir, name);
      if (name.endsWith(".jsonl") && name.includes(idOrPath)) { hit = p; return; }
      if (depth < 3 && !name.includes(".")) walk(p, depth + 1);
    }
  };
  if (existsSync(codexRoot)) walk(codexRoot, 0);
  return hit;
}

/**
 * The excerpts of a transcript that best answer `query`, within `budget`
 * tokens, best first. Masked before ranking, so a secret is never returned.
 */
export function recall(path: string, query: string, opts: { budget?: number; how?: string } = {}): RecallResult {
  let entries = transcriptEntries(path);
  const compactions = entries.length ? Math.max(0, ...entries.map((e) => e.compactedBy)) : 0;
  let chars = 0;
  let from = entries.length;
  while (from > 0 && chars + entries[from - 1].text.length <= TOTAL_MAX_CHARS) chars += entries[--from].text.length;
  entries = entries.slice(from);
  let masked = 0;
  const byName = new Map<string, Entry>();
  const sources = entries.map((e) => {
    const m = maskSecrets(stripControls(e.text));
    masked += m.count;
    const name = `#${e.n}`;
    byName.set(name, e);
    return { name, text: m.text };
  });
  const budget = Math.max(200, opts.budget ?? 2000);
  const r = packContext(sources, { query, budget, maxChunkTokens: 300 });
  const total = entries.length + from;
  const where = (e: Entry) => (e.compactedBy === 0 ? "in context" : `before compaction ${compactions - e.compactedBy + 1} of ${compactions}`);
  const hits: RecallHit[] = [...r.selected]
    .sort((a, b) => b.score - a.score)
    .map((c: Chunk) => {
      const e = byName.get(c.source)!;
      return { id: c.id, n: e.n, at: e.at, kind: e.kind, where: where(e), tokens: c.tokens, score: c.score, text: c.text };
    });
  const more = r.chunks.filter((c) => c.score > 0 && !r.selected.includes(c)).length;
  return { path, how: opts.how ?? "the session named", query, entries: total, compactions, totalTokens: r.totalTokens, hits, masked, more };
}

export function renderRecall(r: RecallResult, home = homedir()): string {
  const name = basename(r.path).replace(/\.jsonl$/, "").slice(0, 48);
  const out = [`RECALL from ${r.how}${r.how.includes(name) ? "" : ` (${name})`}: ${r.entries} entries, ~${formatTokens(r.totalTokens)} tokens, ${r.compactions} compaction${r.compactions === 1 ? "" : "s"}.`];
  if (!r.hits.length) {
    out.push(`Nothing in it matches "${r.query}". Try the words the output itself would use (a file name, an error, a command).`);
    return out.join("\n");
  }
  out.push(`Best ${r.hits.length} excerpt${r.hits.length === 1 ? "" : "s"} for "${r.query}", best first${r.more ? ` (${r.more} more matched; a narrower query or a larger max_tokens gets them)` : ""}:`);
  if (r.masked) out.push(`${r.masked} secret-looking string${r.masked === 1 ? "" : "s"} masked.`);
  for (const h of r.hits) {
    const when = h.at ? h.at.slice(0, 16).replace("T", " ") + " UTC" : "time not recorded";
    out.push("", `── entry ${h.n} of ${r.entries} · ${when} · ${h.kind} · ${h.where} · ~${formatTokens(h.tokens)}`, h.text);
  }
  return out.join("\n").replaceAll(home, "~");
}
