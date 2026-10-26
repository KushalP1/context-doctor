/**
 * `context-doctor limits`: your plan's usage limits, in their own unit.
 *
 * Subscriptions are billed in % of a 5-hour and a weekly window (Claude
 * Pro/Max), or in credits per token (Codex since April 2026), and neither
 * vendor shows where the percentage went. Two local sources say:
 *
 *  - Claude Code hands its status line command `rate_limits.five_hour` and
 *    `.seven_day`, each `{used_percentage, resets_at}` (documented at
 *    code.claude.com/docs/en/statusline; built in 2.1.308 as
 *    Math.round(utilization*1000)/10, so 0.1% steps; present only for
 *    Pro/Max subscribers, after the first reply). `context-doctor statusline`
 *    appends each new reading to a small local log (recordLimits).
 *  - Codex records `rate_limits.primary` / `.secondary`
 *    `{used_percent, window_minutes, resets_at}` on every token_count event of
 *    its rollouts (~/.codex/sessions), next to that request's usage, in
 *    whole percent.
 *
 * From the readings: the current %, the pace, and when each window runs out
 * at that pace. And, by fitting each rise in % against the usage recorded on
 * this machine over the same interval, an estimate of what 1M tokens of each
 * kind cost in % of the limit, with the fit's error. Usage elsewhere (claude.ai
 * in a browser, another computer) moves the % without leaving a transcript
 * here; it shows up as error, and rises with no local usage at all are
 * counted apart. When the fit is too thin to trust, the report says so
 * instead of printing a number.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { statePath } from "./ledger.js";
import { forEachLine, listSessions, outputSettler, replyCounter } from "./session.js";
import { subagentDir } from "./subagents.js";
import { CACHE_WRITE_5M, openAIUsage, pricingFor, usageCost, type ModelPricing, type RecordedUsage } from "./pricing.js";
import { realModel } from "./tokens.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Claude Code's two windows, as its status line input names them. */
export const CLAUDE_WINDOWS = ["five_hour", "seven_day"] as const;

/** One reading of one window: how much of it was used at `ts`. */
export interface LimitReading {
  /** When it was read, ms. */
  ts: number;
  app: "claude" | "codex";
  /** "five_hour", "seven_day", or for Codex "codex:[<plan>:][<limit id>:]<minutes>". */
  window: string;
  /** Percent used, 0-100 (a gateway's spend can pass 100). */
  pct: number;
  /** When the window resets, ms. */
  resetsAt?: number;
  /** The window's length, ms, when known. */
  windowMs?: number;
  /** Codex's plan ("plus", "team", "free"...). */
  plan?: string;
}

/** One request's usage, from a transcript on this machine. */
export interface UsagePoint {
  ts: number;
  app: "claude" | "codex";
  model?: string;
  /** Uncached input, cache reads, cache writes, output: tokens. */
  input: number;
  read: number;
  write: number;
  output: number;
  /** At API list price; 0 when the model has no price on file. */
  usd: number;
}

// ---------------------------------------------------------------------------
// The Claude readings log, written by the status line
// ---------------------------------------------------------------------------

/** Beside the hook state and the ledger: ~/.claude/.context-doctor-limits.jsonl. */
export function limitsLogPath(): string {
  return join(dirname(statePath()), ".context-doctor-limits.jsonl");
}

/** An unchanged reading is written again after this long, so the log says the window was still there. */
const KEEPALIVE_MS = 15 * MIN;
/** Past this size the log keeps its newest LOG_KEEP_BYTES. */
const LOG_ROTATE_AT = 512 * 1024;
const LOG_KEEP_BYTES = 256 * 1024;

interface LogLine {
  ts: number;
  app: "claude";
  w: string;
  pct: number;
  /** Epoch seconds, as Claude Code gives it. */
  reset?: number;
}

/** The last `bytes` of a file as text (the first line of it may be partial). */
function tail(path: string, bytes: number): string {
  const size = statSync(path).size;
  const n = Math.min(size, bytes);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function parseLogLine(line: string): LogLine | undefined {
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!e || typeof e !== "object") return undefined;
  const { ts, w, pct, reset } = e as Record<string, unknown>;
  if (typeof ts !== "number" || !Number.isFinite(ts) || typeof w !== "string" || !(CLAUDE_WINDOWS as readonly string[]).includes(w)) return undefined;
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 1000) return undefined;
  return { ts, app: "claude", w, pct, reset: typeof reset === "number" && Number.isFinite(reset) && reset > 0 ? reset : undefined };
}

