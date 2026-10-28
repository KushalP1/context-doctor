/**
 * `context-doctor cache-misses`: requests that re-wrote the prompt cache while
 * it should still have been warm.
 *
 * Claude Code caches the conversation as it goes; the next request within the
 * cache's lifetime reads that prefix at the cache-read rate (5-10% of input)
 * and writes only what is new. When a request instead writes most of the
 * context again, at 1.25x input (2x at the 1-hour TTL), the cache missed.
 * Some misses are expected (a model switch: each model has its own cache;
 * a compaction: a new history), the rest are invisible from the client.
 *
 * Definition, request by request over each main-chain transcript:
 *  - two consecutive requests (sidechains and synthetic replies skipped),
 *    with no compaction (compact_boundary) between them;
 *  - the gap under the cache lifetime of both: 1 hour when the request wrote
 *    to the 1-hour cache (usage.cache_creation.ephemeral_1h_input_tokens > 0),
 *    else 5 minutes;
 *  - the previous request's context over 20k tokens (smaller ones are noise);
 *  - a miss when the request's cache_creation_input_tokens exceed 60% of the
 *    previous request's whole context (input + cache read + cache write).
 *
 * Priced above what the same tokens would have cost as cache reads: the
 * re-written part (up to the previous context) at the write rate minus the
 * read rate. Measured on the author's last 30 days (Oct 2026): 390 misses in
 * 29,287 requests, ~$1,925 above cache-read price, 28% of all cache-write
 * spend; 382 of them with nothing in the transcript to explain them.
 *
 * Next to them, the re-writes that came just too late: a request less than
 * 25% past the cache's lifetime (under 75 minutes after a 1-hour entry,
 * under 6:15 after a 5-minute one) that wrote the context again. A person
 * back from a break, or a loop whose interval sits on the TTL: an agent that
 * woke every 61-62 minutes paid $248 of $285 in cache writes over 89
 * wake-ups (anthropics/claude-code#104736). Three or more in a row in one
 * session, at the same interval (within 90 s or 2%), are named as a loop,
 * with the interval that keeps the cache warm.
 */

import { forEachLine, listSessions, isClaudeSession } from "./session.js";
import { estimateTokens, formatTokens, realModel } from "./tokens.js";
import { CACHE_WRITE_1H, CACHE_WRITE_5M, pricingFor } from "./pricing.js";
import { compareVersions } from "./modelswitch.js";
import { diagnosedMisses, missLogPath, type DiagnosedMisses } from "./missledger.js";

/** Dollars as a person reads them: "$1,925", "$12.26", "$0". */
function money(n: number): string {
  if (!(n > 0)) return "$0";
  if (n >= 100) return `$${Math.round(n).toLocaleString("en-US")}`;
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  return "<$0.01";
}

const FIVE_MIN = 300_000;
const HOUR = 3_600_000;
/** Below this the previous context is too small for a miss to matter (or to be told from noise). */
const MIN_CONTEXT = 20_000;
/** A request that writes more than this share of the previous context re-wrote it. */
const MISS_SHARE = 0.6;
/** Anthropic's cache looks back at most this many blocks from a breakpoint for an earlier hit. */
const LOOKBACK_BLOCKS = 20;

export type MissCause = "model switch" | "context edited" | "after an API error" | "over 20 new blocks" | "nothing visible";

export interface CacheMiss {
  path: string;
  /** ISO time of the request that missed. */
  at: string;
  model: string;
  previousModel: string;
  /** The previous request's whole context: what should have been read from cache. */
  contextTokens: number;
  writeTokens: number;
  /** Cache read on the miss as a share of the previous context (the part that still matched). */
  readShare: number;
  gapSeconds: number;
  cause: MissCause;
  /** Above the cache-read price; undefined when the model has no known price. */
  extraUsd?: number;
}

/** A request that re-wrote the cache less than 25% past its lifetime. */
export interface LateRewrite {
  path: string;
  at: string;
  model: string;
  /** The lifetime of the entry it missed (the previous request's), seconds. */
  ttlSeconds: number;
  gapSeconds: number;
  contextTokens: number;
  writeTokens: number;
  /** Above the cache-read price; undefined when the model has no known price. */
  extraUsd?: number;
  /** Its number among the transcript's cold starts: consecutive ones had no other cold start between. */
  cold?: number;
}

/** A gap this far past the TTL still counts as "just too late". */
const LATE_SHARE = 0.25;
/** This many late re-writes in one session are a loop on the TTL, not chance. */
const LOOP_MIN = 3;

export interface MissStats {
  /** Requests that could have read a warm cache (the definition above). */
  eligible: number;
  misses: number;
  rate: number;
  extraUsd: number;
}

