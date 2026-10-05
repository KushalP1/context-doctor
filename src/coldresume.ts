/**
 * Cold resume: coming back to a large session after the prompt cache expired.
 *
 * Claude Code caches the conversation for an hour on a subscription (five
 * minutes on the API). Come back later and the next message re-sends the
 * whole context at the cache-WRITE rate (1.25x), and every message after it
 * re-reads it (0.1x each). On a 500k-token session that is the most expensive
 * moment of the day, and the one moment `/compact` is cheapest to accept:
 * the cache is being rebuilt anyway.
 *
 * Measured on the author's 133 days of Claude Code history: 401 returns to a
 * session over 150k tokens after more than 65 idle minutes (median context
 * 517k). Compacting right after the first reply, counting the compaction
 * request itself and only the messages up to the next such return, would have
 * saved $4,053 at list price, about $914 a month; it paid off in 296 of 401
 * cases, and the worst single loss was $2.30 (sessions left after a few more
 * messages). So this advises, with the numbers, and the user decides.
 *
 * It works where the proxy cannot: the desktop app's Code tab runs Claude Code
 * host-orchestrated and drops a settings-file ANTHROPIC_BASE_URL, but it runs
 * the every-prompt hook, which is where this is called from.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { forEachLine } from "./session.js";
import { pricingFor, formatUsd } from "./pricing.js";
import { formatTokens } from "./tokens.js";

/** Just past Claude Code's one-hour cache, as Claude Code's own idle clearing uses. */
export const COLD_IDLE_MS = 65 * 60_000;
/** Below this, a rebuilt cache is cheap and compaction is not worth the interruption. */
export const COLD_MIN_TOKENS = 150_000;
/** What a compacted session restarts from: system prompt and tools plus the summary. */
const AFTER_COMPACT_TOKENS = 45_000;
/** Output tokens a compaction summary costs, and output's price relative to input. */
const SUMMARY_OUTPUT_TOKENS = 8_000;
const OUTPUT_PRICE_RATIO = 5;

export interface ColdResume {
  idleMs: number;
  /** Context size at the last request, from the API's own usage. */
  tokens: number;
  model?: string;
  /** Timestamp of the last assistant reply: identifies this idle period. */
  lastReplyAt: number;
  /** This message's cost to rebuild the cache, at list price. */
  resumeUsd?: number;
  /** Each later message's cost to re-read the context, at list price. */
  perMessageUsd?: number;
}

function tailLines(path: string, bytes = 256 * 1024): string[] {
  const size = statSync(path).size;
  const n = Math.min(size, bytes);
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(n);
  try {
    readSync(fd, buf, 0, n, size - n);
  } finally {
    closeSync(fd);
  }
  return buf.toString("utf8").split("\n").reverse();
}

/**
 * Is the prompt being submitted now a return to a large, cache-cold session?
 * Reads only the transcript's tail. Undefined when not (or when unreadable).
 */
export function detectColdResume(path: string, now = Date.now(), idleMs = COLD_IDLE_MS, minTokens = COLD_MIN_TOKENS): ColdResume | undefined {
  try {
    for (const line of tailLines(path)) {
      let e: any;
      try { e = JSON.parse(line); } catch { continue; }
      // Compacted since the last reply: the old usage no longer describes the
      // context, and there is nothing large left to warn about.
      if (e?.type === "system" && e.subtype === "compact_boundary") return undefined;
      if (e?.isCompactSummary) return undefined;
      if (e?.type !== "assistant" || e.isSidechain) continue;
      const u = e.message?.usage;
      if (!u) continue;
      const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      if (tokens <= 0) continue;
      const lastReplyAt = Date.parse(e.timestamp);
      if (!Number.isFinite(lastReplyAt)) return undefined;
      const idle = now - lastReplyAt;
      if (idle < idleMs || tokens < minTokens) return undefined;
      const model: string | undefined = e.message?.model;
      const p = pricingFor(model);
      return {
        idleMs: idle,
        tokens,
        model,
        lastReplyAt,
        resumeUsd: p ? (tokens * 1.25 * p.inputPerM) / 1e6 : undefined,
        perMessageUsd: p ? (tokens * 0.1 * p.inputPerM) / 1e6 : undefined,
      };
    }
  } catch {
    /* unreadable transcript: no advice */
  }
  return undefined;
}

function duration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 90) return `${m} minutes`;
  const h = ms / 3_600_000;
  return h < 48 ? `${h.toFixed(h < 10 ? 1 : 0)} hours` : `${Math.round(h / 24)} days`;
}

