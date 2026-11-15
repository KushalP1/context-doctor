/**
 * Cold returns: a main-conversation request after the prompt cache it left
 * expired, which writes the whole context again. On the author's 30 days
 * (2026-11-15) they were the largest cost no lever reached: 183 returns,
 * $864 above cache-read price (26% of spend), $760 of it on contexts over
 * 300k. `cache-misses` reports them here, each one replayed three ways:
 *
 *  - as it went: the return as billed (requestCost, the same figure `spend`
 *    adds up);
 *  - compacted on return: the cold-resume replay's estimate (coldresume.ts),
 *    /compact right after the return, net of the compaction, counting what it
 *    saves on the requests after it until the next return;
 *  - kept warm: a cache read of the whole context every 55 minutes while away
 *    (4.5 minutes on a 5-minute cache), so the return reads the context
 *    instead of writing it. A ping is the context at the cache-read rate plus
 *    a short prompt and reply (Claude Code's mods API `$.model.fork`: the main
 *    thread's last request again, with one message after it, nothing kept in
 *    the transcript).
 *
 * By how long the person was away. The replay knows the gap; a keep-warm
 * timer does not, so the policies below price keeping warm for up to N
 * hours, counting every ping it would have sent: every pause past the first
 * ping, the returns past the cap (cold anyway) and the sessions never
 * returned to.
 *
 * Also #107157 (anthropics/claude-code): the Desktop app's transcript gains a
 * copy of a segment a compaction had already removed (its rows, its
 * `compact_boundary` included, with their original uuids), and a resume then
 * rebuilds the conversation through it: one request went from 390k to 862k
 * tokens and wrote 817k to the cache. Found here as a compaction boundary
 * whose uuid the transcript already held, followed by a jump in context with
 * no real compaction between.
 */

import { listSessions, isClaudeSession, replyCounter } from "./session.js";
import { rowsOf } from "./scan.js";
import { coldResumeEvents, REQUEST_ROWS, writtenTtlMs } from "./coldresume.js";
import { rateCard, ratesAt, requestCost, type ModelPricing } from "./pricing.js";
import { formatTokens, realModel } from "./tokens.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const FIVE_MIN = 5 * MIN;
/** Smaller previous contexts are noise (as `cache-misses`). */
const MIN_CONTEXT = 20_000;
/** A return that wrote more than this share of the previous context wrote it again. */
const REWRITE_SHARE = 0.6;
/** A ping every this long keeps a 1-hour cache warm (5 minutes of margin)... */
export const PING_EVERY_1H_MS = 55 * MIN;
/** ...and a 5-minute one (30 seconds of margin). */
export const PING_EVERY_5M_MS = 270_000;
/** A ping's own prompt (uncached) and reply, a short answer and a little thinking: an estimate. */
export const PING_PROMPT_TOKENS = 30;
export const PING_OUTPUT_TOKENS = 100;
/** The keep-warm caps priced, hours. */
export const KEEP_WARM_HOURS = [1, 2, 4, 8];
/** A jump in context this large after a copied segment is #107157's. */
const READDED_MIN_TOKENS = 100_000;
const READDED_MIN_SHARE = 1.3;

export const GAP_BUCKETS = ["<1h", "1-2h", "2-4h", "4-8h", ">8h"] as const;
export type GapBucket = (typeof GAP_BUCKETS)[number];
export function gapBucket(ms: number): GapBucket {
  return ms < HOUR ? "<1h" : ms < 2 * HOUR ? "1-2h" : ms < 4 * HOUR ? "2-4h" : ms < 8 * HOUR ? "4-8h" : ">8h";
}

export const pingEveryMs = (ttlMs: number): number => (ttlMs >= HOUR ? PING_EVERY_1H_MS : PING_EVERY_5M_MS);
/** Pings a timer sends in a pause of `gapMs`: one each `every` until the person is back. */
export const pingsIn = (gapMs: number, every: number): number => Math.max(0, Math.ceil(gapMs / every) - 1);
/** One ping: the context read from the cache, the ping's prompt and its reply. */
export function pingUsd(contextTokens: number, p: ModelPricing): number {
  return (contextTokens * p.cacheReadPerM + PING_PROMPT_TOKENS * p.inputPerM + PING_OUTPUT_TOKENS * p.outputPerM) / 1e6;
}

