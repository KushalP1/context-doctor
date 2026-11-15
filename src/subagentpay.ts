/**
 * `context-doctor subagents`: which subagent tasks pay for themselves.
 *
 * The work costs money either way; the question is where it is cheaper. Done
 * in a subagent it costs the subagent's bill. Done in the parent, the same
 * steps would have run (at the parent's model price) with the parent's whole
 * context re-read on every step, and what they read would have stayed in the
 * parent for its later requests. Per subagent, all measured:
 *
 *   in a subagent = its bill
 *   in the parent = (bill - its own startup context) x parent/subagent price
 *                 + parent context at launch x steps x parent cache-read price
 *                 + (read - returned) x (W + 0.1 x later parent requests) x parent input price
 *
 * W is the parent's own cache-write price (1.25x input at the 5-minute TTL,
 * 2x at 1 hour, weighted by what the parent's usage records it wrote).
 *
 * "Read" is the tool output the subagent pulled in; "returned" is what the
 * parent received (tool result, or a background agent's task notification);
 * "later requests" run to the next compaction. Measured from transcripts and
 * subagents/<agent>.meta.json; nothing is sent anywhere.
 *
 * It ignores what a subagent buys besides context (parallel time, a clean
 * window for a hard task) and what the parent would have spent on its own tool
 * calls, so "did not pay" means "did not pay in context", not "was a mistake".
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { basename, join } from "node:path";
import { listSessions, outputSettler, replyCounter, isClaudeSession } from "./session.js";
import { rowsOf, slimUsage, type Extractor } from "./scan.js";
import { subagentFiles, workflowRunInfo } from "./subagents.js";
import { estimateTokens, formatTokens, realModel } from "./tokens.js";
import { billedCost, cacheWriteSplit, formatUsd, rateCard, ratesAt, requestCost, writeMultiplier, writePerM, type ModelPricing, type RecordedUsage } from "./pricing.js";
import { priceBasis } from "./orgrates.js";

/**
 * The model `fix` offers the subagents (subagentmodel.ts): the id the price
 * table knows, which Claude Code's model catalog maps to every provider's
 * id. Kept here: the every-prompt hook loads this file, and should not load
 * the replay's.
 */
export const SUBAGENT_CANDIDATE = "claude-sonnet-5-5";
export const SUBAGENT_CANDIDATE_NAME = "Sonnet 5.5";

const CLAUDE = "claude-opus-5";
const IMAGE_TOKENS = 1600;

export interface SubagentPayback {
  id: string;
  type: string;
  task: string;
  costUsd: number;
  /** The same requests at Sonnet 5.5 where they ran on a pricier model, token counts as recorded (an estimate). */
  atSonnetUsd: number;
  /** What the same work would have cost in the parent. */
  inParentUsd: number;
  steps: number;
  parentContextTokens: number;
  readTokens: number;
  returnedTokens: number;
  laterRequests: number;
  /** What carrying (read - returned) would have cost the parent. */
  avoidedUsd: number;
  netUsd: number;
}

export interface PaybackReport {
  days: number;
  sessions: number;
  subagents: SubagentPayback[];
  /**
   * Workflow agents (subagents/workflows/<run>/): their bill, by run. Not
   * weighed against the parent: a workflow is work the parent hands off
   * whole, not a read it would otherwise do itself.
   */
  workflows?: { runs: number; agents: number; costUsd: number; atSonnetUsd: number; byRun: Array<{ name: string; agents: number; costUsd: number; start: number }> };
}

function blockTokens(content: unknown): number {
  if (typeof content === "string") return estimateTokens(content, CLAUDE);
  if (!Array.isArray(content)) return estimateTokens(JSON.stringify(content ?? ""), CLAUDE);
  let n = 0;
  for (const p of content as Array<Record<string, unknown>>) {
    if (p?.type === "image") n += IMAGE_TOKENS;
    else if (typeof p?.text === "string") n += estimateTokens(p.text, CLAUDE);
    else n += estimateTokens(JSON.stringify(p ?? ""), CLAUDE);
  }
  return n;
}