export interface CacheMissReport {
  days: number;
  transcripts: number;
  /** Every main-chain request with usage in the period. */
  requests: number;
  eligible: number;
  misses: number;
  missWriteTokens: number;
  /** Misses priced above cache-read price (priced models only). */
  extraUsd: number;
  /** All cache writes in the period, priced: the share the misses take of it. */
  cacheWriteUsd: number;
  /** Misses on models with no known price (not in extraUsd). */
  unpricedMisses: number;
  byModel: Array<{ model: string } & MissStats>;
  bySize: Array<{ bucket: string } & MissStats>;
  causes: Record<MissCause, number>;
  /** Advice the data supports (model versions with fewer misses, context size), possibly none. */
  recommendations: string[];
  /** The costliest misses. */
  largest: CacheMiss[];
  /** The same requests by the Claude Code version that sent them (oldest first). */
  byVersion: VersionStats[];
  /** Step changes from one version to the next that the numbers support. */
  regressions: Regression[];
  /**
   * Claude Code's own diagnosis of each miss in the period, as the status line
   * logged it (2.1.260+). Its definition of a miss is Claude Code's, wider
   * than the one above (it counts a cold cache after a pause too).
   */
  diagnosed: DiagnosedMisses;
  /** Re-writes less than 25% past the cache lifetime, and the sessions with a loop on it. */
  late: {
    rewrites: number;
    tokens: number;
    extraUsd: number;
    loops: Array<{ path: string; rewrites: number; medianGapSeconds: number; ttlSeconds: number; extraUsd: number }>;
    largest: LateRewrite[];
  };
}

/** One Claude Code version's requests (the `version` every transcript line carries). */
export interface VersionStats {
  version: string;
  /** Main-chain requests, and the transcripts they came from. */
  requests: number;
  sessions: number;
  /** First requests of new sessions: the fixed overhead (system prompt, tools, memory), median. */
  firstRequests: number;
  firstMedian?: number;
  /** Cache-write tokens per request, mean. */
  writesPerRequest: number;
  /** Share of cache writes at the 1-hour TTL (Claude Code's main thread writes almost all at 1 h). */
  oneHourShare?: number;
  /** Warm requests and misses, by the definition above. */
  eligible: number;
  misses: number;
  missRate: number;
  /** The same per model (a version's rate mostly follows the models it ran). */
  byModel: Array<{ model: string; eligible: number; misses: number }>;
  /** The 1-hour share per model and surface. */
  ttlBy: Array<{ key: string; requests: number; oneHourShare?: number }>;
  /** First and last time the version was seen. */
  from: string;
  to: string;
}

export interface Regression {
  metric: "1-hour cache share" | "first request" | "miss rate";
  from: string;
  to: string;
  before: number;
  after: number;
  /** In words, with the numbers. */
  text: string;
}

const SIZE_BUCKETS: Array<[string, number]> = [["<100k", 100_000], ["100-300k", 300_000], ["300-600k", 600_000], ["600k+", Infinity]];
const bucketOf = (tokens: number): string => SIZE_BUCKETS.find(([, max]) => tokens < max)![0];

const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);

interface Prev {
  at: number;
  total: number;
  model: string;
  ttl: number;
}

/** Misses in one transcript; `since` drops requests before it. */
/** What `onRequest` is told about each main-chain request in the period. */
export interface RequestInfo {
  at: number;
  /** The Claude Code version on the transcript line, when recorded. */
  version?: string;
  write: number;
  oneHour: number;
  fiveMinute: number;
  /** The session's first request, minus its first user message: the fixed overhead. Only on that request. */
  first?: number;
  model?: string;
  /** The Claude Code surface (cli, claude-vscode, claude-desktop...): it can choose the cache TTL too. */
  entrypoint?: string;
}

