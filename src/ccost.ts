/**
 * Claude Code's own cost beside ours.
 *
 * Every Claude Code transcript carries `cost-state` rows: Claude Code's
 * running total for the session (`totalCostUSD`, what /cost shows), and per
 * model the tokens and dollars it counted (`modelUsage`). It writes one at
 * points through a session and restores it on resume (one `startTime` per
 * session, the total never falls: all 567 rows of the author's 79 sessions
 * that have one). It counts every request its process made for the session,
 * subagents included, and also what no transcript row records: a
 * compaction's own request (which context-doctor estimates, compactcost.ts),
 * the small requests it makes on its own (titles and the like, on a Haiku),
 * web searches at their fee, and from Claude Code 2.1.325 other mods' own
 * model calls.
 *
 * So it is the check ROADMAP K2 waited on the mod for, read from what is
 * already on disk: per session, its last `cost-state` against our price of
 * the same requests (the session's transcript and its subagents', from the
 * session's start to the last reply before that row). The gap is taken
 * apart, per model, with Claude Code's own token counts:
 *  - models it counted that no transcript row has (its side requests);
 *  - on the models both count, its tokens beyond ours, at our prices
 *    (requests the transcripts keep no usage for: compactions past our
 *    estimate of them, retries);
 *  - what is left is price: its dollars against ours for its own tokens
 *    (its price table, fast mode, a long prompt's tier, contracted rates).
 * The mod's ledger (modmeasure.ts) stays for what it measures live; this is
 * the comparison `spend`, `session` and `doctor` show.
 */

import { basename } from "node:path";
import { requestCost, type RecordedUsage } from "./pricing.js";
import { realModel } from "./tokens.js";
import { rowsOf } from "./scan.js";
import { USAGE_ROWS } from "./limits.js";
import type { SpendItem } from "./spend.js";

/** What one model's line of a `cost-state` holds, as numbers. */
export interface CcModel {
  usd: number;
  input: number;
  output: number;
  read: number;
  write: number;
  /** The writes by lifetime (`cacheCreationEphemeral1hInputTokens`, `...5m...`): both 0 where Claude Code did not split them (before ~2.1.317). */
  write1h: number;
  write5m: number;
  searches: number;
}