/**
 * Append what changed in Claude Code's `rate_limits` to the log: a window
 * whose % or reset time moved since its last line, or that has not been
 * written for 15 minutes. Nothing when there are no limits (an API key,
 * Bedrock, Vertex). Never throws: the status line must stay silent. Returns
 * the lines written.
 */
export function recordLimits(rateLimits: unknown, now = Date.now(), path = limitsLogPath()): number {
  if (!rateLimits || typeof rateLimits !== "object") return 0;
  const fresh: LogLine[] = [];
  for (const w of CLAUDE_WINDOWS) {
    const r = (rateLimits as Record<string, any>)[w];
    const pct = r?.used_percentage;
    if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 1000) continue;
    const reset = typeof r.resets_at === "number" && Number.isFinite(r.resets_at) && r.resets_at > 0 ? Math.round(r.resets_at) : undefined;
    fresh.push({ ts: now, app: "claude", w, pct: Math.round(pct * 10) / 10, ...(reset ? { reset } : {}) });
  }
  if (!fresh.length) return 0;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const last = new Map<string, LogLine>();
    if (existsSync(path)) {
      for (const line of tail(path, 16 * 1024).split("\n")) {
        const l = parseLogLine(line);
        if (l) last.set(l.w, l);
      }
    }
    const due = fresh.filter((l) => {
      const p = last.get(l.w);
      return !p || p.pct !== l.pct || p.reset !== l.reset || now - p.ts >= KEEPALIVE_MS || now < p.ts;
    });
    if (!due.length) return 0;
    if (existsSync(path) && statSync(path).size > LOG_ROTATE_AT) {
      const text = tail(path, LOG_KEEP_BYTES);
      writeFileSync(path, text.slice(text.indexOf("\n") + 1));
    }
    appendFileSync(path, due.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return due.length;
  } catch {
    return 0;
  }
}

/** Every Claude reading in the log since `since`. */
export function readClaudeReadings(since = 0, path = limitsLogPath()): LimitReading[] {
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: LimitReading[] = [];
  for (const line of text.split("\n")) {
    const l = parseLogLine(line);
    if (!l || l.ts < since) continue;
    out.push({ ts: l.ts, app: "claude", window: l.w, pct: l.pct, resetsAt: l.reset ? l.reset * 1000 : undefined, windowMs: l.w === "five_hour" ? 5 * HOUR : 7 * DAY });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

// ---------------------------------------------------------------------------
// Codex: readings and usage, both from its rollouts
// ---------------------------------------------------------------------------

export function codexSessionsRoot(home = homedir()): string {
  return join(home, ".codex", "sessions");
}

function rolloutFiles(root: string, since: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 3) walk(p, depth + 1);
      } else if (name.endsWith(".jsonl") && st.mtimeMs >= since) {
        out.push(p);
      }
    }
  };
  walk(root, 0);
  return out;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** "codex:300", "codex:10080"; a limit id other than "codex" is kept in the key. */
function codexWindow(limitId: unknown, minutes: number, plan: unknown): string {
  // The plan is part of the key: two sign-ins (a team plan, a free one) are two accounts' limits.
  const p = typeof plan === "string" && /^[\w-]{1,20}$/.test(plan) ? `${plan}:` : "";
  return typeof limitId === "string" && limitId && limitId !== "codex" ? `codex:${p}${limitId.slice(0, 40)}:${minutes}` : `codex:${p}${minutes}`;
}

/**
 * Codex readings and usage since `since`. A token_count event repeats the
 * last request's usage when only the limits were refreshed, so a request is
 * counted when the running total moves.
 */
