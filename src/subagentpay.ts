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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { forEachLine, listSessions, outputSettler, replyCounter, isClaudeSession } from "./session.js";
import { subagentFiles, workflowRunInfo } from "./subagents.js";
import { estimateTokens, formatTokens, realModel } from "./tokens.js";
import { cacheWriteSplit, formatUsd, rateCard, ratesAt, requestCost, writeMultiplier, writePerM, type ModelPricing, type RecordedUsage } from "./pricing.js";
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
  const own = requestCost(model, u, at);
  if (!own) return undefined;
  const sonnet = requestCost(SUBAGENT_CANDIDATE, u, at)!;
  const moved = cheaper(sonnet.rates, own.rates);
  return { usd: own.totalUsd, sonnetUsd: moved ? sonnet.totalUsd : own.totalUsd, rates: own.rates, sonnetRates: moved ? sonnet.rates : own.rates };
}

/** A subagent's tokens by what they bill as: uncached input, cache reads, cache writes, output (settled). */
export interface SubagentTokens { input: number; read: number; write: number; output: number }

/**
 * A subagent's bill (each request as billed, requestCost), steps, startup
 * context, start time, the tool output it read, and the rates its first
 * request billed at.
 */
export function scanSubagent(path: string): { costUsd: number; atSonnetUsd: number; readTokens: number; task: string; steps: number; startup: number; start: number; model?: string; writeMult: number; rates?: ModelPricing; tokens: SubagentTokens } {
  const tokens: SubagentTokens = { input: 0, read: 0, write: 0, output: 0 };
  let costUsd = 0, atSonnetUsd = 0, readTokens = 0, task = "", model: string | undefined, firstRates: ModelPricing | undefined;
  let steps = 0, startup = 0, start = Infinity, writes5m = 0, writes1h = 0;
  // The rates of the last reply, for the output its later rows settle.
  let last: { rates: ModelPricing; sonnetRates: ModelPricing } | undefined;
  const sighting = replyCounter();
  const settle = outputSettler();
  forEachLine(path, (line) => {
    let e: any;
    try { e = JSON.parse(line); } catch { return; }
    const content = e?.message?.content;
    if (e?.type === "user") {
      if (!task && typeof content === "string") task = content;
      if (Array.isArray(content)) for (const b of content) if (b?.type === "tool_result") readTokens += blockTokens(b.content);
      return;
    }
    if (e?.type !== "assistant" || !e.message?.usage) return;
    if (typeof e.message.model === "string" && !realModel(e.message.model)) return; // "<synthetic>": not a request
    const seen = sighting(e);
    if (seen === "repeat") {
      // A later row of the same reply: only its final output count is new.
      const more = settle(e, false);
      if (more) tokens.output += more;
      if (more && last) {
        costUsd += (more * last.rates.outputPerM) / 1e6;
        atSonnetUsd += (more * last.sonnetRates.outputPerM) / 1e6;
      }
      return;
    }
    if (seen !== "new") return;
    settle(e, true);
    model = realModel(e.message.model) ?? model;
    const u = e.message.usage;
    const n = (k: string) => (typeof u[k] === "number" && u[k] > 0 ? u[k] : 0);
    const at = Date.parse(e.timestamp);
    if (Number.isFinite(at)) start = Math.min(start, at);
    if (steps === 0) startup = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
    steps++;
    tokens.input += n("input_tokens"); tokens.read += n("cache_read_input_tokens"); tokens.write += n("cache_creation_input_tokens"); tokens.output += n("output_tokens");
    const w = cacheWriteSplit(u);
    writes5m += w.fiveMinute;
    writes1h += w.oneHour;
    const b = billed(model, u, Number.isFinite(at) ? at : undefined);
    last = b;
    if (!b) return;
    firstRates ??= b.rates;
    costUsd += b.usd;
    atSonnetUsd += b.sonnetUsd;
  });
  return { costUsd, atSonnetUsd, readTokens, task: task.replace(/\s+/g, " ").slice(0, 90), steps, startup, start, model, writeMult: writeMultiplier(writes5m, writes1h), ...(firstRates ? { rates: firstRates } : {}), tokens };
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

function scanParent(path: string, ids: Set<string>): ParentView {
  const view: ParentView = { requests: [], prompts: [], models: [], billing: [], compactions: [], writes5m: 0, writes1h: 0, returns: new Map() };
  let lastId: string | undefined;
  forEachLine(path, (line) => {
    const hits = [...ids].filter((id) => line.includes(id));
    const isUsage = line.includes('"usage"');
    const isCompact = line.includes('"compact_boundary"');
    if (!hits.length && !isUsage && !isCompact) return;
    let e: any;
    try { e = JSON.parse(line); } catch { return; }
    const at = Date.parse(e?.timestamp);
    if (isCompact && e?.subtype === "compact_boundary" && Number.isFinite(at)) view.compactions.push(at);
    // Placeholder messages Claude Code writes itself ("<synthetic>") are not API requests.
    if (e?.type === "assistant" && !e.isSidechain && e.message?.usage && e.message.id !== lastId && realModel(e.message.model)) {
      lastId = e.message.id;
      view.model = realModel(e.message.model) ?? view.model;
      if (Number.isFinite(at)) {
        const u = e.message.usage;
        view.requests.push(at);
        view.prompts.push((u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0));
        view.billing.push({ speed: u.speed, inference_geo: u.inference_geo });
        view.models.push(view.model!);
      }
      const w = cacheWriteSplit(e.message.usage);
      view.writes5m += w.fiveMinute;
      view.writes1h += w.oneHour;
      return;
    }
    if (!hits.length || !Number.isFinite(at) || e?.type === "assistant") return;
    // Background agents report through a task notification; foreground ones through the tool result.
    const content = e?.message?.content ?? e?.content;
    const tokens = blockTokens(Array.isArray(content) ? content.map((b: any) => (b?.type === "tool_result" ? { text: typeof b.content === "string" ? b.content : JSON.stringify(b.content) } : b)) : content);
    for (const id of hits) {
      const prev = view.returns.get(id);
      if (!prev || tokens > prev.tokens) view.returns.set(id, { tokens, at });
    }
  });
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
    const ids = new Set(metas.flatMap((m) => [m.id, m.meta.toolUseId].filter((x): x is string => Boolean(x))));
    const view = scanParent(parent, ids);
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
        task: m.meta.description ?? s.task,
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