export interface ColdReturn {
  path: string;
  at: number;
  gapMs: number;
  /** The lifetime of the cache the previous request left. */
  ttlMs: number;
  model: string;
  /** The previous request's whole context: what a warm cache would have served. */
  contextTokens: number;
  tokens: number;
  writeTokens: number;
  /** As it went: the request as billed. */
  billedUsd: number;
  /** The part of it above cache-read price: the context written again. */
  rewriteUsd: number;
  /** Compacted on return: billed minus the compaction's net saving (undefined: not offered, under 150k or within 5 minutes of the lifetime). */
  compactedUsd?: number;
  /** Kept warm: billed without the re-write, plus the pings. A model switch misses anyway: no re-write avoided. */
  keptWarmUsd: number;
  pings: number;
  /** One ping's price on this context. */
  pingUsd: number;
  sameModel: boolean;
}

/** A pause a keep-warm timer would have pinged through: every gap between main requests, and the time since the last. */
export interface Pause {
  gapMs: number;
  ttlMs: number;
  pingUsd: number;
  /** The rewrite a ping would have avoided: a cold return on the same model (0 otherwise). */
  avoidableUsd: number;
}

/** #107157: a segment a compaction removed, put back. */
export interface ReAdded {
  path: string;
  /** When the copy of the old compaction boundary was written. */
  copiedAt: number;
  /** The request whose context jumped, and by how much. */
  at: number;
  fromTokens: number;
  toTokens: number;
  writeTokens: number;
  /** The jump written to the cache, at the request's own write rate. */
  extraWriteUsd: number;
  /** What each later request pays to read it again. */
  perRequestUsd: number;
}

export interface KeepWarmPolicy {
  hours: number;
  pings: number;
  pingUsd: number;
  /** Cold returns it would have kept warm, and the re-writes they would not have paid. */
  keptWarm: number;
  avoidedUsd: number;
  netUsd: number;
}

export interface GapRow {
  bucket: GapBucket | "all";
  returns: number;
  asItWentUsd: number;
  rewriteUsd: number;
  compactedUsd: number;
  keptWarmUsd: number;
  pings: number;
  cheapest: "as it went" | "compacted" | "kept warm";
}

export interface ColdReturnReport {
  days: number;
  returns: number;
  billedUsd: number;
  rewriteUsd: number;
  /** Of rewriteUsd, on previous contexts over 300k. */
  over300kUsd: number;
  byGap: GapRow[];
  total: GapRow;
  policies: KeepWarmPolicy[];
  /** The cap that nets the most, when any nets more than nothing. */
  best?: KeepWarmPolicy;
  readded: ReAdded[];
  /** For `--json`: the costliest returns. */
  largest: ColdReturn[];
}

interface Req { at: number; total: number; write: number; u: any; model: string; ttl: number; copy: boolean }