const cheaper = (a: ModelPricing, b: ModelPricing) => a.inputPerM < b.inputPerM || (a.inputPerM === b.inputPerM && a.outputPerM < b.outputPerM);

/**
 * A request as billed (requestCost: its tier, fast mode, US-only, its date,
 * web searches) and re-priced for the Sonnet line: at Sonnet 5.5 when that
 * bills it for less, else as billed.
 */
function billed(model: string | undefined, u: RecordedUsage, at: number | undefined): { usd: number; sonnetUsd: number; rates: ModelPricing; sonnetRates: ModelPricing } | undefined {
  // With the iterations its top-level usage leaves out (billedCost), which a move to Sonnet leaves as they were.
  const own = billedCost(model, u, at);
  if (!own) return undefined;
  const sonnet = requestCost(SUBAGENT_CANDIDATE, u, at)!;
  const moved = cheaper(sonnet.rates, own.rates);
  return { usd: own.totalUsd, sonnetUsd: moved ? sonnet.totalUsd + (own.extra?.usd ?? 0) : own.totalUsd, rates: own.rates, sonnetRates: moved ? sonnet.rates : own.rates };
}

/** A subagent's tokens by what they bill as: uncached input, cache reads, cache writes, output (settled). */
export interface SubagentTokens { input: number; read: number; write: number; output: number }

/**
 * What `subagents` takes from a subagent's transcript, through the shared
 * scan (scan.ts), so a second run reads only what was appended: each reply's
 * id, model, time and usage (every row, for the output a streamed reply
 * settles on its last: a later row keeps only that), and the tool output
 * each user row hands it, as tokens. The task is read from the transcript's
 * head when needed (subagentTask): the cache keeps no message text.
 */
export const SUBAGENT_ROWS: Extractor<{ ids: Record<string, 1> }> = {
  id: "subagent.1",
  init: () => ({ ids: {} }),
  line(line, row, out, st) {
    const result = line.includes('"tool_result"');
    if (!result && !line.includes('"usage"')) return;
    let e: any;
    try { e = row(); } catch { return; }
    const content = e?.message?.content;
    if (e?.type === "user") {
      let n = 0;
      if (Array.isArray(content)) for (const b of content) if (b?.type === "tool_result") n += blockTokens(b.content);
      if (n) out.push(["r", n]);
      return;
    }
    if (e?.type !== "assistant" || !e.message?.usage) return;
    const m = e.message;
    const model = typeof m.model === "string" ? m.model : null;
    if (typeof m.id === "string") {
      // A later row of a reply already met: read only for the output it settles on.
      if (st.ids[m.id]) { out.push(["o", m.id, model, tok(m.usage.output_tokens)]); return; }
      st.ids[m.id] = 1;
    }
    const at = Date.parse(String(e.timestamp ?? ""));
    out.push(["a", typeof m.id === "string" ? m.id : null, model, Number.isFinite(at) ? at : null, packUsage(m.usage)]);
  },
};

const tok = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * A reply's usage as the subagent scans keep it, short (thousands of
 * transcripts are read back on every run): input, cache reads, cache writes,
 * of them at 1 hour, output, fast mode / US-only (1 / 2), web searches, and
 * the iterations billed beyond it (extraIterations), when any.
 */
function packUsage(u: any): unknown[] {
  const w = cacheWriteSplit(u);
  const slim = slimUsage(u, { iterations: true }) as Record<string, unknown>;
  const packed: unknown[] = [tok(u.input_tokens), tok(u.cache_read_input_tokens), w.fiveMinute + w.oneHour + w.twelveHour, w.oneHour, tok(u.output_tokens), (u.speed === "fast" ? 1 : 0) + (u.inference_geo === "us" ? 2 : 0), tok(u.server_tool_use?.web_search_requests)];
  if (slim?.iterations) packed.push(slim.iterations);
  return packed;
}

