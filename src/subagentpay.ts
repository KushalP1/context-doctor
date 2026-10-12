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
 *                 + parent context at launch x steps x 0.1 x parent input price
 *                 + (read - returned) x (1.25 + 0.1 x later parent requests) x parent input price
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
import { forEachLine, listSessions } from "./session.js";
import { estimateTokens, formatTokens, realModel } from "./tokens.js";
import { formatUsd, pricingFor } from "./pricing.js";

const CLAUDE = "claude-opus-5";
const IMAGE_TOKENS = 1600;

export interface SubagentPayback {
  id: string;
  type: string;
  task: string;
  costUsd: number;
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

/** A subagent's bill (usage priced as the cache bills it), steps, startup context, start time and the tool output it read. */
function scanSubagent(path: string): { costUsd: number; readTokens: number; task: string; steps: number; startup: number; start: number; model?: string } {
  let costUsd = 0, readTokens = 0, task = "", lastId: string | undefined, model: string | undefined;
  let steps = 0, startup = 0, start = Infinity;
  forEachLine(path, (line) => {
    let e: any;
    try { e = JSON.parse(line); } catch { return; }
    const content = e?.message?.content;
    if (e?.type === "user") {
      if (!task && typeof content === "string") task = content;
      if (Array.isArray(content)) for (const b of content) if (b?.type === "tool_result") readTokens += blockTokens(b.content);
      return;
    }
    if (e?.type !== "assistant" || !e.message?.usage || e.message.id === lastId) return;
    lastId = e.message.id;
    model = realModel(e.message.model) ?? model;
    const u = e.message.usage;
    const n = (k: string) => (typeof u[k] === "number" && u[k] > 0 ? u[k] : 0);
    const at = Date.parse(e.timestamp);
    if (Number.isFinite(at)) start = Math.min(start, at);
    if (steps === 0) startup = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
    steps++;
    const price = pricingFor(e.message.model ?? model);
    if (!price) return;
    costUsd += (n("input_tokens") * price.inputPerM + n("cache_creation_input_tokens") * price.inputPerM * 1.25 +
      n("cache_read_input_tokens") * price.cacheReadPerM + n("output_tokens") * price.outputPerM) / 1e6;
  });
  return { costUsd, readTokens, task: task.replace(/\s+/g, " ").slice(0, 90), steps, startup, start, model };
}

interface ParentView {
  /** Main-chain request times, their prompt sizes, and compaction times. */
  requests: number[];
  prompts: number[];
  compactions: number[];
  model?: string;
  /** For each id (tool_use id or agent id): the largest text that mentions it, and when. */
  returns: Map<string, { tokens: number; at: number }>;
}

function scanParent(path: string, ids: Set<string>): ParentView {
  const view: ParentView = { requests: [], prompts: [], compactions: [], returns: new Map() };
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
      if (Number.isFinite(at)) {
        const u = e.message.usage;
        view.requests.push(at);
        view.prompts.push((u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0));
      }
      view.model = realModel(e.message.model) ?? view.model;
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

export function subagentPayback(days = 30, paths?: string[]): PaybackReport {
  const since = Date.now() - days * 86_400_000;
  const sessions = paths ?? listSessions(10_000).filter((s) => s.path.includes(".claude") && s.modifiedAt.getTime() >= since).map((s) => s.path);
  const out: SubagentPayback[] = [];
  let withSubagents = 0;
  for (const parent of sessions) {
    const dir = join(parent.replace(/\.jsonl$/, ""), "subagents");
    if (!existsSync(dir)) continue;
    const agents = readdirSync(dir).filter((f) => /^agent-.+\.jsonl$/.test(f));
    if (!agents.length) continue;
    withSubagents++;
    const metas = agents.map((f) => {
      const id = basename(f, ".jsonl").replace(/^agent-/, "");
      let meta: { agentType?: string; description?: string; toolUseId?: string } = {};
      try { meta = JSON.parse(readFileSync(join(dir, `agent-${id}.meta.json`), "utf8")); } catch { /* older Claude Code: no meta */ }
      return { id, file: join(dir, f), meta };
    });
    const ids = new Set(metas.flatMap((m) => [m.id, m.meta.toolUseId].filter((x): x is string => Boolean(x))));
    const view = scanParent(parent, ids);
    const price = pricingFor(view.model);
    for (const m of metas) {
      const s = scanSubagent(m.file);
      const ret = [m.id, m.meta.toolUseId].map((k) => (k ? view.returns.get(k) : undefined)).filter(Boolean).sort((a, b) => b!.tokens - a!.tokens)[0];
      const returnedTokens = ret?.tokens ?? 0;
      const from = ret?.at ?? Infinity;
      const until = Math.min(...view.compactions.filter((c) => c > from), Infinity);
      const laterRequests = view.requests.filter((t) => t > from && t < until).length;
      const carried = Math.max(0, s.readTokens - returnedTokens);
      // The parent's context when the subagent started: its last request before then.
      let parentContextTokens = 0;
      for (let i = 0; i < view.requests.length && view.requests[i] <= s.start; i++) parentContextTokens = view.prompts[i];
      const sub = pricingFor(s.model) ?? price;
      let inParentUsd = s.costUsd, avoidedUsd = 0;
      if (price && sub) {
        const startupUsd = (s.startup * (1.25 + 0.1 * Math.max(0, s.steps - 1)) * sub.inputPerM) / 1e6;
        const work = Math.max(0, s.costUsd - startupUsd) * (price.inputPerM / sub.inputPerM);
        const rideAlong = (parentContextTokens * s.steps * price.cacheReadPerM) / 1e6;
        avoidedUsd = (carried * (1.25 + 0.1 * laterRequests) * price.inputPerM) / 1e6;
        inParentUsd = work + rideAlong + avoidedUsd;
      }
      out.push({
        id: m.id,
        type: m.meta.agentType ?? "unknown",
        task: m.meta.description ?? s.task,
        costUsd: s.costUsd,
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
  }
  return { days, sessions: withSubagents, subagents: out };
}

export function renderPayback(r: PaybackReport, top = 8): string {
  const out = ["DO SUBAGENTS PAY FOR THEMSELVES?", "═".repeat(56)];
  const all = r.subagents;
  if (!all.length) return [...out, `No subagents in the last ${r.days} days.`].join("\n");
  const cost = all.reduce((s, a) => s + a.costUsd, 0);
  const inParent = all.reduce((s, a) => s + a.inParentUsd, 0);
  const paid = all.filter((a) => a.netUsd > 0);
  out.push(
    `Last ${r.days} days: ${all.length} subagents in ${r.sessions} sessions cost ${formatUsd(cost)} at list price.`,
    `The same work done in the parent would have cost ~${formatUsd(inParent)}: ${paid.length} of ${all.length} were cheaper as subagents, net ${inParent - cost >= 0 ? "+" : "−"}${formatUsd(Math.abs(inParent - cost))}.`,
    ""
  );
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
  return out.join("\n");
}
