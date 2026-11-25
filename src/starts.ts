/**
 * The start of every session and every subagent: the first request's prompt
 * before the first message, per Claude Code entrypoint (the Desktop app, the
 * terminal, the SDK) and per subagent type, priced across the period.
 *
 * Every later request re-reads that start: from the cache at the read price
 * on a warm step, written again at the write price on a cold one. On the
 * author's machine a Desktop-app session starts at a median ~70k tokens and a
 * general-purpose subagent at ~52k, re-read at each of its steps (#105328:
 * a terminal session starts at ~13k, because the tools the terminal defers
 * behind tool search the app sends whole).
 *
 * Claude Code records what it sent: each transcript's `api-request-shape`
 * rows carry the request's system prompt and every tool definition, with
 * `defer_loading` on the ones held behind tool search, and the
 * `deferred_tools_delta` attachments name the ones announced as deferred. So
 * the part of a start that could be deferred, MCP tool definitions sent whole,
 * is read from the request itself; its tokens are estimated from its length
 * (Claude's ratios), the start itself is the API's own count.
 */

import { readFileSync } from "node:fs";
import { claudeMcpConfigs } from "./mcpschema.js";
import { REQUEST_ROWS } from "./coldresume.js";
import { rowsOf, slimUsage, type Extractor } from "./scan.js";
import { listSessions, isClaudeSession, replyCounter, textOf } from "./session.js";
import { subagentFiles, workflowRunOf } from "./subagents.js";
import { cacheWriteSplit, formatUsd, rateCard, ratesAt, usageCost } from "./pricing.js";
import { formatTokens, isCodeLike, realModel, tokensForLength } from "./tokens.js";
import { APP_TOOL_SERVERS } from "./mod/logic.js";
import { HOST_ROWS } from "./limits.js";

const CLAUDE = "claude-opus-5";

/** A start's request shape, as recorded: the system prompt's length and each tool's name, length and whether it was deferred. */
interface ShapeRecord { k: "s"; sys: number; tools: Array<[string, number, 0 | 1]> }
type StartRecord =
  | { k: "e"; v: string }
  | { k: "q"; v: string }
  | { k: "u"; len: number; code: boolean }
  | { k: "d"; names: string[] }
  | ShapeRecord;

/**
 * What a start's measurement takes from a transcript: the entrypoint, the
 * first request's query source (it names a subagent's type), the first user
 * message's length (never its text), the tools announced as deferred before
 * the first reply, and the first request's shape as names and lengths. A
 * handful of records per transcript, read once (scan.ts).
 */
export const START_ROWS: Extractor<{ e?: 1; q?: 1; s?: 1; u?: 1; r?: 1 }> = {
  id: "starts.1",
  init: () => ({}),
  line(raw, row, out, st) {
    const want =
      (!st.e && raw.includes('"entrypoint"')) ||
      (!st.q && raw.includes('"api-request"')) ||
      (!st.s && raw.includes('"api-request-shape"')) ||
      (!st.u && raw.includes('"user"')) ||
      (!st.r && (raw.includes('"deferred_tools_delta"') || raw.includes('"usage"')));
    if (!want) return;
    let e: any;
    try { e = row(); } catch { return; }
    if (!e || typeof e !== "object") return;
    if (!st.e && typeof e.entrypoint === "string" && e.entrypoint) {
      st.e = 1;
      out.push({ k: "e", v: e.entrypoint.slice(0, 40) });
    }
    if (e.type === "api-request" && !st.q && typeof e.querySource === "string") {
      st.q = 1;
      out.push({ k: "q", v: e.querySource.slice(0, 120) });
    }
    if (e.type === "api-request-shape" && !st.s && e.shape && typeof e.shape === "object") {
      st.s = 1;
      const tools: Array<[string, number, 0 | 1]> = [];
      for (const t of Array.isArray(e.shape.tools) ? e.shape.tools : []) {
        if (!t || typeof t !== "object" || typeof t.name !== "string") continue;
        tools.push([t.name.slice(0, 200), JSON.stringify(t).length, t.defer_loading === true ? 1 : 0]);
      }
      const sys = e.shape.system === undefined ? 0 : JSON.stringify(e.shape.system).length;
      out.push({ k: "s", sys, tools });
    }
    if (!st.r && e.type === "attachment" && e.attachment?.type === "deferred_tools_delta" && Array.isArray(e.attachment.addedNames)) {
      out.push({ k: "d", names: e.attachment.addedNames.filter((n: unknown) => typeof n === "string").map((n: string) => n.slice(0, 200)) });
    }
    if (!st.u && e.type === "user" && !e.isMeta) {
      const text = textOf(e.message?.content);
      if (text) {
        st.u = 1;
        out.push({ k: "u", len: text.length, code: isCodeLike(text) });
      }
    }
    if (!st.r && e.type === "assistant") {
      const u = e.message?.usage;
      if (u && (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) > 0) st.r = 1;
    }
  },
};