/** One transcript's cold returns, pauses and re-added segments; `now` ends the last pause. */
export function coldReturnsInTranscript(path: string, since = 0, now = Date.now(), runRows?: Set<string>, coldRows?: Set<string>): { returns: ColdReturn[]; pauses: Pause[]; readded: ReAdded[] } {
  const returns: ColdReturn[] = [], pauses: Pause[] = [], readded: ReAdded[] = [];
  const sighting = replyCounter(runRows);
  const boundaries = new Set<string>();
  let ttl = HOUR;
  let prev: Req | undefined;
  /** A real compaction since prev, and when. */
  let compactedAt: number | undefined;
  /** A copied boundary (#107157) not yet followed by a real compaction, and the context before it. */
  let copied: { at: number; before?: number } | undefined;
  for (const e of rowsOf<any>(path, REQUEST_ROWS)) {
    if (!e || e.isSidechain) continue;
    if (e.type === "system" && e.subtype === "compact_boundary") {
      const at = Date.parse(e.timestamp);
      if (typeof e.uuid === "string" && boundaries.has(e.uuid)) {
        // A copy of a boundary already in the file: the segment after it was compacted away once.
        copied ??= { at, before: prev?.total };
        continue;
      }
      if (typeof e.uuid === "string") boundaries.add(e.uuid);
      if (Number.isFinite(at)) compactedAt = at;
      copied = undefined;
      continue;
    }
    if (e.type !== "assistant" || !e.message?.usage) continue;
    const seen = sighting(e);
    if (seen === "repeat") continue;
    const model = realModel(e.message.model);
    const at = Date.parse(e.timestamp);
    const u = e.message.usage;
    const write = num(u.cache_creation_input_tokens);
    const total = num(u.input_tokens) + num(u.cache_read_input_tokens) + write;
    if (!model || !Number.isFinite(at) || !(total > 0)) continue;
    const prevTtl = ttl;
    ttl = writtenTtlMs(u) ?? ttl;
    const r: Req = { at, total, write, u, model, ttl, copy: seen === "copy" };
    if (prev && at >= since && prev.total > MIN_CONTEXT) {
      // The pause a keep-warm timer would have pinged through: until the person came back, or until a compaction.
      const gap = (compactedAt ?? at) - prev.at;
      const card = rateCard(prev.model, prev.u, prev.at);
      const ping = card ? pingUsd(prev.total, ratesAt(card, prev.total)) : 0;
      let avoidable = 0;
      if (compactedAt === undefined && gap > prevTtl && write > REWRITE_SHARE * prev.total && !r.copy) {
        const c = requestCost(model, u, at);
        if (c) {
          const rewrite = write > 0 ? (Math.min(write, prev.total) * (c.writeUsd / write - c.rates.cacheReadPerM / 1e6)) : 0;
          const sameModel = prev.model === model;
          const pings = pingsIn(gap, pingEveryMs(prevTtl));
          avoidable = sameModel ? rewrite : 0;
          returns.push({
            path, at, gapMs: gap, ttlMs: prevTtl, model, contextTokens: prev.total, tokens: total, writeTokens: write,
            billedUsd: c.totalUsd, rewriteUsd: rewrite,
            keptWarmUsd: c.totalUsd - avoidable + pings * ping, pings, pingUsd: ping, sameModel,
          });
        }
      }
      pauses.push({ gapMs: gap, ttlMs: prevTtl, pingUsd: ping, avoidableUsd: avoidable });
    }
    if (copied && prev && at >= since && compactedAt === undefined && total > prev.total * READDED_MIN_SHARE && total - prev.total > READDED_MIN_TOKENS) {
      const c = requestCost(model, u, at);
      const jump = total - prev.total;
      const writeRate = c && write > 0 ? c.writeUsd / write : 0;
      readded.push({
        path, copiedAt: copied.at, at, fromTokens: prev.total, toTokens: total, writeTokens: write,
        extraWriteUsd: Math.min(jump, write) * writeRate,
        perRequestUsd: c ? (jump * c.rates.cacheReadPerM) / 1e6 : 0,
      });
      copied = undefined;
    }
    prev = r;
    compactedAt = undefined;
  }
  // The pause after the last request: a timer pings it until the cap whether or not the person comes back.
  if (prev && prev.at >= since && prev.total > MIN_CONTEXT && compactedAt === undefined && now > prev.at) {
    const card = rateCard(prev.model, prev.u, prev.at);
    pauses.push({ gapMs: now - prev.at, ttlMs: ttl, pingUsd: card ? pingUsd(prev.total, ratesAt(card, prev.total)) : 0, avoidableUsd: 0 });
  }
  // Compacted on return: the cold-resume replay's figure for the same request.
  if (returns.length) {
    const net = new Map(coldResumeEvents(path, undefined, undefined, coldRows).map((c) => [c.at, c.netUsd]));
    for (const r of returns) {
      const n = net.get(r.at);
      if (n !== undefined) r.compactedUsd = r.billedUsd - n;
    }
  }
  return { returns, pauses, readded };
}

const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);