/** A `cost-state` row as the usage scan keeps it (scan.ts: numbers and model names only). */
export interface CostStateRecord {
  type: "cost-state";
  usd: number;
  /** The session's start (ms), restored with the total on resume. */
  start?: number;
  models: Record<string, CcModel>;
  /** Claude Code said some model's cost was unknown to it (`hasUnknownModelCost`). */
  unknown?: true;
  /** The Claude Code version of the replies before it. */
  version?: string;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** A `cost-state` row, kept as numbers; undefined when it is not one. */
export function costStateRecord(e: any, version?: string): CostStateRecord | undefined {
  if (e?.type !== "cost-state" || typeof e.totalCostUSD !== "number" || !Number.isFinite(e.totalCostUSD)) return undefined;
  const models: Record<string, CcModel> = {};
  const mu = e.modelUsage && typeof e.modelUsage === "object" && !Array.isArray(e.modelUsage) ? e.modelUsage : {};
  for (const [m, v] of Object.entries(mu).slice(0, 40)) {
    if (!v || typeof v !== "object") continue;
    const u = v as Record<string, unknown>;
    models[m.slice(0, 100)] = {
      usd: num(u.costUSD), input: num(u.inputTokens), output: num(u.outputTokens), read: num(u.cacheReadInputTokens), write: num(u.cacheCreationInputTokens),
      write1h: num(u.cacheCreationEphemeral1hInputTokens), write5m: num(u.cacheCreationEphemeral5mInputTokens), searches: num(u.webSearchRequests),
    };
  }
  return {
    type: "cost-state", usd: Math.max(0, e.totalCostUSD), ...(num(e.startTime) ? { start: e.startTime } : {}), models,
    ...(e.hasUnknownModelCost === true ? { unknown: true as const } : {}), ...(version ? { version } : {}),
  };
}

/**
 * A request Claude Code sent, the model declined (a refusal), and Claude
 * Code sent again on another model (`model_refusal_fallback`): billed, and
 * no row records its usage. Kept by the usage scan as its model and time.
 */
export function refusalRecord(e: any): { type: "refusal"; model: string; timestamp?: string } | undefined {
  if (e?.type !== "system" || e.subtype !== "model_refusal_fallback" || typeof e.originalModel !== "string") return undefined;
  return { type: "refusal", model: e.originalModel.slice(0, 100), ...(typeof e.timestamp === "string" ? { timestamp: e.timestamp } : {}) };
}

/** A transcript's last `cost-state`, the time of the last reply before it (what it covers), and the declined requests before it, by model. */
export function lastCostState(rows: unknown[]): { cs: CostStateRecord; to: number; first?: number; declined: Record<string, number> } | undefined {
  let cs: CostStateRecord | undefined, to = NaN, last = NaN, first: number | undefined;
  let declined: Record<string, number> = {}, pending: Record<string, number> = {};
  for (const r of rows as Array<Record<string, any>>) {
    if (r?.type === "cost-state") {
      cs = r as CostStateRecord;
      to = last;
      for (const [m, n] of Object.entries(pending)) declined[m] = (declined[m] ?? 0) + n;
      pending = {};
      continue;
    }
    if (r?.type === "refusal") { pending[r.model] = (pending[r.model] ?? 0) + 1; continue; }
    if (r?.type !== "assistant") continue;
    const ts = Date.parse(String(r.timestamp ?? ""));
    if (!Number.isFinite(ts)) continue;
    last = ts;
    if (first === undefined) first = ts;
  }
  return cs && Number.isFinite(to) ? { cs, to, ...(first !== undefined ? { first } : {}), declined } : undefined;
}

/** One model's two figures in a comparison. */
export interface ModelGap {
  model: string;
  /** Claude Code's dollars and tokens. */
  ccUsd: number;
  cc: { input: number; output: number; read: number; write: number; searches: number };
  /** Ours, on the same requests. */
  ourUsd: number;
  ours: { input: number; output: number; read: number; write: number; requests: number };
  /** Claude Code's tokens at our prices (atOurPrices): an estimate. */
  ccAtOurUsd: number;
  /** Requests on it that it declined and Claude Code sent again on another model (refusalRecord). */
  declined?: number;
}

/** One session: Claude Code's figure and ours, and where the gap comes from. */
export interface SessionGap {
  session: string;
  project?: string;
  /** What both cover: from the session's start to the last reply before Claude Code's last record. */
  from: number;
  to: number;
  ccUsd: number;
  ourUsd: number;
  /** Of ours: the compactions' own requests, which we estimate (no row records their usage). */
  compactionUsd: number;
  compactions: number;
  version?: string;
  unknown?: true;
  models: ModelGap[];
}

/** The gap taken apart: each part is Claude Code's figure less ours, so they add up to ccUsd - ourUsd. */
export interface GapParts {
  /** Models no transcript row has, of requests the model declined and Claude Code sent again elsewhere. */
  declinedUsd: number;
  declined: number;
  declinedModels: string[];
  /** Other models no transcript row has: Claude Code's own side requests (its web searches among them). */
  sideUsd: number;
  sideModels: string[];
  sideSearches: number;
  /** On the models both count: its tokens less ours, priced at ours. */
  tokensUsd: number;
  /** Its dollars against ours on its own tokens: price. */
  priceUsd: number;
}

/** The parts of the gap of one or more sessions (see GapParts). */
export function gapParts(sessions: SessionGap[]): GapParts {
  const p: GapParts = { declinedUsd: 0, declined: 0, declinedModels: [], sideUsd: 0, sideModels: [], sideSearches: 0, tokensUsd: 0, priceUsd: 0 };
  const add = (list: string[], m: string) => { if (!list.includes(m)) list.push(m); };
  for (const s of sessions) {
    for (const m of s.models) {
      if (m.ours.requests === 0 && m.declined) {
        p.declinedUsd += m.ccUsd; p.declined += m.declined; add(p.declinedModels, m.model);
      } else if (m.ours.requests === 0) {
        p.sideUsd += m.ccUsd; p.sideSearches += m.cc.searches;
        if (m.ccUsd > 0) add(p.sideModels, m.model);
      } else {
        p.tokensUsd += m.ccAtOurUsd - m.ourUsd;
        p.priceUsd += m.ccUsd - m.ccAtOurUsd;
      }
    }
    // What its total holds beyond its models' lines (none seen): kept so the parts add up.
    p.priceUsd += s.ccUsd - s.models.reduce((n, m) => n + m.ccUsd, 0);
  }
  return p;
}

/**
 * A model line of Claude Code's priced at ours, as one request at `at`. The
 * tokens are a whole session's, not one prompt, so a long-prompt tier would
 * be misapplied: what it added is taken out. Writes Claude Code did not
 * split by lifetime (all of them before about 2.1.317, and in a session
 * resumed across that version the ones from before it: one of the author's
 * has 3.8M of 10.5M split) are priced at `writePerToken`, what ours cost
 * per token on the same model in the same session (each by its own
 * lifetime), else as 1-hour writes, Claude Code's main thread's.
 */
function atOurPrices(model: string, m: CcModel, at: number, writePerToken?: number): number {
  const w1h = Math.min(m.write, m.write1h), w5m = Math.min(m.write - w1h, m.write5m);
  const rest = m.write - w1h - w5m;
  const asOneHour = writePerToken === undefined ? rest : 0;
  const u: RecordedUsage = {
    input_tokens: m.input, output_tokens: m.output, cache_read_input_tokens: m.read, cache_creation_input_tokens: w1h + w5m + asOneHour,
    cache_creation: { ephemeral_1h_input_tokens: w1h + asOneHour, ephemeral_5m_input_tokens: w5m },
    server_tool_use: { web_search_requests: m.searches },
  };
  const c = requestCost(realModel(model), u, at);
  if (!c) return 0;
  return c.totalUsd - c.modifiers.longUsd + (writePerToken === undefined ? 0 : rest * writePerToken);
}

/**
 * The comparison for the sessions among `tops` whose Claude Code record and
 * our requests both fall inside [`since`, `until`]: `items` are spend's
 * Claude Code items (each request once, its session the transcript's name).
 * A session whose last record starts after its first reply (a record that
 * restarted on resume) is compared from where the record starts.
 */
export function compareSessions(tops: string[], items: SpendItem[], since = -Infinity, until = Infinity): SessionGap[] {
  const bySession = new Map<string, SpendItem[]>();
  for (const it of items) if (it.tool === "claude") (bySession.get(it.session) ?? bySession.set(it.session, []).get(it.session)!).push(it);
  const out: SessionGap[] = [];
  for (const top of tops) {
    let rec;
    try { rec = lastCostState(rowsOf(top, USAGE_ROWS)); } catch { continue; }
    if (!rec) continue;
    // From its start, which Claude Code sets a second or so before the first reply; a record that
    // restarted later (a resume that did not restore it) covers only from its own start.
    const start = rec.cs.start !== undefined && rec.first !== undefined && rec.cs.start > rec.first + 60_000 ? rec.cs.start : Math.min(rec.cs.start ?? Infinity, rec.first ?? rec.to);
    if (start < since || rec.to > until) continue;
    const session = basename(top, ".jsonl");
    const mine = (bySession.get(session) ?? []).filter((it) => it.ts >= start - 1000 && it.ts <= rec.to);
    out.push(sessionGap(session, rec.cs, mine, start, rec.to, rec.declined));
  }
  return out.sort((a, b) => b.ccUsd - a.ccUsd);
}

/** One session's figures, from Claude Code's record and our items over the same span. */
export function sessionGap(session: string, cs: CostStateRecord, mine: SpendItem[], from: number, to: number, declined: Record<string, number> = {}): SessionGap {
  const models = new Map<string, ModelGap>();
  const line = (model: string) => models.get(model) ?? models.set(model, { model, ccUsd: 0, cc: { input: 0, output: 0, read: 0, write: 0, searches: 0 }, ourUsd: 0, ours: { input: 0, output: 0, read: 0, write: 0, requests: 0 }, ccAtOurUsd: 0 }).get(model)!;
  let compactionUsd = 0, compactions = 0;
  const writeUsd = new Map<string, number>();
  for (const it of mine) {
    const g = line(it.model ?? "unknown");
    g.ourUsd += it.usd;
    g.ours.input += it.input; g.ours.output += it.output; g.ours.read += it.read; g.ours.write += it.write; g.ours.requests++;
    writeUsd.set(g.model, (writeUsd.get(g.model) ?? 0) + it.writeUsd);
    if (it.compaction) { compactionUsd += it.usd; compactions++; }
  }
  for (const [model, m] of Object.entries(cs.models)) {
    const g = line(realModel(model) ?? model);
    g.ccUsd += m.usd;
    g.cc.input += m.input; g.cc.output += m.output; g.cc.read += m.read; g.cc.write += m.write; g.cc.searches += m.searches;
    g.ccAtOurUsd += atOurPrices(model, m, to, g.ours.write > 0 ? writeUsd.get(g.model)! / g.ours.write : undefined);
  }
  for (const [model, n] of Object.entries(declined)) {
    const g = models.get(realModel(model) ?? model);
    if (g) g.declined = (g.declined ?? 0) + n;
  }
  return {
    session, ...(mine[0]?.project ? { project: mine[0].project } : {}), from, to, ccUsd: cs.usd, ourUsd: mine.reduce((n, it) => n + it.usd, 0), compactionUsd, compactions,
    ...(cs.version ? { version: cs.version } : {}), ...(cs.unknown ? { unknown: true as const } : {}),
    models: [...models.values()].sort((a, b) => b.ccUsd - a.ccUsd),
  };
}

/** The version that counts other mods' model calls in Claude Code's cost (CHANGELOG 2.1.325). */
export const MODS_COUNTED_FROM = "2.1.325";

/** a >= b, as dotted versions. */
export function versionAtLeast(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const x = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0), y = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return true;
}