/**
 * The MCP servers a transcript called a tool of, by name only: which starts
 * needed a server whose tools could have waited behind tool search (fix's
 * desktop-tools-defer prices only the starts that never called it).
 */
export const CALL_ROWS: Extractor<{ seen: string[] }> = {
  id: "startcalls.1",
  init: () => ({ seen: [] }),
  line(raw, row, out, st) {
    if (!raw.includes('"tool_use"') || !raw.includes('"name":"mcp__')) return;
    let e: any;
    try { e = row(); } catch { return; }
    const content = e?.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      const server = b?.type === "tool_use" && typeof b.name === "string" ? mcpServerOf(b.name) : undefined;
      if (!server || st.seen.includes(server)) continue;
      st.seen.push(server);
      out.push(server.slice(0, 200));
    }
  },
};

/** An entrypoint as people call it. */
export function entrypointName(e: string | undefined): string {
  switch (e) {
    case "claude-desktop": return "Desktop app";
    case "cli": return "terminal";
    case "sdk-cli": return "claude -p / SDK";
    case "sdk-ts": case "sdk-py": return "Agent SDK";
    case "claude-vscode": return "VS Code";
    case undefined: case "": return "unknown";
    default: return e;
  }
}

/** The MCP server a tool name belongs to (`mcp__<server>__<tool>`), or undefined for a built-in. */
export function mcpServerOf(name: string): string | undefined {
  const m = /^mcp__(.+?)__/.exec(name);
  return m?.[1];
}

/** One start: a session's or a subagent's first request. */
interface Start {
  kind: "session" | "subagent";
  entrypoint?: string;
  agentType?: string;
  /** The first request's prompt minus the first user message (the subagent's brief): the API's own count, less an estimate. */
  tokens: number;
  /** What re-reading (and re-writing) it cost on every request of the period. */
  usd: number;
  priced: boolean;
  requests: number;
  shape?: { wholeTools: number; wholeTokens: number; mcpTokens: number; servers: Map<string, { tools: number; tokens: number }> };
  /** The MCP servers this transcript called a tool of. */
  called?: Set<string>;
}

export interface StartServer {
  name: string;
  /** Starts it went whole into. */
  starts: number;
  tools: number;
  /** Its definitions' tokens on a start (an estimate from their length). */
  tokens: number;
  /** In the user's own MCP config (~/.claude.json, the folder's .mcp.json): `alwaysLoad: false` there defers it. */
  configured?: "user" | "project" | ".mcp.json";
  /** Of `starts`, the ones whose session or subagent called one of its tools. */
  calledStarts: number;
  /** Its definitions' part of the starts that never called it, each start at its own rates: what keeping it behind tool search would have saved there. */
  unusedUsd: number;
  /** The same in the starts that did call it: with `unusedUsd`, its definitions' whole part of its starts, counted alike. */
  calledUsd: number;
}

export interface StartGroup {
  kind: "session" | "subagent";
  /** The entrypoint as recorded ("claude-desktop", "cli", "sdk-cli"). */
  entrypoint: string;
  agentType?: string;
  /** Starts measured (a first request over 1k tokens). */
  starts: number;
  median: number;
  p10: number;
  p90: number;
  /** Requests in the period, every one of which re-read the start. */
  requests: number;
  /** The start's price over the period: read on warm steps, written on cold ones. */
  usd: number;
  /** Starts whose model has no price: `usd` undercounts. */
  unpriced: number;
  /** Starts with a recorded request shape (Claude Code 2.1.308 and later). */
  shaped: number;
  /** Median tokens of tool definitions sent whole, and of MCP tool definitions sent whole (estimates). */
  wholeTokens?: number;
  mcpTokens?: number;
  wholeTools?: number;
  /** The MCP part's share of `usd`: what deferring those definitions would have saved, at most. */
  deferrableUsd?: number;
  servers: StartServer[];
}