export function codexLimitData(since: number, root = codexSessionsRoot()): { readings: LimitReading[]; usage: UsagePoint[] } {
  const readings: LimitReading[] = [];
  const usage: UsagePoint[] = [];
  if (!existsSync(root)) return { readings, usage };
  for (const file of rolloutFiles(root, since)) {
    let model: string | undefined;
    let total = -1;
    try {
      forEachLine(file, (line) => {
        if (!line.includes('"token_count"') && !line.includes('"turn_context"')) return;
        let e: Record<string, any>;
        try {
          e = JSON.parse(line);
        } catch {
          return;
        }
        const p = e?.payload;
        if (!p || typeof p !== "object") return;
        if (e.type === "turn_context") {
          if (typeof p.model === "string") model = p.model;
          return;
        }
        if (e.type !== "event_msg" || p.type !== "token_count") return;
        const ts = Date.parse(String(e.timestamp ?? ""));
        if (!Number.isFinite(ts) || ts < since) return;
        const runTotal = num(p.info?.total_token_usage?.total_tokens);
        const last = p.info?.last_token_usage;
        // No running total recorded: every event is a request.
        if (last && num(last.input_tokens) > 0 && (runTotal === 0 || runTotal !== total)) {
          total = runTotal;
          const u = openAIUsage(last);
          const price = pricingFor(model);
          usage.push({ ts, app: "codex", model, input: num(u.input_tokens), read: num(u.cache_read_input_tokens), write: num(u.cache_creation_input_tokens), output: num(u.output_tokens), usd: price ? usageCost(u, price).totalUsd : 0 });
        }
        const rl = p.rate_limits;
        if (!rl || typeof rl !== "object") return;
        for (const slot of ["primary", "secondary"]) {
          const w = rl[slot];
          const pct = w?.used_percent;
          const minutes = num(w?.window_minutes);
          if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 1000 || !minutes) continue;
          const reset = num(w.resets_at);
          readings.push({ ts, app: "codex", window: codexWindow(rl.limit_id, minutes, rl.plan_type), pct, resetsAt: reset ? reset * 1000 : undefined, windowMs: minutes * MIN, plan: typeof rl.plan_type === "string" ? rl.plan_type.slice(0, 20) : undefined });
        }
      });
    } catch {
      /* one unreadable rollout must not sink the report */
    }
  }
  readings.sort((a, b) => a.ts - b.ts);
  usage.sort((a, b) => a.ts - b.ts);
  return { readings, usage };
}

// ---------------------------------------------------------------------------
// Claude usage: every request on this machine, subagents included
// ---------------------------------------------------------------------------

/**
 * Every Claude Code request between `since` and `until`, main threads and
 * subagents alike (both draw on the same limits), each reply once.
 */