const usd = (n: number) => (Math.abs(n) >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const more = (n: number) => `${usd(Math.abs(n))} ${n >= 0 ? "more" : "less"}`;
const list = (ms: string[]) => `${ms.slice(0, 2).join(", ")}${ms.length > 2 ? " and others" : ""}`;

/** Within this of Claude Code's figure is a match (ROADMAP K2, F1). */
export const CC_GAP_TARGET = 0.02;
/** Below this, Claude Code's figure for a session is too small for a percentage to mean anything. */
const MIN_COMPARE_USD = 0.5;

/** What the gap is made of, in words, largest part first: what Claude Code's figure holds more (or less) than ours, and why. */
export function gapText(sessions: SessionGap[]): string[] {
  const p = gapParts(sessions);
  const comp = sessions.reduce((n, s) => n + s.compactionUsd, 0), nComp = sessions.reduce((n, s) => n + s.compactions, 0);
  const parts: Array<[number, string]> = [];
  if (Math.abs(p.declinedUsd) >= 0.005) parts.push([p.declinedUsd, `Claude Code counts ${more(p.declinedUsd)} on ${list(p.declinedModels)}, requests it declined (${p.declined} refusal${p.declined === 1 ? "" : "s"} recorded) and Claude Code sent again on another model: no row records their usage`]);
  if (Math.abs(p.sideUsd) >= 0.005) parts.push([p.sideUsd, `Claude Code counts ${more(p.sideUsd)} on ${list(p.sideModels)}, its own side requests${p.sideSearches ? ` (${p.sideSearches} web search${p.sideSearches === 1 ? "" : "es"} among them)` : ""}: no transcript row records them`]);
  // Ours holds the compactions' own requests as estimates (no row records their usage): what its tokens say of them.
  const compText = nComp ? `${nComp} compaction${nComp === 1 ? "'s" : "s'"} own request${nComp === 1 ? "" : "s"}, which we estimate at ${usd(comp)}` : "";
  if (Math.abs(p.tokensUsd) >= 0.005) {
    parts.push([p.tokensUsd, p.tokensUsd > 0
      ? `Claude Code counts ${more(p.tokensUsd)} in tokens on the same models, at our prices: requests no row records the usage of${compText ? `, beyond our ${compText}` : ""}`
      : `Claude Code counts ${more(p.tokensUsd)} in tokens on the same models, at our prices: ${compText ? `our ${compText}, are above what it counted` : "requests we count that it does not"}`]);
  }
  if (Math.abs(p.priceUsd) >= 0.005) parts.push([p.priceUsd, `Its prices come to ${more(p.priceUsd)} than ours on its own tokens (its price table, fast mode, a long prompt's tier, contracted rates)`]);
  const lines = parts.sort((a, b) => Math.abs(b[0]) - Math.abs(a[0])).map(([, t]) => t);
  if (sessions.some((s) => versionAtLeast(s.version, MODS_COUNTED_FROM))) lines.push(`From Claude Code ${MODS_COUNTED_FROM} its figure also counts other mods' own model calls, in the parts above`);
  if (sessions.some((s) => s.unknown)) lines.push("Claude Code said it had no price for some model: its figure leaves that model out");
  return lines;
}

/** `spend`'s lines: Claude Code's figure beside ours on the sessions both cover; none when no session has a record in the window. */
export function renderComparison(sessions: SessionGap[]): string[] {
  if (!sessions.length) return [];
  const cc = sessions.reduce((n, s) => n + s.ccUsd, 0), ours = sessions.reduce((n, s) => n + s.ourUsd, 0);
  const n = sessions.length;
  const worth = sessions.filter((s) => s.ccUsd >= MIN_COMPARE_USD);
  const within = worth.filter((s) => Math.abs(s.ourUsd - s.ccUsd) <= CC_GAP_TARGET * s.ccUsd).length;
  const lines = [
    `Claude Code's own figure (its cost-state), ${n} session${n === 1 ? "" : "s"} wholly in the window: ${usd(cc)}; ours ${usd(ours)}${cc > 0 ? ` (${pct((ours - cc) / cc)})` : ""}`,
    ...(worth.length ? [`  ${within} of the ${worth.length} over ${usd(MIN_COMPARE_USD)} within ${CC_GAP_TARGET * 100}% of it (context-doctor session <file> shows one)`] : []),
  ];
  for (const t of gapText(sessions)) lines.push(`  ${t}`);
  return lines;
}

/** `session`'s lines for one session; none when its transcript has no record. */
export function renderSessionComparison(s: SessionGap | undefined): string[] {
  if (!s) return [];
  const lines = [`Claude Code's own figure for this session: ${usd(s.ccUsd)}; ours ${usd(s.ourUsd)}${s.ccUsd > 0 ? ` (${pct((s.ourUsd - s.ccUsd) / s.ccUsd)})` : ""}, to ${new Date(s.to).toISOString().slice(0, 16).replace("T", " ")} UTC (its last record)`];
  for (const t of gapText([s])) lines.push(`  ${t}`);
  return lines;
}

/** `doctor`'s check: how close our price is to Claude Code's own, session by session. Undefined when no session has a record worth comparing. */
export function comparisonCheck(sessions: SessionGap[], days: number): { label: string; status: "ok" | "warn"; detail: string } | undefined {
  const worth = sessions.filter((s) => s.ccUsd >= MIN_COMPARE_USD);
  if (!worth.length) return undefined;
  const label = "Our price vs Claude Code's own";
  const cc = worth.reduce((n, s) => n + s.ccUsd, 0), ours = worth.reduce((n, s) => n + s.ourUsd, 0);
  const gap = (ours - cc) / cc;
  const within = worth.filter((s) => Math.abs((s.ourUsd - s.ccUsd) / s.ccUsd) <= CC_GAP_TARGET).length;
  const head = `${usd(ours)} against Claude Code's ${usd(cc)} (${pct(gap)}) on ${worth.length} session${worth.length === 1 ? "" : "s"} of the last ${days} days (its cost-state records); ${within} within ${CC_GAP_TARGET * 100}%`;
  if (Math.abs(gap) <= CC_GAP_TARGET) return { label, status: "ok", detail: head };
  return { label, status: "warn", detail: `${head}. The gap: ${gapText(worth).join("; ")}` };
}