export function missesInTranscript(
  path: string,
  since = 0,
  add: (eligible: { model: string; contextTokens: number; version?: string }, miss?: CacheMiss) => void = () => {},
  onRequest: (writeUsd: number, info: RequestInfo) => void = () => {},
  /** Shared by every transcript of one report: a fork's copied rows (same uuids) have no first request of their own. */
  runRows?: Set<string>,
  onLate: (late: LateRewrite) => void = () => {}
): void {
  let prev: Prev | undefined;
  let lastId: string | undefined;
  let compacted = false;
  let apiError = false;
  let blocks = 0;
  let edited = false;
  let firstUser: string | undefined;
  let started = false;
  // Requests that found the cache past its lifetime, numbered in order: two
  // late re-writes are consecutive when no other cold start came between.
  let colds = 0;
  forEachLine(path, (line) => {
    // Cheap row counting without a parse: Claude Code writes one row per
    // content block, so main-chain rows since the last request are the blocks
    // it added (what the 20-block lookback counts).
    const usage = line.includes('"usage"');
    if (!usage && !line.includes("compact_boundary") && !line.includes("api_error")) {
      if ((line.includes('"type":"user"') || line.includes('"type":"assistant"')) && !line.includes('"isSidechain":true')) {
        blocks++;
        // The first thing the user typed: part of the first request, not of the overhead.
        if (!started && firstUser === undefined && line.includes('"type":"user"') && !line.includes('"isMeta":true')) {
          try {
            const e = JSON.parse(line);
            const c = e?.message?.content;
            const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("\n") : "";
            if (text) firstUser = text;
          } catch {
            /* not a row */
          }
        }
      }
      return;
    }
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (!e || typeof e !== "object" || e.isSidechain) return;
    if (e.type === "system" && e.subtype === "compact_boundary") {
      compacted = true;
      return;
    }
    if (e.type === "system" && e.subtype === "api_error") {
      apiError = true;
      return;
    }
    if (e.type === "user" || e.type === "assistant") blocks++;
    const msg = e.message;
    if (e.type !== "assistant" || !msg?.usage) return;
    // One reply is written as several rows sharing its id and usage: count it once.
    if (typeof msg.id === "string" && msg.id === lastId) return;
    lastId = typeof msg.id === "string" ? msg.id : undefined;
    const model = realModel(msg.model);
    if (!model) return;
    const at = Date.parse(String(e.timestamp ?? ""));
    if (!Number.isFinite(at)) return;
    const u = msg.usage;
    const write = num(u.cache_creation_input_tokens);
    const read = num(u.cache_read_input_tokens);
    const total = write + read + num(u.input_tokens);
    const oneHour = num(u.cache_creation?.ephemeral_1h_input_tokens) > 0;
    const ttl = oneHour ? HOUR : FIVE_MIN;
    const cm = u.context_management ?? msg.context_management;
    const cmText = cm ? JSON.stringify(cm) : "";
    if (cmText.includes("applied") && !/"applied_edits"\s*:\s*\[\s*\]/.test(cmText)) edited = true;

    const version = typeof e.version === "string" && /^\d+\.\d+\.\d+$/.test(e.version) ? e.version : undefined;
    // A transcript that opens with a parent's copied rows (a fork) has no
    // first request of its own: the parent's file holds the same uuid.
    const uuid = typeof e.uuid === "string" ? e.uuid : undefined;
    const copied = uuid !== undefined && runRows !== undefined && runRows.has(uuid);
    if (uuid !== undefined) runRows?.add(uuid);
    const first = !started && !copied ? Math.max(0, total - estimateTokens(firstUser ?? "", model)) : undefined;
    started = true;
    if (prev && at - prev.at >= prev.ttl) colds++;
    if (at >= since) {
      const price = pricingFor(model);
      const w1h = Math.min(write, num(u.cache_creation?.ephemeral_1h_input_tokens));
      const w5m = u.cache_creation ? Math.min(write - w1h, num(u.cache_creation?.ephemeral_5m_input_tokens)) : write - w1h;
      onRequest(price ? (write * price.inputPerM * (oneHour ? CACHE_WRITE_1H : CACHE_WRITE_5M)) / 1e6 : 0, { at, version, write, oneHour: w1h, fiveMinute: w5m, first, model, entrypoint: typeof e.entrypoint === "string" ? e.entrypoint.slice(0, 40) : undefined });
      if (prev && !compacted && at - prev.at < Math.min(ttl, prev.ttl) && prev.total > MIN_CONTEXT) {
        const isMiss = write > MISS_SHARE * prev.total;
        let miss: CacheMiss | undefined;
        if (isMiss) {
          const cause: MissCause =
            prev.model !== model ? "model switch"
            : edited ? "context edited"
            : apiError ? "after an API error"
            : blocks > LOOKBACK_BLOCKS ? "over 20 new blocks"
            : "nothing visible";
          miss = {
            path,
            at: new Date(at).toISOString(),
            model,
            previousModel: prev.model,
            contextTokens: prev.total,
            writeTokens: write,
            readShare: prev.total > 0 ? read / prev.total : 0,
            gapSeconds: Math.round((at - prev.at) / 1000),
            cause,
            extraUsd: price ? (Math.min(write, prev.total) * (price.inputPerM * (oneHour ? CACHE_WRITE_1H : CACHE_WRITE_5M) - price.cacheReadPerM)) / 1e6 : undefined,
          };
        }
        add({ model, contextTokens: prev.total, version }, miss);
      } else if (prev && !compacted && prev.model === model && prev.total > MIN_CONTEXT && at - prev.at >= prev.ttl && at - prev.at < prev.ttl * (1 + LATE_SHARE) && write > MISS_SHARE * prev.total) {
        // Cold by minutes: the entry the previous request left had just expired.
        onLate({
          path,
          at: new Date(at).toISOString(),
          model,
          ttlSeconds: prev.ttl / 1000,
          gapSeconds: Math.round((at - prev.at) / 1000),
          contextTokens: prev.total,
          writeTokens: write,
          extraUsd: price ? (Math.min(write, prev.total) * (price.inputPerM * (oneHour ? CACHE_WRITE_1H : CACHE_WRITE_5M) - price.cacheReadPerM)) / 1e6 : undefined,
          cold: colds,
        });
      }
    }
    prev = { at, total, model, ttl };
    compacted = false;
    apiError = false;
    edited = false;
    blocks = 0;
  });
}

/** Two rates differ beyond chance (two-proportion z-test, 99%). */
function differs(a: MissStats, b: MissStats): boolean {
  const p = (a.misses + b.misses) / (a.eligible + b.eligible);
  if (p <= 0 || p >= 1) return false;
  const se = Math.sqrt(p * (1 - p) * (1 / a.eligible + 1 / b.eligible));
  return Math.abs(a.rate - b.rate) > 2.58 * se;
}

/** Enough requests for a model's rate to mean something. */
const MIN_ELIGIBLE = 100;

const pct = (x: number): string => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;

/** "claude-opus-5-5" → "opus": versions of one family are compared with each other. */
function family(model: string): string | undefined {
  return /(opus|sonnet|haiku|fable|mythos)/i.exec(model)?.[1]?.toLowerCase();
}