export function claudeUsage(since: number, until = Infinity, paths?: string[]): UsagePoint[] {
  const tops = paths ?? listSessions(10_000).filter((s) => s.path.includes(".claude") && s.modifiedAt.getTime() >= since).map((s) => s.path);
  const files: string[] = [];
  for (const t of tops) {
    files.push(t);
    const dir = subagentDir(t);
    try {
      for (const f of readdirSync(dir)) if (f.endsWith(".jsonl") && statSync(join(dir, f)).mtimeMs >= since) files.push(join(dir, f));
    } catch {
      /* no subagents */
    }
  }
  const out: UsagePoint[] = [];
  const runRows = new Set<string>();
  for (const file of files) {
    const sighting = replyCounter(runRows);
    const settle = outputSettler();
    const byId = new Map<string, { point: UsagePoint; price?: ModelPricing }>();
    try {
      forEachLine(file, (line) => {
        if (!line.includes('"usage"')) return;
        let e: Record<string, any>;
        try {
          e = JSON.parse(line);
        } catch {
          return;
        }
        const m = e?.message;
        if (e?.type !== "assistant" || !m?.usage) return;
        const seen = sighting(e);
        if (seen === "repeat") {
          const known = typeof m.id === "string" ? byId.get(m.id) : undefined;
          const more = settle(e, false);
          if (known && more) {
            known.point.output += more;
            if (known.price) known.point.usd += (more * known.price.outputPerM) / 1e6;
          }
          return;
        }
        if (seen !== "new") return;
        settle(e, true);
        const ts = Date.parse(String(e.timestamp ?? ""));
        if (!Number.isFinite(ts) || ts < since || ts > until) return;
        const u = m.usage as RecordedUsage;
        const point: UsagePoint = { ts, app: "claude", model: realModel(m.model), input: num(u.input_tokens), read: num(u.cache_read_input_tokens), write: num(u.cache_creation_input_tokens), output: num(u.output_tokens), usd: 0 };
        if (point.input + point.read + point.write === 0) return;
        const price = pricingFor(point.model);
        if (price) point.usd = usageCost(u, price).totalUsd;
        out.push(point);
        if (typeof m.id === "string") byId.set(m.id, { point, price });
      });
    } catch {
      /* skip an unreadable transcript */
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

// ---------------------------------------------------------------------------
// Status: the current %, the pace, when it runs out
// ---------------------------------------------------------------------------

export interface WindowStatus {
  window: string;
  label: string;
  app: "claude" | "codex";
  pct: number;
  /** When the newest reading was taken. */
  at: number;
  resetsAt?: number;
  /** True when the newest reading's window has reset since (its % is stale). */
  resetSince: boolean;
  /** Points per hour over the recent stretch (the last hour of a 5-hour window, the last day otherwise). */
  recentPerHour?: number;
  /** Points per hour since the window began, when its length is known. */
  averagePerHour?: number;
  /** At the recent pace: when it reaches 100%, and whether that is before the reset. */
  runsOutAt?: number;
  beforeReset?: boolean;
  readings: number;
  plan?: string;
}

export function windowLabel(window: string, windowMs?: number): string {
  if (window === "five_hour") return "Claude 5-hour";
  if (window === "seven_day") return "Claude weekly";
  const parts = window.split(":").slice(1);
  const minutes = windowMs ? Math.round(windowMs / MIN) : Number(parts[parts.length - 1]);
  const span = minutes === 300 ? "5-hour" : minutes === 10_080 ? "weekly" : minutes >= 43_000 && minutes <= 44_700 ? "monthly" : minutes % 1440 === 0 ? `${minutes / 1440}-day` : `${minutes}-minute`;
  const tags = parts.slice(0, -1);
  return `Codex ${span}${tags.length ? ` (${tags.join(", ")})` : ""}`;
}

/** Two readings of one window belong to the same period: the reset did not move, and the % did not fall. */
function samePeriod(a: LimitReading, b: LimitReading, resolution: number): boolean {
  if (a.resetsAt !== undefined && b.resetsAt !== undefined && Math.abs(a.resetsAt - b.resetsAt) > 10 * MIN) return false;
  if (a.resetsAt !== undefined && b.ts > a.resetsAt) return false;
  if (b.pct < a.pct - resolution) return false;
  if (a.windowMs && b.ts - a.ts > a.windowMs) return false;
  return true;
}

/** 0.1 when any reading has a fraction (Claude), else 1 (Codex's whole percents). */
export function resolutionOf(readings: LimitReading[]): number {
  return readings.some((r) => Math.abs(r.pct - Math.round(r.pct)) > 1e-9) ? 0.1 : 1;
}

export function windowStatus(readings: LimitReading[], now = Date.now()): WindowStatus | undefined {
  if (!readings.length) return undefined;
  const last = readings[readings.length - 1];
  const res = resolutionOf(readings);
  const status: WindowStatus = {
    window: last.window,
    label: windowLabel(last.window, last.windowMs),
    app: last.app,
    pct: last.pct,
    at: last.ts,
    resetsAt: last.resetsAt,
    resetSince: last.resetsAt !== undefined && last.resetsAt <= now,
    readings: readings.length,
    plan: last.plan,
  };
  if (status.resetSince) return status;
  // The current period: back from the newest reading while the period holds.
  let first = readings.length - 1;
  while (first > 0 && samePeriod(readings[first - 1], readings[first], res)) first--;
  const period = readings.slice(first);
  const lookback = last.windowMs && last.windowMs <= 5 * HOUR ? HOUR : DAY;
  const recent = period.filter((r) => r.ts >= last.ts - lookback);
  const from = recent[0];
  if (from && last.ts - from.ts >= 10 * MIN) {
    status.recentPerHour = Math.max(0, ((last.pct - from.pct) / (last.ts - from.ts)) * HOUR);
  }
  if (last.windowMs && last.resetsAt) {
    const start = last.resetsAt - last.windowMs;
    if (last.ts - start >= 10 * MIN) status.averagePerHour = Math.max(0, (last.pct / (last.ts - start)) * HOUR);
  }
  if (status.recentPerHour && status.recentPerHour > 0 && last.pct < 100) {
    status.runsOutAt = last.ts + ((100 - last.pct) / status.recentPerHour) * HOUR;
    status.beforeReset = last.resetsAt === undefined || status.runsOutAt < last.resetsAt;
  }
  return status;
}

// ---------------------------------------------------------------------------
// The fit: % of the limit per 1M tokens
// ---------------------------------------------------------------------------

/** A stretch of one window's period in which the % rose by `dpct`, with the usage recorded in it. */
export interface Segment {
  from: number;
  to: number;
  dpct: number;
  /** Millions of tokens: uncached input, cache read, cache write, output. */
  x: [number, number, number, number];
  usd: number;
  requests: number;
}

export const TOKEN_TYPES = ["input", "cache read", "cache write", "output"] as const;

/**
 * Cut each period into segments the % rose at least `step` points over (so
 * the readings' rounding is a small part of each), and sum the usage that
 * falls inside each. A rise with no local usage at all is usage elsewhere:
 * counted, kept out of the fit.
 */
export function segmentsOf(readings: LimitReading[], usage: UsagePoint[], step?: number): { segments: Segment[]; elsewhere: number; elsewherePct: number } {
  const res = resolutionOf(readings);
  const minStep = step ?? (res < 1 ? 1 : 3);
  const segments: Segment[] = [];
  let elsewhere = 0, elsewherePct = 0;
  let u = 0;
  const usageIn = (from: number, to: number): { x: Segment["x"]; usd: number; requests: number } => {
    while (u < usage.length && usage[u].ts <= from) u++;
    const x: Segment["x"] = [0, 0, 0, 0];
    let usd = 0, requests = 0;
    let j = u;
    for (; j < usage.length && usage[j].ts <= to; j++) {
      const p = usage[j];
      x[0] += p.input / 1e6; x[1] += p.read / 1e6; x[2] += p.write / 1e6; x[3] += p.output / 1e6;
      usd += p.usd;
      requests++;
    }
    u = j;
    return { x, usd, requests };
  };
  let start: LimitReading | undefined;
  const close = (end: LimitReading) => {
    if (!start || end.ts <= start.ts) return;
    const dpct = end.pct - start.pct;
    const got = usageIn(start.ts, end.ts);
    if (got.requests === 0) {
      if (dpct > res / 2) {
        elsewhere++;
        elsewherePct += dpct;
      }
    } else {
      segments.push({ from: start.ts, to: end.ts, dpct: Math.max(0, dpct), ...got });
    }
    start = end;
  };
  for (let i = 0; i < readings.length; i++) {
    const r = readings[i];
    if (!start) {
      start = r;
      continue;
    }
    const prev = readings[i - 1];
    if (!samePeriod(prev, r, res)) {
      close(prev);
      start = r;
      continue;
    }
    if (r.pct - start.pct >= minStep) close(r);
  }
  if (start && readings.length && readings[readings.length - 1] !== start) close(readings[readings.length - 1]);
  return { segments, elsewhere, elsewherePct };
}

/** Least squares through the origin on the chosen columns; undefined when singular. */
function ols(rows: number[][], y: number[], cols: number[]): number[] | undefined {
  const k = cols.length;
  if (k === 0) return [];
  const a = Array.from({ length: k }, () => new Array(k + 1).fill(0));
  for (let i = 0; i < rows.length; i++) {
    for (let p = 0; p < k; p++) {
      for (let q = 0; q < k; q++) a[p][q] += rows[i][cols[p]] * rows[i][cols[q]];
      a[p][k] += rows[i][cols[p]] * y[i];
    }
  }
  // Gauss-Jordan with partial pivoting.
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
    const scale = Math.max(1e-300, ...a.map((row) => Math.abs(row[c])));
    if (Math.abs(a[piv][c]) < 1e-12 * scale) return undefined;
    [a[c], a[piv]] = [a[piv], a[c]];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let q = c; q <= k; q++) a[r][q] -= f * a[c][q];
    }
  }
  return cols.map((_, p) => a[p][k] / a[p][p]);
}

