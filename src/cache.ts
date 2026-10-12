/**
 * Prompt-cache analysis for Claude Code sessions.
 *
 * Transcripts record what the API actually charged per request — including
 * cache reads and cache writes — so cache behaviour can be reported as fact
 * rather than estimated. This is usually the largest single lever on cost:
 * a cached read bills at a tenth of input or less, while a cache write bills
 * at 1.25x (2x at the 1-hour TTL Claude Code's main thread uses), so a
 * session that keeps invalidating its prefix pays more than one with no
 * caching at all.
 */

import { readFileSync } from "node:fs";
import { cacheWriteSplit, pricingFor, usageCost } from "./pricing.js";
import { replyCounter } from "./session.js";
import { realModel } from "./tokens.js";

export interface CacheUsage {
  /** API requests: each reply once, however many transcript rows it was written as. */
  requests: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The part of cacheWriteTokens written at the 1-hour TTL (2x input instead of 1.25x). */
  cacheWrite1hTokens: number;
  uncachedTokens: number;
  /** Share of input tokens served from cache (0-1). */
  hitRate: number;
  model?: string;
  /** What the input actually cost, at list prices. */
  paidUsd?: number;
  /** What the same input would have cost with no caching at all. */
  uncachedUsd?: number;
  /** paidUsd vs uncachedUsd — positive means caching is paying off. */
  savedUsd?: number;
  /** USD spent on cache writes; high values mean the prefix keeps changing. */
  writeUsd?: number;
}

export function analyzeCacheUsage(transcriptPath: string): CacheUsage | null {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }

  let requests = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let cacheWrite1hTokens = 0;
  let uncachedTokens = 0;
  let model: string | undefined;
  let priced = 0;
  let paidUsd = 0;
  let uncachedUsd = 0;
  let writeUsd = 0;
  // Claude Code writes ~2.2 rows per API reply, each carrying the reply's
  // full usage: counting rows reported 1201 requests for 541 replies on a
  // real session and more than doubled every total.
  const sighting = replyCounter();

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, any>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "assistant" || !entry.message) continue;
    const usage = entry.message.usage as Record<string, any> | undefined;
    if (!usage) continue;
    // "<synthetic>" rows are messages Claude Code writes itself, not requests.
    if (typeof entry.message.model === "string" && !realModel(entry.message.model)) continue;
    if (sighting(entry) !== "new") continue;
    model = realModel(entry.message.model) ?? model;
    requests++;
    const read = usage.cache_read_input_tokens ?? 0;
    const write = usage.cache_creation_input_tokens ?? 0;
    const fresh = usage.input_tokens ?? 0;
    cacheReadTokens += read;
    cacheWriteTokens += write;
    cacheWrite1hTokens += cacheWriteSplit(usage).oneHour;
    uncachedTokens += fresh;
    // Each request at its own model's price: a session can switch models.
    const pricing = pricingFor(model);
    if (pricing) {
      const cost = usageCost(usage, pricing);
      priced++;
      paidUsd += cost.promptUsd;
      writeUsd += cost.writeUsd;
      uncachedUsd += ((fresh + read + write) * pricing.inputPerM) / 1_000_000;
    }
  }

  if (requests === 0) return null;
  const totalInput = cacheReadTokens + cacheWriteTokens + uncachedTokens;
  const usage: CacheUsage = {
    requests,
    cacheReadTokens,
    cacheWriteTokens,
    cacheWrite1hTokens,
    uncachedTokens,
    hitRate: totalInput > 0 ? cacheReadTokens / totalInput : 0,
    model,
  };

  if (priced > 0) {
    usage.paidUsd = paidUsd;
    usage.uncachedUsd = uncachedUsd;
    usage.savedUsd = uncachedUsd - paidUsd;
    usage.writeUsd = writeUsd;
  }
  return usage;
}

/** One-paragraph verdict for humans, or null when there is nothing to say. */
export function renderCacheReport(usage: CacheUsage | null): string | null {
  if (!usage) return null;
  const pct = (usage.hitRate * 100).toFixed(1);
  const lines: string[] = [];
  const fmt = (n: number): string => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
  const tok = (n: number): string =>
    n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

  lines.push(`Prompt cache: ${pct}% of input served from cache across ${usage.requests} requests`);
  const oneHour = usage.cacheWrite1hTokens > 0 ? ` (${tok(usage.cacheWrite1hTokens)} at the 1-hour TTL)` : "";
  lines.push(
    `  read ${tok(usage.cacheReadTokens)} · written ${tok(usage.cacheWriteTokens)}${oneHour} · uncached ${tok(usage.uncachedTokens)}`
  );
  if (usage.paidUsd !== undefined && usage.uncachedUsd !== undefined && usage.savedUsd !== undefined) {
    lines.push(
      `  input cost ${fmt(usage.paidUsd)} — caching saved ${fmt(usage.savedUsd)} against ${fmt(usage.uncachedUsd)} uncached (list prices)`
    );
  }

  // A cache write costs 1.25-2x input while a read costs 0.1x or less, so
  // writes that rival reads mean the prefix keeps changing and caching is
  // losing money.
  const writeShare = usage.cacheReadTokens > 0 ? usage.cacheWriteTokens / usage.cacheReadTokens : Infinity;
  if (usage.hitRate < 0.5 && usage.requests > 5) {
    lines.push(
      "  ⚠ Low hit rate: something early in the prompt changes between requests. Keep the system prompt, tool list and reference docs byte-stable and put volatile content last."
    );
  } else if (writeShare > 0.5) {
    lines.push(
      "  ⚠ Cache churn: writes are large relative to reads, and a write costs 1.25x input (2x at the 1-hour TTL) against 0.1x or less for a read. The cached prefix is being rebuilt often."
    );
  }
  return lines.join("\n");
}