function recommend(byModel: CacheMissReport["byModel"], bySize: CacheMissReport["bySize"]): string[] {
  const out: string[] = [];
  const solid = byModel.filter((m) => m.eligible >= MIN_ELIGIBLE);
  // Within a family: the version that misses least, where another misses
  // significantly more. Same capabilities class, so a fair swap to suggest.
  const families = new Map<string, typeof solid>();
  for (const m of solid) {
    const f = family(m.model);
    if (f) families.set(f, [...(families.get(f) ?? []), m]);
  }
  for (const [f, models] of families) {
    if (models.length < 2) continue;
    const best = [...models].sort((a, b) => a.rate - b.rate)[0];
    const worse = models.filter((m) => m !== best && m.misses >= 5 && m.rate > best.rate * 2 && differs(m, best));
    if (worse.length === 0) continue;
    const name = f[0].toUpperCase() + f.slice(1);
    out.push(
      `${name}: ${best.model} missed on ${pct(best.rate)} of warm requests; ` +
        worse.map((m) => `${m.model} on ${pct(m.rate)} (${m.misses} misses, ${money(m.extraUsd)})`).join(", ") +
        `. Prefer ${best.model} where you choose the ${name} version.`
    );
  }
  // Across your models: the outlier, when it is one beyond chance.
  if (solid.length >= 2) {
    const sorted = [...solid].sort((a, b) => b.rate - a.rate);
    const worst = sorted[0];
    const rest = sorted.slice(1);
    const pooled = rest.reduce((s, m) => ({ eligible: s.eligible + m.eligible, misses: s.misses + m.misses }), { eligible: 0, misses: 0 });
    const others: MissStats = { ...pooled, rate: pooled.eligible ? pooled.misses / pooled.eligible : 0, extraUsd: 0 };
    if (worst.misses >= 10 && worst.rate > others.rate * 3 && differs(worst, others) && !out.some((l) => l.includes(`${worst.model} on`))) {
      out.push(
        `${worst.model} misses most: ${pct(worst.rate)} of its warm requests (${worst.misses} of ${worst.eligible}, ${money(worst.extraUsd)}), ` +
          `against ${pct(others.rate)} on your other models. Where another model would do, it re-writes the cache less.`
      );
    }
  }
  // Context size: misses grow with the context, and each costs more there.
  const small = bySize.filter((b) => b.bucket === "<100k" || b.bucket === "100-300k");
  const large = bySize.filter((b) => b.bucket === "300-600k" || b.bucket === "600k+");
  const sum = (bs: typeof bySize): MissStats => {
    const eligible = bs.reduce((n, b) => n + b.eligible, 0);
    const misses = bs.reduce((n, b) => n + b.misses, 0);
    return { eligible, misses, rate: eligible ? misses / eligible : 0, extraUsd: bs.reduce((n, b) => n + b.extraUsd, 0) };
  };
  const s = sum(small), l = sum(large);
  if (s.eligible >= MIN_ELIGIBLE && l.eligible >= MIN_ELIGIBLE && l.misses >= 10 && l.rate > s.rate * 1.5 && differs(l, s)) {
    out.push(
      `Above 300k tokens of context the cache missed ${(l.rate / Math.max(s.rate, 1e-9)).toFixed(1)}x as often (${pct(l.rate)} vs ${pct(s.rate)}), ` +
        `and each miss there re-writes more: compacting earlier cuts both (context-doctor compact-window).`
    );
  }
  return out;
}