export interface StartsReport {
  days: number;
  groups: StartGroup[];
  /** Desktop-app sessions against terminal ones, when both are in the period. */
  gap?: { desktop: number; terminal: number; tokens: number; usd: number };
  /**
   * The period's compactions, and the servers whose tools went whole into
   * some start that each compaction was followed by a call to (#111915: a
   * tool loaded through tool search is deferred again after a compaction,
   * so with the server behind tool search each would load once more).
   * Each load priced as one more request: the context at that call read
   * from the cache, plus one of the server's tool definitions written.
   */
  compactions?: { total: number; after: Array<Array<{ server: string; usd: number; unpriced?: true }>> };
}

/** A compaction, or an assistant row calling MCP tools: the servers, the request's model and usage (never the call's input). */
type ReloadRecord =
  | { k: "c"; ts: number; sc?: 1; u?: string }
  | { k: "t"; ts: number; sc?: 1; srv: string[]; m?: string; usage?: any };

/**
 * What the reload count reads from a transcript: each compaction boundary,
 * and each assistant row that calls an MCP tool, with the request's usage
 * (the context at that call). Read once with the other extractors (scan.ts).
 */
export const RELOAD_ROWS: Extractor<Record<string, never>> = {
  id: "reloads.1",
  init: () => ({}),
  line(raw, row, out) {
    const boundary = raw.includes('"compact_boundary"');
    if (!boundary && !(raw.includes('"tool_use"') && raw.includes('"name":"mcp__'))) return;
    let e: any;
    try { e = row(); } catch { return; }
    if (!e || typeof e !== "object") return;
    const ts = Date.parse(String(e.timestamp ?? ""));
    if (!Number.isFinite(ts)) return;
    const sc = e.isSidechain === true ? { sc: 1 as const } : {};
    if (e.type === "system" && e.subtype === "compact_boundary") {
      out.push({ k: "c", ts, ...sc, ...(typeof e.uuid === "string" ? { u: e.uuid.slice(0, 80) } : {}) });
      return;
    }
    const content = e.type === "assistant" ? e.message?.content : undefined;
    if (!Array.isArray(content)) return;
    const srv: string[] = [];
    for (const b of content) {
      const s = b?.type === "tool_use" && typeof b.name === "string" ? mcpServerOf(b.name) : undefined;
      if (s && !srv.includes(s.slice(0, 200))) srv.push(s.slice(0, 200));
    }
    if (!srv.length) return;
    out.push({ k: "t", ts, ...sc, srv, ...(typeof e.message.model === "string" ? { m: e.message.model.slice(0, 80) } : {}), usage: slimUsage(e.message.usage) });
  },
};

/** One load a compaction would have cost: the server, and the call's request (its context, model and time). */
interface Reload { server: string; at: number; model?: string; usage?: any }

/**
 * A transcript's compactions in the period, each with the servers called
 * after it (before the next one on the same thread), each server once: its
 * first call after the compaction is the one that would load it again. A
 * compaction already seen in another transcript (a fork's copy) is skipped
 * with the calls after it.
 */
function compactionsIn(path: string, since: number, seen: Set<string>): Reload[][] {
  const out: Reload[][] = [];
  const open = new Map<string, { list: Reload[]; servers: Set<string> } | undefined>();
  for (const r of rowsOf<ReloadRecord>(path, RELOAD_ROWS)) {
    const th = r.sc ? "1" : "0";
    if (r.k === "c") {
      const copy = r.u !== undefined && seen.has(r.u);
      if (r.u) seen.add(r.u);
      if (r.ts < since || copy) { open.set(th, undefined); continue; }
      const c = { list: [] as Reload[], servers: new Set<string>() };
      out.push(c.list);
      open.set(th, c);
      continue;
    }
    const c = open.get(th);
    if (!c) continue;
    for (const s of r.srv) {
      if (c.servers.has(s)) continue;
      c.servers.add(s);
      c.list.push({ server: s, at: r.ts, ...(r.m ? { model: r.m } : {}), usage: r.usage });
    }
  }
  return out;
}

/**
 * One more request at the call's context: all of it read from the cache, and
 * the tool's definition (`defTokens`) written, at the call's own write
 * lifetime and model rates. Undefined when the model has no price.
 */