/**
 * Non-negative least squares through the origin, exactly, by trying every
 * subset of columns (four token types: sixteen subsets) and keeping the best
 * fit whose coefficients are all non-negative. Columns with almost no data
 * are left out and reported as such.
 */
export function nnls(rows: number[][], y: number[], usable: number[]): number[] {
  const width = rows[0]?.length ?? 0;
  let best: { sse: number; coef: number[] } = { sse: y.reduce((s, v) => s + v * v, 0), coef: new Array(width).fill(0) };
  const n = usable.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const cols = usable.filter((_, i) => mask & (1 << i));
    const b = ols(rows, y, cols);
    if (!b || b.some((v) => v < 0)) continue;
    const coef = new Array(width).fill(0);
    cols.forEach((c, i) => (coef[c] = b[i]));
    let sse = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = y[i] - rows[i].reduce((s, v, j) => s + v * coef[j], 0);
      sse += r * r;
    }
    if (sse < best.sse - 1e-15) best = { sse, coef };
  }
  return best.coef;
}

export interface FitQuality {
  /** 1 - SSE / total sum of squares around the mean: share of the variation explained. */
  r2: number;
  /** Leave-one-out prediction error, in points of the limit per segment. */
  looRmse: number;
  /** looRmse relative to the mean rise per segment. */
  relError: number;
}

function quality(y: number[], predictLoo: (i: number) => number, predictAll: (i: number) => number): FitQuality {
  const n = y.length;
  const mean = y.reduce((s, v) => s + v, 0) / n;
  let sst = 0, sse = 0, loo = 0;
  for (let i = 0; i < n; i++) {
    sst += (y[i] - mean) ** 2;
    sse += (y[i] - predictAll(i)) ** 2;
    loo += (y[i] - predictLoo(i)) ** 2;
  }
  const looRmse = Math.sqrt(loo / n);
  return { r2: sst > 0 ? 1 - sse / sst : 0, looRmse, relError: mean > 0 ? looRmse / mean : Infinity };
}