export function cacheMisses(days = 30, paths?: string[], onProgress?: (done: number, total: number) => void, missLog = missLogPath()): CacheMissReport {
  const since = Date.now() - days * 86_400_000;
  // Claude Code transcripts: they record the API's cache usage per request.
  const targets = paths ?? listSessions(10_000).filter((s) => isClaudeSession(s) && s.modifiedAt.getTime() >= since).map((s) => s.path);
  const models = new Map<string, MissStats>();
  const sizes = new Map<string, MissStats>();
  const causes: Record<MissCause, number> = { "model switch": 0, "context edited": 0, "after an API error": 0, "over 20 new blocks": 0, "nothing visible": 0 };
  const all: CacheMiss[] = [];
  let requests = 0, eligible = 0, cacheWriteUsd = 0;
  const bump = (map: Map<string, MissStats>, key: string, miss?: CacheMiss) => {
    const s = map.get(key) ?? { eligible: 0, misses: 0, rate: 0, extraUsd: 0 };
    s.eligible++;
    if (miss) {
      s.misses++;
      s.extraUsd += miss.extraUsd ?? 0;
    }
    map.set(key, s);
  };
  const versions = new Map<string, VersionAcc>();
  const versionOf = (v: string) => versions.get(v) ?? versions.set(v, { requests: 0, sessions: new Set(), firsts: [], writes: 0, oneHour: 0, fiveMinute: 0, eligible: 0, misses: 0, byModel: new Map(), ttlBy: new Map(), from: Infinity, to: 0 }).get(v)!;
  const runRows = new Set<string>();
  const late: LateRewrite[] = [];
  for (const [i, p] of targets.entries()) {
    onProgress?.(i, targets.length);
    try {
      missesInTranscript(
        p,
        since,
        (e, miss) => {
          eligible++;
          bump(models, e.model, miss);
          bump(sizes, bucketOf(e.contextTokens), miss);
          if (e.version) {
            const v = versionOf(e.version);
            v.eligible++;
            if (miss) v.misses++;
            const m = v.byModel.get(e.model) ?? v.byModel.set(e.model, { eligible: 0, misses: 0 }).get(e.model)!;
            m.eligible++;
            if (miss) m.misses++;
          }
          if (miss) {
            all.push(miss);
            causes[miss.cause]++;
          }
        },
        (writeUsd, info) => {
          requests++;
          cacheWriteUsd += writeUsd;
          if (!info.version) return;
          const v = versionOf(info.version);
          v.requests++;
          v.sessions.add(p);
          v.writes += info.write;
          v.oneHour += info.oneHour;
          v.fiveMinute += info.fiveMinute;
          const key = `${info.model ?? "an unknown model"}${info.entrypoint ? ` in ${info.entrypoint}` : ""}`;
          const t = v.ttlBy.get(key) ?? v.ttlBy.set(key, { requests: 0, oneHour: 0, fiveMinute: 0 }).get(key)!;
          t.requests++;
          t.oneHour += info.oneHour;
          t.fiveMinute += info.fiveMinute;
          v.from = Math.min(v.from, info.at);
          v.to = Math.max(v.to, info.at);
          if (info.first !== undefined && info.first > 1000) v.firsts.push(info.first);
        },
        runRows,
        (l) => late.push(l)
      );
    } catch {
      /* one unreadable transcript must not sink the report */
    }
  }
  onProgress?.(targets.length, targets.length);
  const finish = (s: MissStats): MissStats => ({ ...s, rate: s.eligible ? s.misses / s.eligible : 0 });
  const byModel = [...models.entries()].map(([model, s]) => ({ model, ...finish(s) })).sort((a, b) => b.rate - a.rate);
  const bySize = SIZE_BUCKETS.filter(([b]) => sizes.has(b)).map(([bucket]) => ({ bucket, ...finish(sizes.get(bucket)!) }));
  return {
    days,
    transcripts: targets.length,
    requests,
    eligible,
    misses: all.length,
    missWriteTokens: all.reduce((n, m) => n + m.writeTokens, 0),
    extraUsd: all.reduce((n, m) => n + (m.extraUsd ?? 0), 0),
    cacheWriteUsd,
    unpricedMisses: all.filter((m) => m.extraUsd === undefined).length,
    byModel,
    bySize,
    causes,
    recommendations: recommend(byModel, bySize),
    largest: [...all].sort((a, b) => (b.extraUsd ?? 0) - (a.extraUsd ?? 0) || b.writeTokens - a.writeTokens).slice(0, 10),
    ...versionReport(versions),
    diagnosed: diagnosedMisses(since, missLog),
    late: lateReport(late),
  };
}

/**
 * Two wake-ups of one loop: gaps within 90 s or 2% of each other, whichever
 * is wider. A timer drifts by seconds (the loop in #104736 woke at 61.0 to
 * 62.1 minutes); a person back from lunch at 61, 67 and 73 minutes is no loop,
 * though all three are "just too late" (±10% of the median called them one).
 */
const sameInterval = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(90, 0.02 * Math.max(a, b));

/**
 * Late re-writes in total, and per session where they repeat: 3+ on the same
 * TTL, consecutive among the session's cold starts (nothing else found the
 * cache cold between them), at the same interval.
 */
function lateReport(late: LateRewrite[]): CacheMissReport["late"] {
  const groups = new Map<string, LateRewrite[]>();
  for (const l of late) {
    const key = `${l.ttlSeconds}\u0000${l.path}`;
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const loops: CacheMissReport["late"]["loops"] = [];
  for (const ls of groups.values()) {
    ls.sort((a, b) => (a.cold ?? 0) - (b.cold ?? 0));
    let run: LateRewrite[] = [];
    const close = () => {
      if (run.length >= LOOP_MIN) {
        loops.push({
          path: run[0].path,
          rewrites: run.length,
          medianGapSeconds: median(run.map((l) => l.gapSeconds)) ?? 0,
          ttlSeconds: run[0].ttlSeconds,
          extraUsd: run.reduce((n, l) => n + (l.extraUsd ?? 0), 0),
        });
      }
    };
    for (const l of ls) {
      const last = run.at(-1);
      const joins = last !== undefined && l.cold !== undefined && last.cold !== undefined && l.cold === last.cold + 1 && sameInterval(l.gapSeconds, run[0].gapSeconds) && sameInterval(l.gapSeconds, last.gapSeconds);
      if (!joins) {
        close();
        run = [];
      }
      run.push(l);
    }
    close();
  }
  loops.sort((a, b) => b.extraUsd - a.extraUsd);
  return {
    rewrites: late.length,
    tokens: late.reduce((n, l) => n + l.writeTokens, 0),
    extraUsd: late.reduce((n, l) => n + (l.extraUsd ?? 0), 0),
    loops,
    largest: [...late].sort((a, b) => (b.extraUsd ?? 0) - (a.extraUsd ?? 0) || b.writeTokens - a.writeTokens).slice(0, 10),
  };
}

/** "55 min" / "4:30": an interval just under a TTL that keeps the cache warm. */
function underTtl(ttlSeconds: number): string {
  const s = Math.round(ttlSeconds * 0.9);
  return s >= 600 ? `${Math.round(s / 60)} min (${s}s)` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} (${s}s)`;
}

/** The late re-writes section, or nothing when there are none. */
export function renderLate(l: CacheMissReport["late"]): string[] {
  if (l.rewrites === 0) return [];
  const out = [
    `Just too late: ${l.rewrites} request${l.rewrites === 1 ? "" : "s"} came less than 25% past the cache's lifetime and wrote it`,
    `again (~${formatTokens(l.tokens)} tokens, ${money(l.extraUsd)} above cache-read price). A few minutes`,
    "sooner and they would have read it; the status line shows until when it is warm.",
  ];
  for (const loop of l.loops.slice(0, 5)) {
    const file = loop.path.split(/[\\/]/).pop()?.slice(0, 12) ?? "";
    out.push(
      `  • A loop: ${loop.rewrites} wake-ups every ~${Math.round(loop.medianGapSeconds / 60)} min on a ${loop.ttlSeconds >= 3600 ? "1-hour" : "5-minute"} cache, ${money(loop.extraUsd)} (${file}).`,
      `    Wake every ${underTtl(loop.ttlSeconds)} instead: the delay counts from the end of a turn, the TTL from its last request.`
    );
  }
  return out;
}