function reloadUsd(r: Reload, defTokens: number): number | undefined {
  const u = r.usage ?? {};
  const prompt = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
  const card = rateCard(realModel(r.model), u, r.at);
  if (!card) return undefined;
  const split = cacheWriteSplit(u);
  const all = split.fiveMinute + split.oneHour + split.twelveHour;
  const def = Math.round(defTokens);
  const oneHour = all > 0 ? Math.round((def * split.oneHour) / all) : 0;
  return usageCost({ input_tokens: 0, cache_read_input_tokens: prompt, cache_creation_input_tokens: def, cache_creation: { ephemeral_5m_input_tokens: def - oneHour, ephemeral_1h_input_tokens: oneHour } }, ratesAt(card, prompt + def)).promptUsd;
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

/** The subagent's type: its meta file's `agentType`, else the first request's query source, else a workflow agent. */
function agentTypeOf(file: string, querySource?: string): string {
  try {
    const t = JSON.parse(readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8"))?.agentType;
    if (typeof t === "string" && t) return t.slice(0, 80);
  } catch { /* none */ }
  const q = querySource && /^agent:(?:builtin|custom|plugin|user|project)?:?(.+)$/.exec(querySource)?.[1];
  if (q) return q.slice(0, 80);
  return workflowRunOf(file) ? "workflow" : "unknown";
}

/** One transcript's start and what it cost across the period, or undefined when it has none to measure. */
function measureStart(path: string, kind: Start["kind"], since: number, runRows?: Set<string>, parentEntry?: string): Start | undefined {
  const meta = rowsOf<StartRecord>(path, START_ROWS);
  let entrypoint = parentEntry, querySource: string | undefined, user: { len: number; code: boolean } | undefined, shape: ShapeRecord | undefined;
  const deferred = new Set<string>();
  for (const r of meta) {
    if (r.k === "e") entrypoint = r.v;
    else if (r.k === "q") querySource = r.v;
    else if (r.k === "u") user = r;
    else if (r.k === "d") for (const n of r.names) deferred.add(n);
    else if (r.k === "s") shape = r;
  }
  const sighting = replyCounter(runRows);
  let tokens: number | undefined;
  let usd = 0, requests = 0, priced = true, started = false;
  for (const e of rowsOf(path, REQUEST_ROWS)) {
    if (!e || e.type !== "assistant" || !e.message?.usage) continue;
    // A session's own thread; a subagent's transcript is all sidechain.
    if (kind === "session" && e.isSidechain) continue;
    const seen = sighting(e);
    if (seen === "repeat") continue;
    const u = e.message.usage;
    const read = Number(u.cache_read_input_tokens) || 0, write = Number(u.cache_creation_input_tokens) || 0, input = Number(u.input_tokens) || 0;
    const prompt = input + read + write;
    const at = Date.parse(e.timestamp);
    if (!(prompt > 0) || !Number.isFinite(at)) continue;
    if (!started) {
      started = true;
      // A fork's first request is its parent's: not a start of its own.
      if (seen !== "new") return undefined;
      tokens = Math.max(0, prompt - (user ? tokensForLength(user.len, user.code, CLAUDE) : 0));
      if (tokens <= 1000) return undefined;
    }
    if (seen === "copy" || at < since) continue;
    requests++;
    // The start's tokens on this request, at the rates it paid for them: read from the cache first, then written, then uncached.
    const part = Math.min(tokens!, prompt);
    const r = Math.min(part, read);
    const w = Math.min(part - r, write);
    const split = cacheWriteSplit(u);
    const all = split.fiveMinute + split.oneHour + split.twelveHour;
    const oneHour = all > 0 ? (w * split.oneHour) / all : 0;
    const card = rateCard(realModel(e.message.model), u, at);
    if (!card) { priced = false; continue; }
    usd += usageCost({ input_tokens: part - r - w, cache_read_input_tokens: r, cache_creation_input_tokens: w, cache_creation: { ephemeral_5m_input_tokens: w - oneHour, ephemeral_1h_input_tokens: oneHour } }, ratesAt(card, prompt)).promptUsd;
  }
  if (tokens === undefined || requests === 0) return undefined;
  const start: Start = { kind, entrypoint, tokens, usd, priced, requests };
  if (kind === "subagent") start.agentType = agentTypeOf(path, querySource);
  if (shape) {
    const servers = new Map<string, { tools: number; tokens: number }>();
    let wholeTools = 0, wholeTokens = 0, mcpTokens = 0;
    for (const [name, chars, d] of shape.tools) {
      if (d || deferred.has(name)) continue;
      // Tool definitions are mostly descriptions: prose ratios (an estimate, labelled so).
      const t = tokensForLength(chars, false, CLAUDE);
      wholeTools++;
      wholeTokens += t;
      const server = mcpServerOf(name);
      if (!server) continue;
      mcpTokens += t;
      const s = servers.get(server) ?? servers.set(server, { tools: 0, tokens: 0 }).get(server)!;
      s.tools++;
      s.tokens += t;
    }
    start.shape = { wholeTools, wholeTokens: Math.min(wholeTokens, tokens), mcpTokens: Math.min(mcpTokens, tokens), servers };
    if (servers.size) start.called = new Set(rowsOf<string>(path, CALL_ROWS));
  }
  return start;
}

/** A Claude Code that ran sessions in the period: the entrypoint and version their transcripts recorded, and how many. */
export interface SessionHost {
  /** "claude-desktop", "cli", "sdk-cli", "claude-vscode"... ("" when a transcript records none). */
  entrypoint: string;
  version?: string;
  sessions: number;
}

/**
 * Which Claude Code ran the sessions in the period: each entrypoint and
 * version a main transcript recorded while it was in the period (limits.ts
 * HOST_ROWS keeps a record where either changes), counted once per session.
 * fix uses it to say when an install too old for a setting ran none of them.
 */
export function sessionHosts(paths: string[], since: number): SessionHost[] {
  const out = new Map<string, SessionHost>();
  for (const path of paths) {
    let hosts: Array<{ ts: number; ep?: string; v?: string }>;
    try { hosts = rowsOf(path, HOST_ROWS); } catch { continue; }
    const seen = new Set<string>();
    hosts.forEach((h, j) => {
      // Superseded before the period began (a session resumed after an update): not this period's.
      const next = hosts[j + 1];
      if (next && next.ts > 0 && next.ts < since) return;
      const k = `${h.ep ?? ""}\u0000${h.v ?? ""}`;
      if (seen.has(k)) return;
      seen.add(k);
      const cur = out.get(k) ?? out.set(k, { entrypoint: h.ep ?? "", ...(h.v ? { version: h.v } : {}), sessions: 0 }).get(k)!;
      cur.sessions++;
    });
  }
  return [...out.values()].sort((a, b) => b.sessions - a.sessions);
}

/** Claude Code transcripts written in the last `days` days. */
function claudeTranscripts(days: number): string[] {
  const since = Date.now() - days * 86_400_000;
  return listSessions(10_000).filter((s) => isClaudeSession(s) && s.modifiedAt.getTime() >= since).map((s) => s.path);
}

/**
 * Every session's and subagent's start in the period, grouped by entrypoint
 * and subagent type, each priced on every request that re-read it.
 * `paths`: the main transcripts (subagents are found beside each).
 * `compactions`: also count the compactions followed by a call to a server
 * sent whole (fix's desktop-tools-defer; `overhead` does not ask).
 */
export function measureStarts(opts: { days?: number; paths?: string[]; cwd?: string; home?: string; compactions?: boolean } = {}): StartsReport {
  const days = opts.days ?? 30;
  const since = Date.now() - days * 86_400_000;
  const mains = (opts.paths ?? claudeTranscripts(days)).filter((p) => !/[\\/]\.codex[\\/]/.test(p) && !/[\\/]\.gemini[\\/]/.test(p));
  const starts: Start[] = [];
  const runRows = new Set<string>();
  // Every compaction of the period (sessions and subagents), each with the servers called after it.
  const compactions: Reload[][] = [];
  const compactionIds = new Set<string>();
  const reloadsOf = (file: string) => {
    if (!opts.compactions) return;
    try { compactions.push(...compactionsIn(file, since, compactionIds)); } catch { /* unreadable: skipped */ }
  };
  for (const path of mains) {
    let s: Start | undefined;
    try { s = measureStart(path, "session", since, runRows); } catch { continue; }
    if (s) starts.push(s);
    reloadsOf(path);
    let parentEntry = s?.entrypoint;
    if (parentEntry === undefined) {
      try { parentEntry = rowsOf<StartRecord>(path, START_ROWS).find((r) => r.k === "e")?.v as string | undefined; } catch { /* unreadable */ }
    }
    for (const f of subagentFiles(path, since)) {
      try {
        const sub = measureStart(f.file, "subagent", since, undefined, parentEntry);
        if (sub) starts.push(sub);
      } catch { /* unreadable: skipped */ }
      reloadsOf(f.file);
    }
  }
  let configured = new Map<string, StartServer["configured"]>();
  try { configured = new Map(claudeMcpConfigs(opts.cwd, opts.home).map((c) => [c.name, c.scope])); } catch { /* none */ }

  const byKey = new Map<string, Start[]>();
  for (const s of starts) {
    const k = `${s.kind}\u0000${s.entrypoint ?? ""}\u0000${s.agentType ?? ""}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(s);
  }
  const groups: StartGroup[] = [];
  for (const list of byKey.values()) {
    const first = list[0];
    const sorted = list.map((s) => s.tokens).sort((a, b) => a - b);
    const shaped = list.filter((s) => s.shape);
    const med = (xs: number[]) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : undefined);
    const servers = new Map<string, StartServer>();
    for (const s of shaped) for (const [name, v] of s.shape!.servers) {
      const cur = servers.get(name) ?? servers.set(name, { name, starts: 0, tools: 0, tokens: 0, calledStarts: 0, unusedUsd: 0, calledUsd: 0, ...(configured.get(name) ? { configured: configured.get(name) } : {}) }).get(name)!;
      cur.starts++;
      cur.tools = Math.max(cur.tools, v.tools);
      cur.tokens += v.tokens;
      const part = s.usd * Math.min(1, v.tokens / s.tokens);
      if (s.called?.has(name)) { cur.calledStarts++; cur.calledUsd += part; }
      else cur.unusedUsd += part;
    }
    for (const s of servers.values()) s.tokens = Math.round(s.tokens / s.starts);
    const g: StartGroup = {
      kind: first.kind,
      entrypoint: first.entrypoint ?? "",
      ...(first.agentType ? { agentType: first.agentType } : {}),
      starts: list.length,
      median: quantile(sorted, 0.5),
      p10: quantile(sorted, 0.1),
      p90: quantile(sorted, 0.9),
      requests: list.reduce((t, s) => t + s.requests, 0),
      usd: list.reduce((t, s) => t + s.usd, 0),
      unpriced: list.filter((s) => !s.priced).length,
      shaped: shaped.length,
      servers: [...servers.values()].sort((a, b) => b.starts * b.tokens - a.starts * a.tokens),
    };
    if (shaped.length) {
      g.wholeTokens = med(shaped.map((s) => s.shape!.wholeTokens));
      g.mcpTokens = med(shaped.map((s) => s.shape!.mcpTokens));
      g.wholeTools = med(shaped.map((s) => s.shape!.wholeTools));
      g.deferrableUsd = shaped.reduce((t, s) => t + s.usd * Math.min(1, s.shape!.mcpTokens / s.tokens), 0);
    }
    groups.push(g);
  }
  groups.sort((a, b) => (a.kind === b.kind ? b.usd - a.usd : a.kind === "session" ? -1 : 1));

  const report: StartsReport = { days, groups };
  const desktop = starts.filter((s) => s.kind === "session" && s.entrypoint === "claude-desktop");
  const terminal = starts.filter((s) => s.kind === "session" && s.entrypoint === "cli");
  if (desktop.length && terminal.length) {
    const d = quantile(desktop.map((s) => s.tokens).sort((a, b) => a - b), 0.5);
    const t = quantile(terminal.map((s) => s.tokens).sort((a, b) => a - b), 0.5);
    // What the Desktop app's starts cost above a terminal-sized start, each at its own requests' rates.
    const usd = desktop.reduce((sum, s) => sum + s.usd * Math.max(0, s.tokens - t) / s.tokens, 0);
    report.gap = { desktop: d, terminal: t, tokens: d - t, usd };
  }
  if (opts.compactions) {
    // A load brings one tool's definition: the server's whole definitions on a start, over its tools.
    const perTool = new Map(startServers(report).map((s) => [s.name, s.tools ? s.tokens / s.tools : 0]));
    const after = compactions
      .map((c) => c.filter((r) => perTool.has(r.server)).map((r) => {
        const usd = reloadUsd(r, perTool.get(r.server)!);
        return usd === undefined ? { server: r.server, usd: 0, unpriced: true as const } : { server: r.server, usd };
      }))
      .filter((c) => c.length);
    report.compactions = { total: compactions.length, after };
  }
  return report;
}

/** The servers whose tools went whole into some start and that the user's own config holds: `alwaysLoad: false` defers them. */
export function deferrableConfigured(r: StartsReport): Array<{ name: string; scope: NonNullable<StartServer["configured"]>; tokens: number; usd: number }> {
  const out = new Map<string, { name: string; scope: NonNullable<StartServer["configured"]>; tokens: number; usd: number }>();
  for (const g of r.groups) {
    if (!g.mcpTokens || !g.deferrableUsd) continue;
    for (const s of g.servers) {
      if (!s.configured) continue;
      const cur = out.get(s.name) ?? out.set(s.name, { name: s.name, scope: s.configured, tokens: 0, usd: 0 }).get(s.name)!;
      cur.tokens = Math.max(cur.tokens, s.tokens);
      // Its share of the group's deferrable part, by its tokens on the starts it went into.
      cur.usd += g.deferrableUsd * (s.tokens * s.starts) / (g.servers.reduce((t, x) => t + x.tokens * x.starts, 0) || 1);
    }
  }
  return [...out.values()].sort((a, b) => b.usd - a.usd);
}

/** Every server whose tools went whole into some start, across the groups: its share of each group's deferrable part, as `overhead` lists it. */
export function startServers(r: StartsReport): Array<StartServer & { usd: number }> {
  const servers = new Map<string, StartServer & { usd: number }>();
  for (const g of r.groups) for (const s of g.servers) {
    const share = g.deferrableUsd ? (g.deferrableUsd * s.tokens * s.starts) / (g.servers.reduce((t, x) => t + x.tokens * x.starts, 0) || 1) : 0;
    const cur = servers.get(s.name);
    if (cur) { cur.usd += share; cur.starts += s.starts; cur.calledStarts += s.calledStarts; cur.unusedUsd += s.unusedUsd; cur.calledUsd += s.calledUsd; cur.tokens = Math.max(cur.tokens, s.tokens); cur.tools = Math.max(cur.tools, s.tools); }
    else servers.set(s.name, { ...s, usd: share });
  }
  return [...servers.values()].sort((a, b) => b.usd - a.usd);
}

/**
 * The Desktop app's own servers (Claude_Browser, ccd_session, visualize,
 * terminal) whose tools went whole into some start, and no config file of the
 * user's holds: fix's desktop-tools-defer, which context-doctor's mod applies.
 */
export function deferrableApp(r: StartsReport): Array<StartServer & { usd: number }> {
  return startServers(r).filter((s) => !s.configured && APP_TOOL_SERVERS.includes(s.name));
}

const tok = (n: number) => `~${formatTokens(n)}`;

/** Every start's cost over the period as billed, and the subagents' part of it; `unpriced` when a start had a model with no price. */
export function startsTotal(r: StartsReport): { usd: number; subagentUsd: number; subagents: boolean; unpriced: boolean } {
  const subs = r.groups.filter((g) => g.kind === "subagent");
  return { usd: r.groups.reduce((t, g) => t + g.usd, 0), subagentUsd: subs.reduce((t, g) => t + g.usd, 0), subagents: subs.length > 0, unpriced: r.groups.some((g) => g.unpriced) };
}

/** The starts section of `overhead`. */
export function renderStarts(r: StartsReport, applied: ReadonlySet<string> = new Set()): string[] {
  const out = ["", "Session and subagent starts (the first request, before the first message)", "─".repeat(56)];
  if (r.groups.length === 0) {
    out.push("  No Claude Code session in the period to measure.");
    return out;
  }
  const line = (label: string, g: StartGroup) => {
    const cost = `${formatUsd(g.usd)}${g.unpriced ? "+" : ""}`;
    out.push(`  ${label.padEnd(30)} ${String(g.starts).padStart(4)}  median ${tok(g.median).padStart(6)} (p10 ${tok(g.p10)}, p90 ${tok(g.p90)})  ${g.requests.toLocaleString("en-US")} steps re-read it: ${cost}`);
    if (g.mcpTokens !== undefined && g.wholeTokens !== undefined) {
      out.push(`  ${"".padEnd(30)}       tools sent whole ${tok(g.wholeTokens)} (${g.wholeTools} tools), of which MCP ${tok(g.mcpTokens)}${g.deferrableUsd ? `: ${formatUsd(g.deferrableUsd)} of the ${cost}` : ""}${g.shaped < g.starts ? ` (${g.shaped} of ${g.starts} starts record their tools)` : ""}`);
    }
  };
  const sessions = r.groups.filter((g) => g.kind === "session");
  const subs = r.groups.filter((g) => g.kind === "subagent");
  for (const g of sessions) line(`${entrypointName(g.entrypoint)} sessions`, g);
  for (const g of subs) line(`${g.agentType} (subagent)${new Set(subs.map((x) => x.entrypoint)).size > 1 ? ` (${entrypointName(g.entrypoint)})` : ""}`, g);
  const t = startsTotal(r);
  out.push(`  Every start, re-read at each step over ${r.days} days: ${formatUsd(t.usd)}${t.subagents ? ` (subagents ${formatUsd(t.subagentUsd)})` : ""}. Token counts are the API's; tool sizes are estimates from their length.`);

  if (r.gap && r.gap.tokens > 0) {
    out.push(`  Desktop app vs terminal: a Desktop session starts ~${formatTokens(r.gap.tokens)} tokens larger (median ${tok(r.gap.desktop)} against ${tok(r.gap.terminal)}): ${formatUsd(r.gap.usd)} of its starts' cost in ${r.days} days.`);
  } else if (r.gap) {
    out.push(`  Desktop app vs terminal: a Desktop session starts no larger here (median ${tok(r.gap.desktop)} against ${tok(r.gap.terminal)}).`);
  } else if (sessions.some((g) => g.entrypoint === "claude-desktop")) {
    out.push("  No terminal sessions in the period to compare the Desktop app's start with (#105328 reports ~79k against ~13k).");
  }

  // What could be deferred, and whether any setting reaches it.
  const list = startServers(r);
  if (list.length) {
    out.push("  MCP tool definitions sent whole (not deferred behind tool search):");
    for (const s of list.slice(0, 8)) {
      const where = s.configured ? `your ${s.configured === "user" ? "~/.claude.json" : s.configured === "project" ? "~/.claude.json (this project)" : ".mcp.json"}: \`alwaysLoad: false\` defers it` : "provided by the app or a connector";
      const name = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.name) ? `claude.ai connector ${s.name.slice(0, 8)}` : s.name;
      out.push(`    ${name.padEnd(28)} ${String(s.tools).padStart(3)} tools ${tok(s.tokens).padStart(6)}  ${formatUsd(s.usd).padStart(8)}  ${where}`);
    }
    if (list.length > 8) out.push(`    … ${list.length - 8} more`);
    const app = list.filter((s) => !s.configured);
    if (app.length) {
      out.push(
        `  No setting defers the ${app.length === 1 ? "server" : `${app.length} servers`} the app provides (${formatUsd(app.reduce((t, s) => t + s.usd, 0))} of the starts' cost): the Desktop app hands its own servers and connectors to Claude Code in-process with their tools marked to load upfront, and no MCP setting or ENABLE_TOOL_SEARCH value reaches them (tool search is on: the other tools are deferred). A subagent definition's \`tools:\` list or \`disallowedTools: mcp__*\` keeps them out of that agent's start, and out of its reach too.`
      );
    }
    const own = app.filter((s) => APP_TOOL_SERVERS.includes(s.name));
    // Applied already: the starts in this window before it still count the tools, so say so rather than offer it again.
    if (own.length && applied.has("desktop-tools-defer")) out.push(`  Applied (\`fix --apply desktop-tools-defer\`): context-doctor's mod keeps ${own.map((s) => s.name).join(", ")} behind tool search in sessions started since; the older starts above still count them. Undo with \`fix undo desktop-tools-defer\`.`);
    else if (own.length) out.push(`  \`context-doctor fix --apply desktop-tools-defer\` has context-doctor's mod keep ${own.map((s) => s.name).join(", ")} behind tool search in new sessions (Claude Code 2.1.326+ with the plugin; reversible with \`fix undo desktop-tools-defer\`); \`fix\` prices it on the starts that never called them.`);
    if (list.some((s) => s.configured) && applied.has("mcp-defer")) out.push("  Applied (`fix --apply mcp-defer`): your own servers are set to `alwaysLoad: false`; starts before that still count them. Undo with `fix undo mcp-defer`.");
    else if (list.some((s) => s.configured)) out.push("  `context-doctor fix --apply mcp-defer` sets `alwaysLoad: false` on the ones in your own config (reversible with `fix undo mcp-defer`).");
  } else if (r.groups.some((g) => g.shaped > 0)) {
    out.push("  Every MCP tool definition was deferred behind tool search: nothing of the start to defer.");
  }
  return out;
}