export interface LimitFit {
  window: string;
  label: string;
  app: "claude" | "codex";
  segments: number;
  /** Points the window rose over the fitted segments. */
  totalPct: number;
  /** Rises with no usage on this machine (usage elsewhere), left out. */
  elsewhere: number;
  elsewherePct: number;
  resolution: number;
  /** Requests and list-price dollars the segments hold. */
  requests: number;
  usd: number;
  /** % of the limit per 1M tokens of each type; undefined for a type with too little data. */
  perMillion?: Partial<Record<(typeof TOKEN_TYPES)[number], number>>;
  byType?: FitQuality;
  /** % of the limit per list-price dollar, and how well that alone explains the rises. */
  pctPerUsd?: number;
  byPrice?: FitQuality;
  /** The model most of the dollars went to, which the per-1M figures from price are for. */
  mainModel?: string;
  /** Good enough to put savings in % of this limit. */
  usable: boolean;
  /** Why not, in words, when it is not. */
  why?: string;
}

/** Enough segments, rise and explained variation to quote a number. */
const MIN_SEGMENTS = 8;
const MIN_R2 = 0.6;
const MAX_REL_ERROR = 0.5;

export function fitWindow(readings: LimitReading[], usage: UsagePoint[], step?: number): LimitFit | undefined {
  if (!readings.length) return undefined;
  const last = readings[readings.length - 1];
  const res = resolutionOf(readings);
  const { segments, elsewhere, elsewherePct } = segmentsOf(readings, usage, step);
  const fit: LimitFit = {
    window: last.window,
    label: windowLabel(last.window, last.windowMs),
    app: last.app,
    segments: segments.length,
    totalPct: segments.reduce((s, g) => s + g.dpct, 0),
    elsewhere,
    elsewherePct,
    resolution: res,
    requests: segments.reduce((s, g) => s + g.requests, 0),
    usd: segments.reduce((s, g) => s + g.usd, 0),
    usable: false,
  };
  const byModel = new Map<string, number>();
  for (const p of usage) if (p.model && segments.some((g) => p.ts > g.from && p.ts <= g.to)) byModel.set(p.model, (byModel.get(p.model) ?? 0) + p.usd);
  fit.mainModel = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (segments.length < 3) {
    fit.why = `${segments.length} stretch${segments.length === 1 ? "" : "es"} of readings with usage beside ${segments.length === 1 ? "it" : "them"}; a fit needs ${MIN_SEGMENTS}`;
    return fit;
  }
  const y = segments.map((g) => g.dpct);
  const rows = segments.map((g) => g.x as number[]);
  // A token type with under 50k tokens across the segments is not estimated:
  // its coefficient would be noise. (Output is a small share of the tokens
  // and can still carry much of the limit, so a share rule would drop it.)
  const totals = [0, 1, 2, 3].map((j) => rows.reduce((s, r) => s + r[j], 0));
  const usable = [0, 1, 2, 3].filter((j) => totals[j] >= 0.05);
  if (usable.length) {
    const coef = nnls(rows, y, usable);
    const predict = (c: number[], i: number) => rows[i].reduce((s, v, j) => s + v * c[j], 0);
    fit.byType = quality(
      y,
      (i) => predict(nnls(rows.filter((_, k) => k !== i), y.filter((_, k) => k !== i), usable), i),
      (i) => predict(coef, i)
    );
    fit.perMillion = {};
    usable.forEach((j) => (fit.perMillion![TOKEN_TYPES[j]] = coef[j]));
  }
  const usd = segments.map((g) => g.usd);
  if (usd.some((v) => v > 0)) {
    const k = (ix: number[]) => {
      let num = 0, den = 0;
      for (const i of ix) {
        num += usd[i] * y[i];
        den += usd[i] * usd[i];
      }
      return den > 0 ? Math.max(0, num / den) : 0;
    };
    const idx = y.map((_, i) => i);
    fit.pctPerUsd = k(idx);
    fit.byPrice = quality(y, (i) => k(idx.filter((j) => j !== i)) * usd[i], (i) => fit.pctPerUsd! * usd[i]);
  }
  const best = [fit.byType, fit.byPrice].filter(Boolean).sort((a, b) => a!.looRmse - b!.looRmse)[0];
  if (segments.length < MIN_SEGMENTS) fit.why = `${segments.length} stretches of readings with usage beside them; ${MIN_SEGMENTS} make a fit worth quoting`;
  else if (!best || best.r2 < MIN_R2) fit.why = `the usage recorded here explains ${best ? Math.max(0, Math.round(best.r2 * 100)) : 0}% of the rises (under ${Math.round(MIN_R2 * 100)}%): much of this limit is used elsewhere, or not by tokens`;
  else if (best.relError > MAX_REL_ERROR) fit.why = `predictions miss by ${Math.round(best.relError * 100)}% of a typical rise`;
  else if (!fit.byPrice || fit.byPrice.r2 < MIN_R2 || fit.byPrice.relError > MAX_REL_ERROR) fit.why = "the limit does not follow list price closely enough to put dollars in it";
  else fit.usable = true;
  return fit;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface LimitsReport {
  days: number;
  now: number;
  /** Where the Claude readings are logged, and how many there are. */
  claudeLog: string;
  claudeReadings: number;
  codexReadings: number;
  windows: WindowStatus[];
  fits: LimitFit[];
}

export interface LimitsOptions {
  now?: number;
  logPath?: string;
  codexRoot?: string;
  /** Claude Code transcripts to read usage from (default: every one touched in the period). */
  claudePaths?: string[];
  /** Leave Codex out (savings and the other Claude Code reports). */
  claudeOnly?: boolean;
}

function byWindow(readings: LimitReading[]): Map<string, LimitReading[]> {
  const m = new Map<string, LimitReading[]>();
  for (const r of readings) m.set(r.window, [...(m.get(r.window) ?? []), r]);
  return m;
}

export function limitsReport(days = 30, opts: LimitsOptions = {}): LimitsReport {
  const now = opts.now ?? Date.now();
  const since = now - days * DAY;
  const logPath = opts.logPath ?? limitsLogPath();
  const claude = readClaudeReadings(since, logPath);
  const codex = opts.claudeOnly ? { readings: [], usage: [] } : codexLimitData(since, opts.codexRoot);
  const windows: WindowStatus[] = [];
  const fits: LimitFit[] = [];
  // Claude usage is read only when there are readings to fit it against, and only over their span.
  const claudeUse = claude.length >= 2 ? claudeUsage(claude[0].ts - HOUR, claude[claude.length - 1].ts, opts.claudePaths) : [];
  for (const [, rs] of byWindow(claude)) {
    const s = windowStatus(rs, now);
    if (s) windows.push(s);
    const f = fitWindow(rs, claudeUse);
    if (f) fits.push(f);
  }
  for (const [, rs] of byWindow(codex.readings)) {
    const s = windowStatus(rs, now);
    if (s) windows.push(s);
    const f = fitWindow(rs, codex.usage);
    if (f) fits.push(f);
  }
  return { days, now, claudeLog: logPath, claudeReadings: claude.length, codexReadings: codex.readings.length, windows, fits };
}

/** The Claude fit to quote savings in: the weekly window first (savings are weekly), then the 5-hour one. */
export function claudeLimitFit(r: LimitsReport): LimitFit | undefined {
  return ["seven_day", "five_hour"].map((w) => r.fits.find((f) => f.window === w && f.usable)).find(Boolean);
}

/**
 * A dollar saving over `days`, in the limit's own unit: for the weekly
 * limit, points of it a week ("≈ 4.1% of your weekly limit a week (±1.2)");
 * for the 5-hour window, how many whole windows the saving amounts to.
 */
export function inLimit(fit: LimitFit, usd: number, days: number): string | undefined {
  if (!fit.usable || fit.pctPerUsd === undefined || !fit.byPrice || !(usd > 0) || !(days > 0)) return undefined;
  const round = (v: number) => (v >= 10 ? Math.round(v).toString() : v.toFixed(1));
  const total = fit.pctPerUsd * usd;
  if (fit.window === "seven_day") {
    const pct = (total * 7) / days;
    return `≈ ${round(pct)}% of your weekly limit a week (±${round(pct * fit.byPrice.relError)})`;
  }
  const windows = total / 100;
  return `≈ ${round(windows)} full 5-hour window${windows >= 0.95 && windows < 1.05 ? "" : "s"} in ${days} days (±${round(windows * fit.byPrice.relError)})`;
}

/**
 * Lines for the Claude Code reports: each lever's saving in the limit, when
 * a fit is good enough; nothing otherwise (never a number the fit cannot
 * carry). Kept within 60 columns, as `savings` is.
 */
export function limitSavingsLines(fit: LimitFit | undefined, items: Array<[label: string, usd: number]>, days: number): string[] {
  if (!fit) return [];
  const rows = items.map(([label, usd]) => [label, inLimit(fit, usd, days)] as const).filter((r): r is readonly [string, string] => Boolean(r[1]));
  if (!rows.length) return [];
  const err = fit.byPrice ? Math.round(fit.byPrice.relError * 100) : 0;
  return [
    `In your plan's ${fit.window === "seven_day" ? "weekly limit" : "5-hour window"} (fitted on ${fit.segments} stretches of your`,
    `readings, list price explains ${Math.round((fit.byPrice?.r2 ?? 0) * 100)}% of the rises, ±${err}% each):`,
    ...rows.map(([label, text]) => `  ${label}: ${text}`),
  ];
}

const hm = (ms: number): string => {
  const mins = Math.max(0, Math.round(ms / MIN));
  if (mins < 60) return `${mins} min`;
  if (mins < 48 * 60) return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
  return `${Math.round(mins / 1440)} days`;
};

/** Local clock time, with the weekday when it is not within the next day. */
function clock(ms: number, now: number): string {
  const d = new Date(ms);
  const t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return Math.abs(ms - now) < 20 * HOUR ? t : `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} ${t}`;
}

const pts = (v: number): string => (v >= 10 ? Math.round(v).toString() : v >= 1 ? v.toFixed(1) : v.toFixed(2));

export function renderLimits(r: LimitsReport): string {
  const out: string[] = ["USAGE LIMITS", "═".repeat(60)];
  if (!r.windows.length) {
    out.push(
      "No limit readings yet.",
      "",
      "Claude (Pro and Max): `context-doctor statusline` records the 5-hour and weekly",
      "windows as Claude Code reports them. Set it up with",
      "  context-doctor install --statusline",
      `(or keep your own status line and pipe its input to it too). Readings: ${r.claudeLog.replace(homedir(), "~")}`,
      "Codex: read from ~/.codex/sessions; none found in the period."
    );
    return out.join("\n");
  }
  for (const s of r.windows) {
    const age = r.now - s.at;
    out.push("", `${s.label}: ${pts(s.pct)}% used, read ${hm(age)} ago`);
    if (s.resetSince) {
      out.push(`  It has reset since (at ${clock(s.resetsAt!, r.now)}); the next reading starts the new window.`);
      continue;
    }
    if (s.resetsAt) out.push(`  Resets ${clock(s.resetsAt, r.now)} (in ${hm(s.resetsAt - r.now)}).`);
    if (s.recentPerHour === undefined) out.push("  Pace: not enough recent readings.");
    else if (s.recentPerHour === 0) out.push("  Pace: no rise over the recent readings.");
    else {
      const avg = s.averagePerHour !== undefined ? `; ${pts(s.averagePerHour)} a hour on average this window` : "";
      out.push(`  Pace: ${pts(s.recentPerHour)} points an hour lately${avg}.`);
      if (s.runsOutAt !== undefined) {
        out.push(s.beforeReset
          ? `  At that pace it runs out ${clock(s.runsOutAt, r.now)} (in ${hm(s.runsOutAt - r.now)}), before the reset.`
          : "  At that pace it lasts until the reset.");
      }
    }
  }
  out.push("", "What 1M tokens cost in each limit (fitted on your own readings)");
  out.push("─".repeat(60));
  for (const f of r.fits) {
    out.push(`${f.label}: ${f.segments} stretch${f.segments === 1 ? "" : "es"}, ${pts(f.totalPct)} points, ${f.requests.toLocaleString("en-US")} requests on this machine`);
    if (f.elsewhere) out.push(`  ${f.elsewhere} rise${f.elsewhere === 1 ? "" : "s"} (${pts(f.elsewherePct)} points) with no usage here: used elsewhere, left out.`);
    if (f.perMillion && f.byType && (f.usable || f.segments >= MIN_SEGMENTS)) {
      const parts = TOKEN_TYPES.map((t) => (f.perMillion![t] !== undefined ? `${t} ${pts(f.perMillion![t]!)}%` : `${t} n/a`));
      out.push(`  By token type: ${parts.join(", ")}`);
      out.push(`    explains ${Math.round(Math.max(0, f.byType.r2) * 100)}% of the rises; predicts each within ±${pts(f.byType.looRmse)} points (${Math.round(f.byType.relError * 100)}%)`);
    }
    if (f.pctPerUsd !== undefined && f.byPrice && (f.usable || f.segments >= MIN_SEGMENTS)) {
      out.push(`  By list price: ${pts(f.pctPerUsd * 10)}% per $10${f.mainModel ? ` (mostly ${f.mainModel})` : ""}`);
      out.push(`    explains ${Math.round(Math.max(0, f.byPrice.r2) * 100)}% of the rises; predicts each within ±${pts(f.byPrice.looRmse)} points (${Math.round(f.byPrice.relError * 100)}%)`);
    }
    out.push(f.usable ? "  Good enough to show savings in this limit (savings, cache-misses, compact-window)." : `  Too thin to quote: ${f.why}.`);
  }
  out.push(
    "",
    "Readings: Claude Code's status line input (Pro/Max, 0.1% steps) and Codex's",
    "rollouts (whole percents). Usage elsewhere (the web app, another computer)",
    "moves the limit without a transcript here, so it widens the error."
  );
  return out.join("\n");
}