/** Keeping warm for up to `hours` after each request, not knowing when the person is back. */
export function keepWarmPolicy(pauses: Pause[], hours: number): KeepWarmPolicy {
  let pings = 0, usd = 0, kept = 0, avoided = 0;
  for (const p of pauses) {
    const every = pingEveryMs(p.ttlMs);
    const all = pingsIn(p.gapMs, every);
    const sent = Math.min(all, Math.floor((hours * HOUR) / every));
    pings += sent;
    usd += sent * p.pingUsd;
    // Kept warm only when the pings lasted until the return.
    if (p.avoidableUsd > 0 && sent === all) {
      kept++;
      avoided += p.avoidableUsd;
    }
  }
  return { hours, pings, pingUsd: usd, keptWarm: kept, avoidedUsd: avoided, netUsd: avoided - usd };
}

function row(bucket: GapRow["bucket"], rs: ColdReturn[]): GapRow {
  const sum = (f: (r: ColdReturn) => number) => rs.reduce((n, r) => n + f(r), 0);
  const asItWentUsd = sum((r) => r.billedUsd);
  const compactedUsd = sum((r) => r.compactedUsd ?? r.billedUsd);
  const keptWarmUsd = sum((r) => r.keptWarmUsd);
  const least = Math.min(asItWentUsd, compactedUsd, keptWarmUsd);
  return {
    bucket,
    returns: rs.length,
    asItWentUsd,
    rewriteUsd: sum((r) => r.rewriteUsd),
    compactedUsd,
    keptWarmUsd,
    pings: sum((r) => r.pings),
    cheapest: least === asItWentUsd ? "as it went" : least === keptWarmUsd ? "kept warm" : "compacted",
  };
}

/** Every main transcript of the last `days` (or `paths`). */
export function coldReturns(days = 30, paths?: string[], now = Date.now()): ColdReturnReport {
  const since = now - days * 86_400_000;
  const targets = paths ?? listSessions(10_000).filter((s) => isClaudeSession(s) && s.modifiedAt.getTime() >= since).map((s) => s.path);
  const returns: ColdReturn[] = [], pauses: Pause[] = [], readded: ReAdded[] = [];
  const runRows = new Set<string>(), coldRows = new Set<string>();
  for (const p of targets) {
    try {
      const one = coldReturnsInTranscript(p, since, now, runRows, coldRows);
      returns.push(...one.returns);
      pauses.push(...one.pauses);
      readded.push(...one.readded);
    } catch {
      /* one unreadable transcript must not sink the report */
    }
  }
  const policies = KEEP_WARM_HOURS.map((h) => keepWarmPolicy(pauses, h));
  const best = policies.reduce<KeepWarmPolicy | undefined>((b, p) => (p.netUsd > (b?.netUsd ?? 0) ? p : b), undefined);
  return {
    days,
    returns: returns.length,
    billedUsd: returns.reduce((n, r) => n + r.billedUsd, 0),
    rewriteUsd: returns.reduce((n, r) => n + r.rewriteUsd, 0),
    over300kUsd: returns.filter((r) => r.contextTokens > 300_000).reduce((n, r) => n + r.rewriteUsd, 0),
    byGap: GAP_BUCKETS.map((b) => row(b, returns.filter((r) => gapBucket(r.gapMs) === b))).filter((r) => r.returns > 0),
    total: row("all", returns),
    policies,
    best,
    readded: readded.sort((a, b) => b.extraWriteUsd - a.extraWriteUsd),
    largest: [...returns].sort((a, b) => b.rewriteUsd - a.rewriteUsd).slice(0, 10),
  };
}

/** "$1,925", "$12.26", "$0". */
function money(n: number): string {
  if (!(Math.abs(n) > 0)) return "$0";
  if (n < 0) return `-${money(-n)}`;
  if (n >= 100) return `$${Math.round(n).toLocaleString("en-US")}`;
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  return "<$0.01";
}