/** packUsage's array as the usage requestCost reads. */
function unpackUsage(p: any[]): RecordedUsage {
  return {
    input_tokens: p[0], cache_read_input_tokens: p[1], cache_creation_input_tokens: p[2], output_tokens: p[4],
    cache_creation: { ephemeral_1h_input_tokens: p[3], ephemeral_5m_input_tokens: p[2] - p[3] },
    ...(p[5] & 1 ? { speed: "fast" } : {}), ...(p[5] & 2 ? { inference_geo: "us" } : {}),
    ...(p[6] ? { server_tool_use: { web_search_requests: p[6] } } : {}),
    ...(p[7] ? { iterations: p[7] } : {}),
  };
}

/**
 * A subagent's task: the first user row with text, read from the
 * transcript's head (16 KB at a time, at most 1 MB): only for a subagent
 * whose meta file gives no description.
 */
export function subagentTask(path: string): string {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return ""; }
  try {
    let head = "";
    for (let pos = 0; pos < 1024 * 1024;) {
      const buf = Buffer.alloc(16 * 1024);
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      head += buf.subarray(0, n).toString("utf8");
      const lines = head.split("\n");
      head = lines.pop()!;
      for (const line of lines) {
        if (!line.includes('"user"')) continue;
        try {
          const e = JSON.parse(line);
          if (e?.type === "user" && typeof e.message?.content === "string") return e.message.content.replace(/\s+/g, " ").slice(0, 90);
        } catch { /* not a row */ }
      }
    }
    return "";
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

/**
 * What `subagents` takes from a parent transcript, through the shared scan:
 * its main-thread replies (time, model, prompt size, what changes their
 * rates, cache writes by lifetime), its compactions, and every row that
 * mentions one of its subagents (the Agent tool's result for that call, a
 * background agent's task notification), as tokens and the ids it names:
 * the calls of the Agent tool it made (kept in the state), and the ids a
 * notification names (`<task-id>`, `<tool-use-id>`, `agentId:`).
 */
export const PARENT_ROWS: Extractor<{ calls: string[] }> = {
  id: "subparent.1",
  init: () => ({ calls: [] }),
  line(line, row, out, st) {
    const isUsage = line.includes('"usage"');
    const isCompact = line.includes('"compact_boundary"');
    const named = [...line.matchAll(MENTION)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
    // The Agent tool's results, by the call they answer (a set: one transcript makes hundreds of calls).
    const calls = st.calls.length && line.includes('"tool_use_id"') ? [...line.matchAll(RESULT_OF)].map((m) => m[1]).filter((id) => callSet(st.calls).has(id)) : [];
    if (!isUsage && !isCompact && !named.length && !calls.length && !line.includes('"name":"Agent"') && !line.includes('"name":"Task"')) return;
    let e: any;
    try { e = row(); } catch { return; }
    const at = Date.parse(String(e?.timestamp ?? ""));
    if (isCompact && e?.subtype === "compact_boundary" && Number.isFinite(at)) out.push(["c", at]);
    if (e?.type === "assistant") {
      const m = e.message;
      for (const b of Array.isArray(m?.content) ? m.content : []) {
        if (b?.type === "tool_use" && (b.name === "Agent" || b.name === "Task") && typeof b.id === "string" && !st.calls.includes(b.id)) st.calls.push(b.id);
      }
      // Its time, prompt, writes by lifetime, fast mode / US-only (1 / 2): what the parent's side is priced from.
      if (!e.isSidechain && m?.usage) {
        const u = m.usage, w = cacheWriteSplit(u);
        out.push(["a", typeof m.id === "string" ? m.id : null, typeof m.model === "string" ? m.model : null, Number.isFinite(at) ? at : null, tok(u.input_tokens) + tok(u.cache_creation_input_tokens) + tok(u.cache_read_input_tokens), w.fiveMinute, w.oneHour, (u.speed === "fast" ? 1 : 0) + (u.inference_geo === "us" ? 2 : 0)]);
      }
      return;
    }
    const ids = [...new Set([...calls, ...named])];
    if (!ids.length || !Number.isFinite(at)) return;
    // Background agents report through a task notification; foreground ones through the tool result.
    const content = e?.message?.content ?? e?.content;
    const n = blockTokens(Array.isArray(content) ? content.map((b: any) => (b?.type === "tool_result" ? { text: typeof b.content === "string" ? b.content : JSON.stringify(b.content) } : b)) : content);
    out.push(["m", at, n, ids]);
  },
};

/**
 * The ids a row names its subagent by: a task notification's, the Agent
 * tool's result's, and the hand-back that carries a background agent's final
 * report (`<agent-message from="<id>">`, its quotes escaped in the row's JSON):
 * on the author's machine that report, ~3k tokens, is what the parent read,
 * where the notification is ~400.
 */
const MENTION = /<task-id>([\w-]{1,80})<\/task-id>|<tool-use-id>([\w-]{1,80})<\/tool-use-id>|agentId: ([\w-]{1,80})|<agent-message from=\\"([\w-]{1,80})\\"/g;
/** `calls` as a set, made again only when the list changed (it only grows). */
let calledSet: { of: string[]; n: number; set: Set<string> } | undefined;
function callSet(calls: string[]): Set<string> {
  if (calledSet?.of !== calls || calledSet.n !== calls.length) calledSet = { of: calls, n: calls.length, set: new Set(calls) };
  return calledSet.set;
}
/** A tool result's call. */
const RESULT_OF = /"tool_use_id":"([\w-]{1,80})"/g;

/**
 * A subagent's bill (each request as billed, requestCost), steps, startup
 * context, start time, the tool output it read, and the rates its first
 * request billed at. Read through the shared scan (SUBAGENT_ROWS).
 */
export function scanSubagent(path: string): { costUsd: number; atSonnetUsd: number; readTokens: number; steps: number; startup: number; start: number; model?: string; writeMult: number; rates?: ModelPricing; tokens: SubagentTokens } {
  const tokens: SubagentTokens = { input: 0, read: 0, write: 0, output: 0 };
  let costUsd = 0, atSonnetUsd = 0, readTokens = 0, model: string | undefined, firstRates: ModelPricing | undefined;
  let steps = 0, startup = 0, start = Infinity, writes5m = 0, writes1h = 0;
  // The rates of the last reply, for the output its later rows settle.
  let last: { rates: ModelPricing; sonnetRates: ModelPricing } | undefined;
  const sighting = replyCounter();
  const settle = outputSettler();
  for (const r of rowsOf<any[]>(path, SUBAGENT_ROWS)) {
    if (r[0] === "r") { readTokens += r[1]; continue; }
    if (typeof r[2] === "string" && !realModel(r[2])) continue; // "<synthetic>": not a request
    const repeat = r[0] === "o";
    const e = { message: { id: r[1] ?? undefined, model: r[2] ?? undefined, usage: repeat ? { output_tokens: r[3] } : unpackUsage(r[4]) } };
    const seen = sighting(e);
    if (seen === "repeat") {
      // A later row of the same reply: only its final output count is new.
      const more = settle(e, false);
      if (more) tokens.output += more;
      if (more && last) {
        costUsd += (more * last.rates.outputPerM) / 1e6;
        atSonnetUsd += (more * last.sonnetRates.outputPerM) / 1e6;
      }
      continue;
    }
    if (seen !== "new") continue;
    settle(e, true);
    model = realModel(e.message.model) ?? model;
    const u = e.message.usage as Record<string, any>;
    const n = (k: string) => (typeof u[k] === "number" && u[k] > 0 ? u[k] : 0);
    const at = typeof r[3] === "number" ? r[3] : NaN;
    if (Number.isFinite(at)) start = Math.min(start, at);
    if (steps === 0) startup = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
    steps++;
    tokens.input += n("input_tokens"); tokens.read += n("cache_read_input_tokens"); tokens.write += n("cache_creation_input_tokens"); tokens.output += n("output_tokens");
    const w = cacheWriteSplit(u);
    writes5m += w.fiveMinute;
    writes1h += w.oneHour;
    const b = billed(model, u, Number.isFinite(at) ? at : undefined);
    last = b;
    if (!b) continue;
    firstRates ??= b.rates;
    costUsd += b.usd;
    atSonnetUsd += b.sonnetUsd;
  }
  return { costUsd, atSonnetUsd, readTokens, steps, startup, start, model, writeMult: writeMultiplier(writes5m, writes1h), ...(firstRates ? { rates: firstRates } : {}), tokens };
}

interface ParentView {
  /** Main-chain request times, their prompt sizes, models and what changes their rates (fast mode, US-only), and compaction times. */
  requests: number[];
  prompts: number[];
  models: string[];
  billing: RecordedUsage[];
  compactions: number[];
  model?: string;
  /** Cache-write tokens the parent's usage records at each TTL: its write price. */
  writes5m: number;
  writes1h: number;
  /** For each id (tool_use id or agent id): the largest text that mentions it, and when. */
  returns: Map<string, { tokens: number; at: number }>;
}

/** A parent transcript as `subagents` weighs its subagents against it, read through the shared scan (PARENT_ROWS). */
function scanParent(path: string): ParentView {
  const view: ParentView = { requests: [], prompts: [], models: [], billing: [], compactions: [], writes5m: 0, writes1h: 0, returns: new Map() };
  let lastId: string | undefined;
  for (const r of rowsOf<any[]>(path, PARENT_ROWS)) {
    if (r[0] === "c") { view.compactions.push(r[1]); continue; }
    // Placeholder messages Claude Code writes itself ("<synthetic>") are not API requests.
    if (r[0] === "a") {
      const [, id, model, at, prompt, w5m, w1h, flags] = r;
      if ((id ?? undefined) === lastId || !realModel(model ?? undefined)) continue;
      lastId = id ?? undefined;
      view.model = realModel(model) ?? view.model;
      if (typeof at === "number") {
        view.requests.push(at);
        view.prompts.push(prompt);
        view.billing.push({ ...(flags & 1 ? { speed: "fast" } : {}), ...(flags & 2 ? { inference_geo: "us" } : {}) });
        view.models.push(view.model!);
      }
      view.writes5m += w5m;
      view.writes1h += w1h;
      continue;
    }
    if (r[0] !== "m") continue;
    const [, at, n, ids] = r;
    for (const id of ids as string[]) {
      const prev = view.returns.get(id);
      if (!prev || n > prev.tokens) view.returns.set(id, { tokens: n, at });
    }
  }
  return view;
}

export function subagentPayback(days = 30, paths?: string[], onProgress?: (done: number, total: number) => void): PaybackReport {
  const since = Date.now() - days * 86_400_000;
  const sessions = paths ?? listSessions(10_000).filter((s) => isClaudeSession(s) && s.modifiedAt.getTime() >= since).map((s) => s.path);
  const out: SubagentPayback[] = [];
  let withSubagents = 0;
  const runs = new Map<string, { name: string; agents: number; costUsd: number; atSonnetUsd: number; start: number }>();
  for (const [index, parent] of sessions.entries()) {
    onProgress?.(index, sessions.length);
    for (const f of subagentFiles(parent)) {
      if (!f.run) continue;
      let w;
      try { w = scanSubagent(f.file); } catch { continue; }
      // Each by its own start, as the Agent tool's below.
      if (!(w.steps > 0) || (Number.isFinite(w.start) && w.start < since)) continue;
      const key = `${parent}\u0000${f.run}`;
      const r = runs.get(key) ?? runs.set(key, { name: workflowRunInfo(parent, f.run).name ?? f.run, agents: 0, costUsd: 0, atSonnetUsd: 0, start: w.start }).get(key)!;
      r.agents++;
      r.costUsd += w.costUsd;
      r.atSonnetUsd += w.atSonnetUsd;
      r.start = Math.min(r.start, w.start);
    }
    const dir = join(parent.replace(/\.jsonl$/, ""), "subagents");
    if (!existsSync(dir)) continue;
    const agents = readdirSync(dir).filter((f) => /^agent-.+\.jsonl$/.test(f));
    if (!agents.length) continue;
    const before = out.length;
    const metas = agents.map((f) => {
      const id = basename(f, ".jsonl").replace(/^agent-/, "");
      let meta: { agentType?: string; description?: string; toolUseId?: string } = {};
      try { meta = JSON.parse(readFileSync(join(dir, `agent-${id}.meta.json`), "utf8")); } catch { /* older Claude Code: no meta */ }
      return { id, file: join(dir, f), meta };
    });
    const view = scanParent(parent);
    // What the parent pays to write a token to its cache, from its own usage.
    const parentWrite = writeMultiplier(view.writes5m, view.writes1h);
    for (const m of metas) {
      const s = scanSubagent(m.file);
      // Each subagent by its own start: a long session touched today brought
      // all its subagents into `--days 1` (70 where 9 started that day).
      // A subagent with no dated request counts with its session.
      if (Number.isFinite(s.start) && s.start < since) continue;
      const ret =[m.id, m.meta.toolUseId].map((k) => (k ? view.returns.get(k) : undefined)).filter(Boolean).sort((a, b) => b!.tokens - a!.tokens)[0];
      const returnedTokens = ret?.tokens ?? 0;
      const from = ret?.at ?? Infinity;
      const until = Math.min(...view.compactions.filter((c) => c > from), Infinity);
      const laterRequests = view.requests.filter((t) => t > from && t < until).length;
      const carried = Math.max(0, s.readTokens - returnedTokens);
      // The parent's context when the subagent started: its last request before then.
      let parentContextTokens = 0, last = -1;
      for (let i = 0; i < view.requests.length && view.requests[i] <= s.start; i++) { parentContextTokens = view.prompts[i]; last = i; }
      // The parent's rates as its next request would have billed them (rateCard: its tier at that context, fast mode and US-only as its last request, the day).
      // The parent as it ran then: a session that moved to another model later (Fable 5.1 to 5.2) is priced on the one it was on.
      const card = rateCard(last >= 0 ? view.models[last] : view.model, last >= 0 ? view.billing[last] : undefined, Number.isFinite(s.start) ? s.start : undefined);
      const price = card && ratesAt(card, parentContextTokens);
      const sub = s.rates ?? price;
      let inParentUsd = s.costUsd, avoidedUsd = 0;
      if (price && sub) {
        // Each side's cache writes at its own TTL mix (subagents write at 5
        // minutes, the main thread mostly at 1 hour) and reads at its model's rate.
        const startupUsd = (s.startup * (writePerM(sub, s.writeMult) + Math.max(0, s.steps - 1) * sub.cacheReadPerM)) / 1e6;
        const work = Math.max(0, s.costUsd - startupUsd) * (price.inputPerM / sub.inputPerM);
        const rideAlong = (parentContextTokens * s.steps * price.cacheReadPerM) / 1e6;
        avoidedUsd = (carried * (writePerM(price, parentWrite) + laterRequests * price.cacheReadPerM)) / 1e6;
        inParentUsd = work + rideAlong + avoidedUsd;
      }
      out.push({
        id: m.id,
        type: m.meta.agentType ?? "unknown",
        task: m.meta.description ?? subagentTask(m.file),
        costUsd: s.costUsd,
        atSonnetUsd: s.atSonnetUsd,
        inParentUsd,
        steps: s.steps,
        parentContextTokens,
        readTokens: s.readTokens,
        returnedTokens,
        laterRequests,
        avoidedUsd,
        netUsd: inParentUsd - s.costUsd,
      });
    }
    if (out.length > before) withSubagents++;
  }
  const byRun = [...runs.values()].sort((a, b) => b.costUsd - a.costUsd);
  const workflows = byRun.length
    ? { runs: byRun.length, agents: byRun.reduce((n, r) => n + r.agents, 0), costUsd: byRun.reduce((n, r) => n + r.costUsd, 0), atSonnetUsd: byRun.reduce((n, r) => n + r.atSonnetUsd, 0), byRun: byRun.map(({ atSonnetUsd: _s, ...r }) => r) }
    : undefined;
  return { days, sessions: withSubagents, subagents: out, ...(workflows ? { workflows } : {}) };
}

/** The workflow agents' lines of `subagents`: what they cost, by run. */
function renderWorkflows(w: NonNullable<PaybackReport["workflows"]>, top: number): string[] {
  const out = ["", `Workflow agents: ${w.agents} in ${w.runs} workflow run${w.runs === 1 ? "" : "s"}, ${formatUsd(w.costUsd)} ${priceBasis(false)} (each run's work handed off whole, so not weighed against the parent).`];
  if (w.costUsd - w.atSonnetUsd >= 1) out.push(`At ${SUBAGENT_CANDIDATE_NAME} (where they ran on a pricier model): ~${formatUsd(w.atSonnetUsd)}, token counts as recorded: an estimate.`);
  for (const r of w.byRun.slice(0, top)) out.push(`  ${formatUsd(r.costUsd).padStart(9)}  ${String(r.agents).padStart(3)} agents  ${r.name.slice(0, 60)}`);
  if (w.byRun.length > top) out.push(`  … and ${w.byRun.length - top} more`);
  return out;
}

export function renderPayback(r: PaybackReport, top = 8): string {
  const out = ["DO SUBAGENTS PAY FOR THEMSELVES?", "═".repeat(56)];
  const all = r.subagents;
  if (!all.length) return [...out, `No subagents in the last ${r.days} days.`, ...(r.workflows ? renderWorkflows(r.workflows, top) : [])].join("\n");
  const cost = all.reduce((s, a) => s + a.costUsd, 0);
  const inParent = all.reduce((s, a) => s + a.inParentUsd, 0);
  const paid = all.filter((a) => a.netUsd > 0);
  out.push(
    `Last ${r.days} days: ${all.length} subagents in ${r.sessions} sessions cost ${formatUsd(cost)} ${priceBasis(false)}.`,
    `The same work done in the parent would have cost ~${formatUsd(inParent)}: ${paid.length} of ${all.length} were cheaper as subagents, net ${inParent - cost >= 0 ? "+" : "−"}${formatUsd(Math.abs(inParent - cost))}.`
  );
  const sonnet = all.reduce((s, a) => s + a.atSonnetUsd, 0);
  if (cost - sonnet >= 1) out.push(`At ${SUBAGENT_CANDIDATE_NAME} (where they ran on a pricier model) the same requests come to ~${formatUsd(sonnet)}, token counts as recorded: an estimate. context-doctor fix says which of them a setting moves.`);
  out.push("");
  const byType = new Map<string, { n: number; cost: number; net: number; paid: number }>();
  for (const a of all) {
    const t = byType.get(a.type) ?? { n: 0, cost: 0, net: 0, paid: 0 };
    t.n++; t.cost += a.costUsd; t.net += a.netUsd; if (a.netUsd > 0) t.paid++;
    byType.set(a.type, t);
  }
  out.push("  by type                     count      cost    paid off   net");
  for (const [type, t] of [...byType.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
    out.push(`  ${type.slice(0, 26).padEnd(26)} ${String(t.n).padStart(6)} ${formatUsd(t.cost).padStart(9)} ${`${t.paid}/${t.n}`.padStart(10)}   ${t.net >= 0 ? "+" : "−"}${formatUsd(Math.abs(t.net))}`);
  }
  const worst = [...all].sort((a, b) => a.netUsd - b.netUsd).slice(0, top).filter((a) => a.netUsd < 0);
  if (worst.length) {
    out.push("", "Would have been cheaper in the parent:");
    for (const a of worst) out.push(`  −${formatUsd(-a.netUsd).padEnd(8)} ${String(a.steps).padStart(3)} steps, parent at ~${formatTokens(a.parentContextTokens)}, read ~${formatTokens(a.readTokens)}  ${a.task}`);
  }
  out.push(
    "",
    "Counts context only: a subagent can still be worth it for parallel time or a clean window on a hard task.",
    "Subagents pay most when the parent is already large (every step there re-reads it) and least for short tasks from a small parent."
  );
  if (r.workflows) out.push(...renderWorkflows(r.workflows, top));
  return out.join("\n");
}
