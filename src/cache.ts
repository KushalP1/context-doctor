/**
 * Prompt-cache analysis for Claude Code sessions.
 *
 * Transcripts record what the API actually charged per request — including
 * cache reads and cache writes — so cache behaviour can be reported as fact
 * rather than estimated. This is usually the largest single lever on cost:
 * a cached read bills at ~10% of input, while a cache write bills at ~125%,
 * so a session that keeps invalidating its prefix pays more than one with no
 * caching at all.
 */

import { readFileSync } from "node:fs";
import { pricingFor } from "./pricing.js";

export interface CacheUsage {
  requests: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
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

/** Cache pricing multipliers relative to the base input rate. */
const CACHE_WRITE_MULTIPLIER = 1.25;

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
  let uncachedTokens = 0;
  let model: string | undefined;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, any>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "assistant" || !entry.message) continue;
    const usage = entry.message.usage as Record<string, number> | undefined;
    if (!usage) continue;
    requests++;
    cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
    uncachedTokens += usage.input_tokens ?? 0;
    if (typeof entry.message.model === "string") model = entry.message.model;
  }

  if (requests === 0) return null;
  const totalInput = cacheReadTokens + cacheWriteTokens + uncachedTokens;
  const usage: CacheUsage = {
    requests,
    cacheReadTokens,
    cacheWriteTokens,
    uncachedTokens,
    hitRate: totalInput > 0 ? cacheReadTokens / totalInput : 0,
    model,
  };

  const pricing = pricingFor(model);
  if (pricing) {
    const perM = (tokens: number, rate: number): number => (tokens / 1_000_000) * rate;
    const readUsd = perM(cacheReadTokens, pricing.cacheReadPerM);
    const writeUsd = perM(cacheWriteTokens, pricing.inputPerM * CACHE_WRITE_MULTIPLIER);
    const freshUsd = perM(uncachedTokens, pricing.inputPerM);
    usage.paidUsd = readUsd + writeUsd + freshUsd;
    usage.uncachedUsd = perM(totalInput, pricing.inputPerM);
    usage.savedUsd = usage.uncachedUsd - usage.paidUsd;
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
  lines.push(
    `  read ${tok(usage.cacheReadTokens)} · written ${tok(usage.cacheWriteTokens)} · uncached ${tok(usage.uncachedTokens)}`
  );
  if (usage.paidUsd !== undefined && usage.uncachedUsd !== undefined && usage.savedUsd !== undefined) {
    lines.push(
      `  input cost ${fmt(usage.paidUsd)} — caching saved ${fmt(usage.savedUsd)} against ${fmt(usage.uncachedUsd)} uncached (list prices)`
    );
  }

  // A cache write costs 1.25x input while a read costs 0.1x, so writes that
  // rival reads mean the prefix keeps changing and caching is losing money.
  const writeShare = usage.cacheReadTokens > 0 ? usage.cacheWriteTokens / usage.cacheReadTokens : Infinity;
  if (usage.hitRate < 0.5 && usage.requests > 5) {
    lines.push(
      "  ⚠ Low hit rate: something early in the prompt changes between requests. Keep the system prompt, tool list and reference docs byte-stable and put volatile content last."
    );
  } else if (writeShare > 0.5) {
    lines.push(
      "  ⚠ Cache churn: writes are large relative to reads, and a write costs 1.25x input against 0.1x for a read. The cached prefix is being rebuilt often."
    );
  }
  return lines.join("\n");
}