/** The `cache-misses` section, or nothing when there were no cold returns. */
export function renderColdReturns(r: ColdReturnReport): string[] {
  const out: string[] = [];
  if (r.returns > 0) {
    out.push(
      "COLD RETURNS: BACK AFTER THE CACHE EXPIRED",
      "─".repeat(60),
      `${r.returns} return${r.returns === 1 ? "" : "s"} to a conversation after its cache expired wrote the`,
      `context again: ${money(r.billedUsd)} billed, ${money(r.rewriteUsd)} of it above cache-read price` + (r.over300kUsd > 0 ? "" : "."),
      ...(r.over300kUsd > 0 ? [`(${money(r.over300kUsd)} on contexts over 300k).`] : []),
      "",
      "Each return three ways, by how long you were away:",
      `  ${"away".padEnd(6)} ${"returns".padStart(7)} ${"as it went".padStart(11)} ${"compacted".padStart(10)} ${"kept warm".padStart(10)}  cheapest`,
    );
    for (const g of [...r.byGap, r.total]) {
      out.push(`  ${g.bucket.padEnd(6)} ${String(g.returns).padStart(7)} ${money(g.asItWentUsd).padStart(11)} ${money(g.compactedUsd).padStart(10)} ${money(g.keptWarmUsd).padStart(10)}  ${g.cheapest}`);
    }
    out.push(
      "As it went: the returns as billed. Compacted: /compact right after the",
      "return, net of the compaction, with what it saves on the requests after it",
      "until the next return (offered over 150k tokens). Kept warm: a cache read of",
      "the whole context every 55 min while away (4.5 min on a 5-minute cache) and",
      `~${PING_OUTPUT_TOKENS} output tokens each, so the return reads it instead of writing it.`,
      "Each alone; the replay knows the gap, which a timer does not.",
    );
    if (r.policies.some((p) => p.pings > 0)) {
      out.push("", "Keeping warm without knowing when you come back, for up to:");
      for (const p of r.policies) {
        out.push(`  ${`${p.hours} h`.padEnd(4)} ${String(p.pings).padStart(6)} pings ${money(p.pingUsd).padStart(8)}, ${`${p.keptWarm} return${p.keptWarm === 1 ? "" : "s"} kept warm`.padEnd(20)} ${money(p.avoidedUsd).padStart(8)}, net ${money(p.netUsd)}`);
      }
      out.push(
        "Pings count every pause past 55 minutes (4.5 on a 5-minute cache), the",
        "returns after the cap (cold anyway) and the sessions never returned to.",
      );
      out.push(
        ...(r.best
          ? [
              `Kept warm up to ${r.best.hours} h would have saved ${money(r.best.netUsd)} net. In Claude Code with the`,
              `plugin, type /context-doctor-keep-warm ${r.best.hours}h before you step away: it pings only`,
              "after that, stops at the cap or its dollar limit, and never arms itself.",
              "On a subscription the pings come out of your usage limit, as the re-writes",
              "they replace do.",
            ]
          : ["No cap nets a saving on your history: the pings would cost more than the", "re-writes they avoid."]),
      );
    }
  }
  if (r.readded.length) {
    if (out.length) out.push("");
    const extra = r.readded.reduce((n, x) => n + x.extraWriteUsd, 0);
    const worst = r.readded[0];
    out.push(
      `A compacted segment put back (anthropics/claude-code#107157): ${r.readded.length} time${r.readded.length === 1 ? "" : "s"} the`,
      "transcript held a copy of history a compaction had removed, and the context",
      `jumped after it (worst ~${formatTokens(worst.fromTokens)} to ~${formatTokens(worst.toTokens)} tokens): ${money(extra)} written to the cache again,`,
      `and each later request re-reads it (~${money(worst.perRequestUsd)} each in the worst).`,
      "/compact again only summarizes it again: start a new session from a handoff",
      "(context-doctor handoff) or /clear.",
    );
    for (const x of r.readded.slice(0, 5)) {
      const file = x.path.split(/[\\/]/).pop()?.slice(0, 12) ?? "";
      out.push(`  ${new Date(x.at).toISOString().slice(0, 16).replace("T", " ")}  ~${formatTokens(x.fromTokens)} to ~${formatTokens(x.toTokens)}, ${money(x.extraWriteUsd)}  ${file}`);
    }
  }
  return out;
}