/**
 * The one line shown to the USER in the app (hook `systemMessage`). In the
 * first week the offer lived only inside the model's reply and was acted on
 * 1 time in 33; a notice of its own is harder to miss.
 */
export function renderColdResumeNotice(c: ColdResume): string {
  const cheaper = Math.max(0, Math.round((1 - AFTER_COMPACT_TOKENS / c.tokens) * 100));
  const money = c.resumeUsd !== undefined ? ` (~${formatUsd(c.resumeUsd)} at list price)` : "";
  return `context-doctor: idle ${duration(c.idleMs)}, so this message re-sent the whole ~${formatTokens(c.tokens)}-token context${money}. If you keep working here, /compact now makes each later message ~${cheaper}% cheaper.`;
}

/** The note the hook hands the model: the numbers, and one sentence to say. */
export function renderColdResume(c: ColdResume): string {
  const cheaper = Math.max(0, Math.round((1 - AFTER_COMPACT_TOKENS / c.tokens) * 100));
  const money = c.resumeUsd !== undefined
    ? ` (~${formatUsd(c.resumeUsd)} at list price), and every later message re-reads it (~${formatUsd(c.perMessageUsd!)} each)`
    : ", and every later message re-reads it";
  return [
    `This session was idle for ${duration(c.idleMs)}, longer than the prompt cache lasts, so this message re-sends the whole ~${formatTokens(c.tokens)}-token context at the full cache-write rate${money}.`,
    `If the user is going to keep working in this session, running /compact now restarts it from a short summary and makes each later message roughly ${cheaper}% cheaper; the cache is being rebuilt anyway, so now is when compaction costs least.`,
    "Begin your reply with one short sentence offering that (only the user can run /compact), then answer the request normally. Do not raise it again this session unless it goes idle again.",
  ].join("\n");
}

export interface ColdResumeEvent {
  at: number;
  tokens: number;
  /** Messages until the session ended, was compacted, or went cold again. */
  messagesAfter: number;
  /** Net USD compaction after the first reply would have saved (negative: cost). */
  netUsd: number;
}

/**
 * Replay a transcript's billed usage and price what compacting at each cold
 * resume would have saved. Each resume only counts the messages up to the
 * next one (no double counting), and the compaction request is a cost.
 */
export function coldResumeEvents(path: string, idleMs = COLD_IDLE_MS, minTokens = COLD_MIN_TOKENS): ColdResumeEvent[] {
  type Req = { at: number; total: number } | "compact";
  const reqs: Req[] = [];
  let lastId: string | undefined, model: string | undefined;
  forEachLine(path, (line) => {
    let e: any;
    try { e = JSON.parse(line); } catch { return; }
    if (!e || e.isSidechain) return;
    if (e.type === "system" && e.subtype === "compact_boundary") { reqs.push("compact"); return; }
    if (e.type !== "assistant" || !e.message || e.message.id === lastId) return;
    lastId = e.message.id;
    const u = e.message.usage ?? {};
    const total = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const at = Date.parse(e.timestamp);
    if (total > 0 && Number.isFinite(at)) { reqs.push({ at, total }); model ??= e.message.model; }
  });
  const perM = pricingFor(model)?.inputPerM;
  if (!perM) return [];
  const real = reqs.filter((r): r is { at: number; total: number } => r !== "compact");
  if (real.length < 2) return [];
  const events: ColdResumeEvent[] = [];
  for (let i = 1; i < reqs.length; i++) {
    const a = reqs[i - 1], b = reqs[i];
    if (a === "compact" || b === "compact") continue;
    if (b.at - a.at <= idleMs || b.total < minTokens) continue;
    const removed = Math.max(0, b.total - AFTER_COMPACT_TOKENS);
    let saved = 0, n = 0, prev = b.at;
    for (const c of reqs.slice(i + 1)) {
      if (c === "compact") break;
      if (c.at - prev > idleMs && c.total >= minTokens) break;
      saved += (c.at - prev > 3_600_000 ? 1.25 : 0.1) * removed;
      prev = c.at;
      n++;
    }
    const cost = 0.1 * b.total + OUTPUT_PRICE_RATIO * SUMMARY_OUTPUT_TOKENS + 1.25 * AFTER_COMPACT_TOKENS;
    events.push({ at: b.at, tokens: b.total, messagesAfter: n, netUsd: ((saved - cost) * perM) / 1e6 });
  }
  return events;
}