interface VersionAcc {
  requests: number;
  sessions: Set<string>;
  firsts: number[];
  writes: number;
  oneHour: number;
  fiveMinute: number;
  eligible: number;
  misses: number;
  /** Warm requests and misses per model: miss rates differ by model far more than by version. */
  byModel: Map<string, { eligible: number; misses: number }>;
  /** Cache writes by TTL per model and surface: either can change the TTL as much as the version. */
  ttlBy: Map<string, { requests: number; oneHour: number; fiveMinute: number }>;
  from: number;
  to: number;
}

const median = (xs: number[]): number | undefined => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Enough of a version to compare it: requests for rates and shares, new sessions for the first request. */
const MIN_VERSION_REQUESTS = 200;
const MIN_VERSION_FIRSTS = 5;

/**
 * Per version, oldest first, and the step changes between consecutive
 * versions with enough data (thin versions are skipped over, so a change
 * is credited to the first well-measured version after it):
 *  - the 1-hour share of cache writes moving by 30+ points (the TTL
 *    regressions users report after upgrades: 1 h to 5 min);
 *  - the median first request (fixed overhead) moving by 15% and 3k tokens;
 *  - one model's miss rate doubling (or halving), beyond chance at 99%,
 *    5+ misses, 100+ warm requests on each version.
 * Cache writes per request are shown, not flagged (they follow the work).
 */
export function versionReport(versions: Map<string, VersionAcc>): { byVersion: VersionStats[]; regressions: Regression[] } {
  const byVersion: VersionStats[] = [...versions.entries()]
    .sort((a, b) => compareVersions(a[0], b[0]))
    .map(([version, v]) => ({
      version,
      requests: v.requests,
      sessions: v.sessions.size,
      firstRequests: v.firsts.length,
      firstMedian: median(v.firsts),
      writesPerRequest: v.requests ? v.writes / v.requests : 0,
      oneHourShare: v.oneHour + v.fiveMinute > 0 ? v.oneHour / (v.oneHour + v.fiveMinute) : undefined,
      eligible: v.eligible,
      misses: v.misses,
      missRate: v.eligible ? v.misses / v.eligible : 0,
      byModel: [...v.byModel.entries()].map(([model, m]) => ({ model, ...m })),
      ttlBy: [...v.ttlBy.entries()].map(([key, t]) => ({ key, requests: t.requests, oneHourShare: t.oneHour + t.fiveMinute > 0 ? t.oneHour / (t.oneHour + t.fiveMinute) : undefined })),
      from: Number.isFinite(v.from) ? new Date(v.from).toISOString() : "",
      to: v.to ? new Date(v.to).toISOString() : "",
    }));
  const regressions: Regression[] = [];
  const step = (metric: Regression["metric"], ok: (v: VersionStats) => boolean, value: (v: VersionStats) => number | undefined, changed: (a: VersionStats, b: VersionStats, x: number, y: number) => boolean, say: (a: VersionStats, b: VersionStats, x: number, y: number) => string) => {
    let prev: VersionStats | undefined;
    for (const v of byVersion) {
      if (!ok(v) || value(v) === undefined) continue;
      if (prev) {
        const x = value(prev)!, y = value(v)!;
        if (changed(prev, v, x, y)) regressions.push({ metric, from: prev.version, to: v.version, before: x, after: y, text: say(prev, v, x, y) });
      }
      prev = v;
    }
  };
  const share = (x: number) => `${Math.round(x * 100)}%`;
  // The 1-hour share, within one model on one surface (the desktop app and
  // the terminal, an API key and a subscription, can each pick the TTL):
  // the same model on the same surface, version against version.
  const groups = new Set(byVersion.flatMap((v) => v.ttlBy.map((t) => t.key)));
  for (const key of groups) {
    let prev: { v: VersionStats; share: number } | undefined;
    for (const v of byVersion) {
      const t = v.ttlBy.find((x) => x.key === key);
      if (!t || t.requests < MIN_VERSION_REQUESTS || t.oneHourShare === undefined) continue;
      if (prev && Math.abs(t.oneHourShare - prev.share) >= 0.3) {
        const x = prev.share, y = t.oneHourShare;
        regressions.push({
          metric: "1-hour cache share",
          from: prev.v.version,
          to: v.version,
          before: x,
          after: y,
          text: `On ${key}, cache writes at the 1-hour TTL went from ${share(x)} on ${prev.v.version} to ${share(y)} on ${v.version}: ${y < x ? "more of the cache now expires after 5 minutes, so a short pause re-writes it" : "the cache now survives pauses up to an hour"}.`,
        });
      }
      prev = { v, share: t.oneHourShare };
    }
  }
  step(
    "first request",
    (v) => v.firstRequests >= MIN_VERSION_FIRSTS,
    (v) => v.firstMedian,
    (_a, _b, x, y) => Math.abs(y - x) >= Math.max(3000, 0.15 * x),
    (a, b, x, y) => `A new session's first request (the fixed overhead) went from ~${formatTokens(x)} on ${a.version} to ~${formatTokens(y)} on ${b.version} (median of ${a.firstRequests} and ${b.firstRequests} sessions; your CLAUDE.md, rules and MCP servers move it too: context-doctor overhead).`
  );
  // Miss rates: within one model, version against version, since a version's
  // overall rate mostly follows the models it ran (Sonnet 5 missed 10x as
  // often as Opus 5.5 on the author's machine).
  const models = new Set(byVersion.flatMap((v) => v.byModel.map((m) => m.model)));
  for (const model of models) {
    let prev: { v: VersionStats; m: { eligible: number; misses: number } } | undefined;
    for (const v of byVersion) {
      const m = v.byModel.find((x) => x.model === model);
      if (!m || m.eligible < MIN_ELIGIBLE) continue;
      if (prev) {
        const a = prev.m, x = a.misses / a.eligible, y = m.misses / m.eligible;
        if (Math.max(a.misses, m.misses) >= 5 && (y >= 2 * x || x >= 2 * y) && differs({ ...a, rate: x, extraUsd: 0 }, { ...m, rate: y, extraUsd: 0 })) {
          regressions.push({
            metric: "miss rate",
            from: prev.v.version,
            to: v.version,
            before: x,
            after: y,
            text: `On ${model} the cache missed on ${pct(y)} of warm requests with ${v.version}, against ${pct(x)} with ${prev.v.version} (${m.misses} of ${m.eligible}; ${a.misses} of ${a.eligible}).`,
          });
        }
      }
      prev = { v, m };
    }
  }
  // Writes per request are in the table, not flagged: they follow the work
  // (a big file read writes a lot) as much as the version. Measured on the
  // author's history, 8 of 17 version-to-version "changes" were this alone.
  regressions.sort((a, b) => compareVersions(a.to, b.to));
  return { byVersion, regressions };
}

/** Worth a line in `savings`: enough misses, and enough money, to act on. */
export function cacheMissesSignificant(r: CacheMissReport): boolean {
  return r.misses >= 10 && r.extraUsd >= 5;
}

/** The one line `savings` adds when the misses are significant. */
export function cacheMissesLine(r: CacheMissReport): string[] {
  const share = r.cacheWriteUsd > 0 ? ` (${Math.round((r.extraUsd / r.cacheWriteUsd) * 100)}% of cache writes)` : "";
  // Within the 60 columns the rest of `savings` keeps to.
  return [
    `Also: ${r.misses} cache misses within the cache lifetime cost ${money(r.extraUsd)}`,
    `above cache-read price${share}. By model and`,
    "context size: context-doctor cache-misses",
  ];
}

/** Words into lines of at most `width` characters. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/** Claude Code's own diagnosis, or how to start recording it. */
export function renderDiagnosed(d: DiagnosedMisses): string[] {
  if (d.misses === 0) {
    return [
      "Why, in Claude Code's words: nothing recorded yet. Claude Code 2.1.260+ diagnoses",
      "each miss (tools changed, system prompt changed, idle past the TTL...) and tells",
      "the status line; `context-doctor install --statusline` records it for this report.",
    ];
  }
  const out = [
    `Why, in Claude Code's words (${d.misses} misses in ${d.sessions} session${d.sessions === 1 ? "" : "s"} since ${new Date(d.from ?? 0).toISOString().slice(0, 10)},`,
    `~${formatTokens(d.tokens)} tokens re-written, ${money(d.extraUsd)} above cache-read price; Claude Code also counts`,
    "a cache gone cold after a pause):",
  ];
  for (const c of d.byCause.slice(0, 8)) {
    out.push(`  ${String(c.misses).padStart(5)}  ${c.label.padEnd(38)} ${`~${formatTokens(c.tokens)}`.padStart(7)} ${money(c.extraUsd).padStart(9)}`);
    if (c.fix) out.push(...wrap(c.fix, 70).map((l) => `         ${l}`));
  }
  if (d.byCause.length > 8) out.push(`  (${d.byCause.length - 8} more causes in --json)`);
  return out;
}

export function renderCacheMisses(r: CacheMissReport, limitLines?: string[]): string {
  const out = ["CACHE MISSES WITHIN THE CACHE LIFETIME", "═".repeat(60)];
  if (r.eligible === 0) {
    out.push(`No Claude Code requests in the last ${r.days} days that could have read a warm cache (consecutive, within the cache lifetime, over 20k tokens).`);
    const late = renderLate(r.late);
    if (late.length) out.push("", ...late);
    if (r.diagnosed.misses > 0) out.push("", ...renderDiagnosed(r.diagnosed));
    return out.join("\n");
  }
  const share = r.cacheWriteUsd > 0 ? ` (${Math.round((r.extraUsd / r.cacheWriteUsd) * 100)}% of your ${money(r.cacheWriteUsd)} of cache writes)` : "";
  out.push(
    `Last ${r.days} days, ${r.transcripts} transcripts, ${r.requests.toLocaleString("en-US")} requests.`,
    `${r.misses} of ${r.eligible.toLocaleString("en-US")} warm requests (${pct(r.misses / r.eligible)}) re-wrote the cache instead of reading it:`,
    `~${formatTokens(r.missWriteTokens)} tokens written again, ${money(r.extraUsd)} above cache-read price${share}.` +
      (r.unpricedMisses ? ` ${r.unpricedMisses} on unpriced models not included.` : ""),
    ...(limitLines?.length ? ["", ...limitLines] : []),
    "",
    `  ${"model".padEnd(24)} ${"misses".padStart(14)} ${"rate".padStart(7)} ${"cost".padStart(9)}`
  );
  for (const m of r.byModel) {
    out.push(`  ${m.model.slice(0, 24).padEnd(24)} ${`${m.misses}/${m.eligible}`.padStart(14)} ${pct(m.rate).padStart(7)} ${money(m.extraUsd).padStart(9)}`);
  }
  out.push("", `  ${"context before".padEnd(24)} ${"misses".padStart(14)} ${"rate".padStart(7)} ${"cost".padStart(9)}`);
  for (const b of r.bySize) {
    out.push(`  ${b.bucket.padEnd(24)} ${`${b.misses}/${b.eligible}`.padStart(14)} ${pct(b.rate).padStart(7)} ${money(b.extraUsd).padStart(9)}`);
  }
  const causes = Object.entries(r.causes).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (causes.length) {
    out.push("", "Cause, where the transcript shows one:");
    for (const [c, n] of causes) out.push(`  ${String(n).padStart(5)}  ${c}`);
    if (r.causes["nothing visible"] > 0) {
      out.push(
        "  \"Nothing visible\": no model switch, compaction, context edit, API error or",
        "  long tool run before it. The system prompt, tools or memory changing, or the",
        "  provider evicting the cache early, would look like this from the client."
      );
    }
  }
  const late = renderLate(r.late);
  if (late.length) out.push("", ...late);
  out.push("", ...renderDiagnosed(r.diagnosed));
  const shown = r.byVersion.filter((v) => v.requests >= 50);
  if (shown.length >= 2) {
    out.push("", "By Claude Code version (versions with 50+ requests):", `  ${"version".padEnd(9)} ${"requests".padStart(8)} ${"1st req".padStart(8)} ${"writes/req".padStart(10)} ${"1h share".padStart(9)} ${"miss rate".padStart(10)}`);
    for (const v of shown.slice(-12)) {
      out.push(`  ${v.version.padEnd(9)} ${String(v.requests).padStart(8)} ${(v.firstMedian !== undefined ? `~${formatTokens(v.firstMedian)}` : "–").padStart(8)} ${`~${formatTokens(v.writesPerRequest)}`.padStart(10)} ${(v.oneHourShare !== undefined ? `${Math.round(v.oneHourShare * 100)}%` : "–").padStart(9)} ${(v.eligible ? pct(v.missRate) : "–").padStart(10)}`);
    }
    if (shown.length > 12) out.push(`  (${shown.length - 12} older versions in --json)`);
  }
  if (r.regressions.length) {
    out.push("", "Changes after an upgrade:");
    for (const g of r.regressions) out.push(`  • ${g.text}`);
    out.push(
      "  Read with care: these compare one model (and, for the TTL, one surface) across",
      "  versions, but a version also arrives with new habits, projects and memory files;",
      "  the sign-in (API key or subscription) is not in the transcript at all."
    );
  } else if (shown.length >= 2) {
    out.push("", "No step change between versions that the numbers support.");
  }
  if (r.recommendations.length) {
    out.push("", "What the data supports:");
    for (const rec of r.recommendations) out.push(`  • ${rec}`);
  }
  if (r.largest.length) {
    out.push("", "Costliest:");
    for (const m of r.largest.slice(0, 5)) {
      const file = m.path.split(/[\\/]/).pop()?.slice(0, 12) ?? "";
      out.push(`  ${m.at.slice(0, 16).replace("T", " ")}  ${m.model.slice(0, 18).padEnd(18)} ~${formatTokens(m.contextTokens).padStart(5)} ctx, ${m.gapSeconds}s gap, ${m.cause}${m.extraUsd !== undefined ? `, ${money(m.extraUsd)}` : ""}  ${file}`);
    }
  }
  out.push(
    "",
    "A miss: within the cache lifetime of both requests (5 min, or 1 h when written at",
    "the 1-hour TTL), no compaction between, previous context over 20k, and the request",
    "wrote over 60% of that context again. Model switches always miss: each model has",
    "its own cache. On Claude Code 2.1.251+, `context-doctor install` (or the plugin)",
    "shows that price before a /model switch."
  );
  return out.join("\n");
}
