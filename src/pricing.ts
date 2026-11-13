/**
 * Per-model pricing for cost estimation, USD per million tokens.
 *
 * List rates of each provider's first-party API (standard tier, global
 * routing, no batch or fast mode), each family with the page it was read
 * from and the date. What a request recorded can bill it differently (fast
 * mode, US-only inference, a long prompt's tier, web searches) and a row's
 * price can end on a known day: requestCost applies all of it, per request,
 * from the row's billing options. Prices drift, so all cost output is
 * labeled as an estimate. One table, one file, easy to update: PRs welcome
 * when prices change.
 *
 * A row names one model (a "known" price, see knownPricingFor) unless it is
 * listed in FALLBACKS: those price ids the table does not know by version,
 * at a family's price, so a new release still gets a number. A model a
 * provider prices only per minute, per image or not at all has no row.
 */

import { createHash } from "node:crypto";
import { orgApplies, orgRates, orgRowFor } from "./orgrates.js";

export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPerM: number;
  /** USD per 1M output tokens (unused by the profiler, kept for reference). */
  outputPerM: number;
  /** USD per 1M cached input tokens read (2.5-10% of input, depending on the Claude model). */
  cacheReadPerM: number;
  /**
   * USD per 1M cache-write tokens, every lifetime alike: only an
   * organization's contracted row has one (orgrates.ts). Without it a write
   * is its TTL's multiple of input.
   */
  cacheWritePerM?: number;
}

/** What a cache write costs per 1M tokens at `mult` times input (its TTL's), or the row's own write rate. */
export function writePerM(p: ModelPricing, mult: number): number {
  return p.cacheWritePerM ?? mult * p.inputPerM;
}

/** Anthropic cache writes, relative to the input price: 5-minute TTL and 1-hour TTL. */
export const CACHE_WRITE_5M = 1.25;
export const CACHE_WRITE_1H = 2;
/**
 * OpenAI cache writes on GPT-5.6 and later, relative to input: 1.25x for the
 * default 30-minute lifetime (the same rate as Anthropic's 5-minute writes,
 * so they share that slot below) and 2.5x for 12 hours. "Total write rates,
 * not surcharges"; earlier models charge no writes (prompt caching guide,
 * read 2026-10-26).
 */
export const CACHE_WRITE_OPENAI_30M = 1.25;
export const CACHE_WRITE_OPENAI_12H = 2.5;

const rate = (inputPerM: number, outputPerM: number, cacheReadPerM: number): ModelPricing => ({ inputPerM, outputPerM, cacheReadPerM });

/**
 * One Claude version, whatever wraps the id: a date (-20251101, @20251101),
 * "[1m]", a Bedrock prefix. Prices differ between a major and its minor
 * releases (Opus 5 is $5 in, Opus 5.5 is $4), so neither may match the
 * other: a minor is one or two digits after the major, a date suffix is
 * eight, and that is what the lookaheads tell apart.
 */
function claude(families: string, major: number, minor?: number): RegExp {
  return minor === undefined
    ? new RegExp(`claude-(?:${families})-${major}(?![.\\d]|-\\d{1,2}(?!\\d))`, "i")
    : new RegExp(`claude-(?:${families})-${major}[-.]${minor}(?!\\d)`, "i");
}

/** The Claude family fallbacks: a price for ids the table does not know by version yet. */
const CLAUDE_FAMILY = [/claude.*fable|claude.*mythos/i, /claude.*opus/i, /claude.*sonnet/i, /claude.*haiku/i];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One OpenAI model by its exact name, bare, with a snapshot date
 * (gpt-5.5-2026-04-23) or behind a provider prefix (openai/gpt-5.5):
 * "gpt-5.5" never matches gpt-5.5-pro or gpt-5.5-cyber, "gpt-5" never
 * gpt-5.4, "o3" never o3-pro.
 */
function openai(name: string): RegExp {
  return new RegExp(`(?<![\\w.-])${escapeRe(name)}(?:-\\d{4}-\\d{2}-\\d{2})?(?![\\w.-])`, "i");
}

/**
 * One Gemini text model, with any suffix Google adds to the same model
 * (-preview, -001, -preview-05-20, -customtools), but not the image, audio,
 * live and TTS models that share its name and are priced per image or
 * minute, nor its -lite sibling.
 */
function gemini(name: string): RegExp {
  return new RegExp(`(?<![\\w.-])${escapeRe(name)}(?![\\w.])(?!-(?:[\\w.]+-)*(?:lite|image|tts|live|audio|transcribe|translate)\\b)`, "i");
}

/**
 * What a row's price does beyond its rates: each read from the provider's
 * page, never assumed for a model the page does not name.
 */
interface RowBilling {
  /** Prices ids the table does not know by name, at a family's price: an estimate. */
  fallback?: true;
  /**
   * A tier by prompt length: a request whose prompt (uncached input, cache
   * reads and cache writes) is over `over` tokens bills ALL of it at `rates`.
   */
  long?: { over: number; rates: ModelPricing };
  /** Anthropic's fast mode (`usage.speed: "fast"`): these rates for the whole request; cache reads and writes keep their multipliers of this input. */
  fast?: ModelPricing;
  /** Claude 4.6 and later: US-only inference (`usage.inference_geo: "us"`) bills every category at 1.1x. */
  geo?: true;
  /**
   * The day this price stops (YYYY-MM-DD, from 00:00 UTC; the pages give a
   * date, not a time or zone) and, when the page says, the price from then.
   * A request on or after it is an estimate (see rateCard).
   */
  changes?: string;
  then?: ModelPricing;
  /** From `changes`, its requests are billed as this model's, whatever that model's price does later. */
  routes?: string;
}

/** A row that prices ids the table does not know by name, at a family's price. */
const FALLBACK: RowBilling = { fallback: true };
/** Claude 4.6 and later. */
const GEO: RowBilling = { geo: true };

/**
 * OpenAI's long-context column: a prompt over 272k input tokens bills the
 * whole request at 2x input, cached input and cache writes and 1.5x output.
 * Checked row by row against the page (2026-11-08): every model with a
 * "Long context" price, and only those, is 2x / 1.5x of its short one.
 */
const OPENAI_LONG = (r: ModelPricing): RowBilling["long"] => ({ over: 272_000, rates: rate(r.inputPerM * 2, r.outputPerM * 1.5, r.cacheReadPerM * 2) });
const openaiLong = (inputPerM: number, outputPerM: number, cacheReadPerM: number): [ModelPricing, RowBilling] => {
  const r = rate(inputPerM, outputPerM, cacheReadPerM);
  return [r, { long: OPENAI_LONG(r) }];
};

const PRICING: Array<[pattern: RegExp, pricing: ModelPricing, billing?: RowBilling]> = [
  // Anthropic: platform.claude.com/docs/en/about-claude/pricing ("Model
  // pricing"; 5-minute writes 1.25x, 1-hour writes 2x), read 2026-11-06,
  // its modifiers read 2026-11-08 (pricing.md); read again 2026-11-10: Fable
  // 5.2 and Mythos 5.2 added, every other row and modifier unchanged:
  //  - "Data residency pricing": for Claude 4.6 and later, `inference_geo:
  //    "us"` is 1.1x on input, output, cache writes and reads, and on Haiku
  //    5.5's over-100k prices too (GEO). Earlier models reject the parameter.
  //  - "Fast mode pricing": Fable 5.2 and Mythos 5.2 $16 / $80 (read
  //    2026-11-10), Opus 5.5 $8 / $40, Opus 5 and Opus 4.8 $10 / $50,
  //    "across the full context window"; caching multipliers and data
  //    residency apply on top (Opus 5.5's reads 0.05x: $0.40).
  //  - "Long context pricing": only Haiku 5.5 is priced by prompt length.
  // Specific Claude versions first: the family rows below are only a
  // fallback for ids this table does not know yet.
  // Fable 5.2 and Mythos 5.2 (read 2026-11-10): $8 / $40, writes $10 (5 min)
  // and $16 (1 h), reads 0.025x ($0.20); fast mode $16 / $80 on the Claude
  // API, reads $0.40 at that multiplier; US-only 1.1x (Claude 4.6 and later).
  [claude("fable|mythos", 5, 2), rate(8, 40, 0.2), { geo: true, fast: rate(16, 80, 0.4) }],
  [claude("fable|mythos", 5, 1), rate(10, 50, 0.25), GEO],
  [claude("fable|mythos", 5), rate(10, 50, 1), GEO],
  [claude("opus", 5, 5), rate(4, 20, 0.2), { geo: true, fast: rate(8, 40, 0.4) }],
  [claude("opus", 5), rate(5, 25, 0.5), { geo: true, fast: rate(10, 50, 1) }],
  [claude("opus", 4, 8), rate(5, 25, 0.5), { geo: true, fast: rate(10, 50, 1) }],
  [claude("opus", 4, 7), rate(5, 25, 0.5), GEO],
  [claude("opus", 4, 6), rate(5, 25, 0.5), GEO],
  [claude("opus", 4, 5), rate(5, 25, 0.5)],
  [claude("opus", 4, 1), rate(15, 75, 1.5)],
  [claude("opus", 4), rate(15, 75, 1.5)],
  // Sonnet 5.5's cache hits are 5% of input ($0.10), Sonnet 5's 10%.
  [claude("sonnet", 5, 5), rate(2, 10, 0.1), GEO],
  [claude("sonnet", 5), rate(2, 10, 0.2), GEO],
  // Haiku 5.5's rates hold for prompts up to 100,000 tokens; a longer prompt
  // (cache reads and writes count toward it) bills the whole request at
  // $0.50 / $2.50 / $0.05, writes at their multipliers of $0.50.
  [claude("haiku", 5, 5), rate(0.1, 0.5, 0.01), { geo: true, long: { over: 100_000, rates: rate(0.5, 2.5, 0.05) } }],
  [claude("haiku", 4, 5), rate(1, 5, 0.1)],
  // Sonnet 4.6, 4.5 and 4 are all $3 / $15 / $0.30, the family row's price;
  // rows of their own so a spending cap can tell a known version from a
  // guess (knownPricingFor).
  [claude("sonnet", 4, 6), rate(3, 15, 0.3), GEO],
  [claude("sonnet", 4, 5), rate(3, 15, 0.3)],
  [claude("sonnet", 4), rate(3, 15, 0.3)],
  // Retired Claude 3 models, no longer on the page: their last list price.
  [/claude-3-opus/i, rate(15, 75, 1.5)],
  [/claude-3-5-haiku/i, rate(0.8, 4, 0.08)],
  [/claude-3-haiku/i, rate(0.25, 1.25, 0.03)],
  [/claude-3-[57]-sonnet/i, rate(3, 15, 0.3)],
  // Claude Mythos Preview (claude-mythos-preview) has no list price on the
  // page; the Fable/Mythos family row prices it as a fallback. A version the
  // table does not know yet is a new one: 4.6 or later, so US-only applies.
  [CLAUDE_FAMILY[0], rate(10, 50, 1), { ...FALLBACK, ...GEO }],
  [CLAUDE_FAMILY[1], rate(5, 25, 0.5), { ...FALLBACK, ...GEO }],
  [CLAUDE_FAMILY[2], rate(3, 15, 0.3), { ...FALLBACK, ...GEO }],
  [CLAUDE_FAMILY[3], rate(1, 5, 0.1), { ...FALLBACK, ...GEO }],

  // OpenAI: developers.openai.com/api/docs/pricing (Standard, the "Short"
  // context column), read 2026-11-06; its "Long context" columns (prompts
  // over 272k input tokens, OPENAI_LONG) read 2026-11-08. Cache writes are
  // 1.25x input on GPT-5.6 and later (CACHE_WRITE_OPENAI_30M). Models with
  // no cached-input price (the -pro ones) read at full input. Not modelled:
  // Fast mode (priority processing; Codex records only its thread's
  // `service_tier`, not each request's) and the 10% regional uplift.
  [openai("gpt-6-astra"), ...openaiLong(10, 50, 1)],
  [openai("gpt-6-astra-law"), rate(10, 50, 1)],
  [openai("gpt-6.1-sol"), ...openaiLong(2, 10, 0.1)],
  [openai("gpt-6.1-terra"), ...openaiLong(1, 5, 0.05)],
  [openai("gpt-6-sol"), ...openaiLong(2, 10, 0.2)],
  [openai("gpt-6-luna"), ...openaiLong(0.1, 0.5, 0.01)],
  [openai("gpt-6-cyber"), rate(20, 100, 2)],
  [openai("gpt-6-rosalind"), ...openaiLong(15, 75, 1.5)],
  [openai("gpt-rosalind-research"), rate(5, 25, 0.5)],
  [openai("gpt-rosalind-discovery"), rate(5, 25, 0.5)],
  // GPT-5.6 Sol's $4 / $20 is promotional "until November 30, 2026" (read
  // again 2026-11-08); the page does not say what follows. The gpt-5.6 alias
  // routes to Sol (model page, read 2026-11-06).
  [openai("gpt-5.6-sol"), rate(4, 20, 0.4), { long: OPENAI_LONG(rate(4, 20, 0.4)), changes: "2026-12-01" }],
  [openai("gpt-5.6"), rate(4, 20, 0.4), { long: OPENAI_LONG(rate(4, 20, 0.4)), changes: "2026-12-01" }],
  [openai("gpt-5.6-terra"), ...openaiLong(2, 12, 0.2)],
  [openai("gpt-5.6-luna"), ...openaiLong(0.2, 1.2, 0.02)],
  [openai("gpt-5.6-cyber"), rate(12.5, 75, 1.25)],
  [openai("gpt-5.5"), ...openaiLong(5, 30, 0.5)],
  [openai("gpt-5.5-pro"), ...openaiLong(30, 180, 30)],
  [openai("gpt-5.5-cyber"), rate(12.5, 75, 1.25)],
  [openai("gpt-5.4"), ...openaiLong(2.5, 15, 0.25)],
  [openai("gpt-5.4-mini"), rate(0.75, 4.5, 0.075)],
  [openai("gpt-5.4-nano"), rate(0.2, 1.25, 0.02)],
  [openai("gpt-5.4-pro"), ...openaiLong(30, 180, 30)],
  [openai("gpt-5.3-codex"), rate(1.75, 14, 0.175)],
  [openai("gpt-5.2"), rate(1.75, 14, 0.175)],
  [openai("gpt-5.2-pro"), rate(21, 168, 21)],
  [openai("gpt-5.1"), rate(1.25, 10, 0.125)],
  [openai("gpt-5"), rate(1.25, 10, 0.125)],
  [openai("gpt-5-mini"), rate(0.25, 2, 0.025)],
  [openai("gpt-5-nano"), rate(0.05, 0.4, 0.005)],
  [openai("gpt-5-pro"), rate(15, 120, 15)],
  [openai("gpt-4.1"), rate(2, 8, 0.5)],
  [openai("gpt-4.1-mini"), rate(0.4, 1.6, 0.1)],
  [openai("gpt-4o"), rate(2.5, 10, 1.25)],
  [openai("gpt-4o-mini"), rate(0.15, 0.6, 0.075)],
  [openai("o3"), rate(2, 8, 0.5)],
  [openai("o3-pro"), rate(20, 80, 20)],
  [openai("chat-latest"), rate(5, 30, 0.5)],
  // Fallbacks for OpenAI ids not on the page (gpt-5-codex, gpt-5.1-codex-max,
  // gpt-4.1-nano, gpt-4-turbo, o1, o3-mini...): older approximate prices.
  [/gpt-5.*(mini|nano)/i, rate(0.25, 2, 0.025), FALLBACK],
  [/gpt-5/i, rate(1.25, 10, 0.125), FALLBACK],
  [/gpt-4o-mini/i, rate(0.15, 0.6, 0.075), FALLBACK],
  [/gpt-4o|gpt-4\.1/i, rate(2.5, 10, 1.25), FALLBACK],
  [/gpt-4-turbo/i, rate(10, 30, 10), FALLBACK],
  [/o[13](-|$)/i, rate(2, 8, 1), FALLBACK],

  // Google: ai.google.dev/gemini-api/docs/pricing (paid tier, Standard, text),
  // read 2026-11-06; the dates and the Pro tiers read again 2026-11-08.
  // Gemini 4 Argon's $2 / $10 / $0.10 hold "through November 30, 2026";
  // "starting December 1, 2026" it is $4 / $20 / $0.20.
  [gemini("gemini-4-argon"), rate(2, 10, 0.1), { changes: "2026-12-01", then: rate(4, 20, 0.2) }],
  // 3.6 and 3.8 Flash double "starting January 1, 2027" ($1.50 / $7.50 / $0.15).
  [gemini("gemini-3.8-flash"), rate(0.75, 3.75, 0.075), { changes: "2027-01-01", then: rate(1.5, 7.5, 0.15) }],
  [gemini("gemini-3.6-flash"), rate(0.75, 3.75, 0.075), { changes: "2027-01-01", then: rate(1.5, 7.5, 0.15) }],
  [gemini("gemini-3.5-flash-lite"), rate(0.3, 2.5, 0.03)],
  [gemini("gemini-3.1-flash-lite"), rate(0.25, 1.5, 0.025)],
  // 3.1 Pro and 2.5 Pro bill a prompt over 200k tokens at $4 / $18 / $0.40
  // and $2.50 / $15 / $0.25. From December 1, 2026 every gemini-2.5-pro
  // request is routed to 3.8 Flash and billed at its rates ($0.75 / $3.75 /
  // $0.075 then). gemini-2.5-flash is routed to 3.5 Flash-Lite that day, at
  // the same $0.30 / $2.50 / $0.03: no change to say.
  [gemini("gemini-3.1-pro"), rate(2, 12, 0.2), { long: { over: 200_000, rates: rate(4, 18, 0.4) } }],
  [gemini("gemini-3-flash"), rate(0.5, 3, 0.05)],
  [gemini("gemini-2.5-pro"), rate(1.25, 10, 0.125), { long: { over: 200_000, rates: rate(2.5, 15, 0.25) }, changes: "2026-12-01", then: rate(0.75, 3.75, 0.075), routes: "gemini-3.8-flash" }],
  [gemini("gemini-2.5-flash"), rate(0.3, 2.5, 0.03)],
  [gemini("gemini-2.5-flash-lite"), rate(0.1, 0.4, 0.01)],
  // Fallbacks for Gemini ids not on the page (gemini-3-pro, a new 3.x Flash,
  // 2.0 Flash...).
  [/gemini-3[.\d]*-flash-lite/i, rate(0.3, 2.5, 0.03), FALLBACK],
  [/gemini-3[.\d]*-flash/i, rate(0.75, 3.75, 0.075), FALLBACK],
  [/gemini-3[.\d]*-pro/i, rate(2, 12, 0.2), FALLBACK],
  [/gemini.*flash/i, rate(0.1, 0.4, 0.025), FALLBACK],
  [/gemini.*pro/i, rate(1.25, 5, 0.31), FALLBACK],
];

let tableKey: string | undefined;

/**
 * A fingerprint of this table and its billing constants. Dollars a ledger
 * keeps per request (the budget's, a session's price) were priced by the
 * table of the context-doctor that read them: under another table (an
 * upgrade that corrected a price, as 0.46 did Fable 5.2's) they are stale
 * and read again, not carried to the period's end.
 */
export function priceTableKey(): string {
  tableKey ??= createHash("sha1")
    .update(JSON.stringify([PRICING.map(([re, p, b]) => [re.source, re.flags, p, b ?? null]), CACHE_WRITE_5M, CACHE_WRITE_1H, CACHE_WRITE_OPENAI_30M, CACHE_WRITE_OPENAI_12H, US_ONLY_MULTIPLIER, WEB_SEARCH_USD]))
    .digest("hex")
    .slice(0, 12);
  return tableKey;
}

function row(model?: string): (typeof PRICING)[number] | undefined {
  if (!model) return undefined;
  return PRICING.find(([pattern]) => pattern.test(model));
}

/** A model's list row, as the page lists it today (no tier, mode or date applied). */
export function pricingFor(model?: string): ModelPricing | undefined {
  return row(model)?.[1];
}

/**
 * A model's price from a row for that model, not a family fallback: undefined
 * for an id the table only knows by family (a new release, a typo like
 * claude-opus-9, gpt-5-codex) and for one it does not know at all. What a
 * report needs to say which models it priced by guess or not at all.
 */
export function knownPricingFor(model?: string): ModelPricing | undefined {
  const r = row(model);
  return r && !r[2]?.fallback ? r[1] : undefined;
}

/** Whether a model id has a price of its own in the table (see knownPricingFor). */
export function hasKnownPrice(model?: string): boolean {
  return knownPricingFor(model) !== undefined;
}

/**
 * Ids that are never billed, so never "unpriced": Claude Code writes
 * `<synthetic>` on replies it makes itself (an error, an interruption)
 * without calling the API.
 */
export function isUnbilledModel(model?: string): boolean {
  return model === "<synthetic>";
}

/**
 * A Claude model's price from a row for its own version, not a family
 * fallback: what a command that caps spending needs (`ab --budget`). An id
 * the table only knows by family (a new release, a typo like
 * claude-opus-9) gets undefined.
 */
export function exactClaudePricingFor(model?: string): ModelPricing | undefined {
  return model && /claude/i.test(model) ? knownPricingFor(model) : undefined;
}

export function inputCostUsd(tokens: number, pricing: ModelPricing): number {
  return (tokens / 1_000_000) * pricing.inputPerM;
}

/** `usage` as the API returns it and Claude Code records it on each reply. */
export interface RecordedUsage {
  input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  output_tokens?: unknown;
  /**
   * The cache writes split by TTL; absent in older transcripts.
   * `ttl_12h_input_tokens` carries OpenAI's 12-hour writes (see openAIUsage).
   */
  cache_creation?: { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown; ttl_12h_input_tokens?: unknown } | null;
  /** Anthropic: "fast" for a fast-mode request ("standard" otherwise). */
  speed?: unknown;
  /** Anthropic: "us" for US-only inference ("global", "", "not_available" otherwise). */
  inference_geo?: unknown;
  /** Anthropic: server-side tool uses billed per use. */
  server_tool_use?: { web_search_requests?: unknown; web_fetch_requests?: unknown; code_execution_requests?: unknown } | null;
}

export interface UsageCost {
  /** Uncached input. */
  inputUsd: number;
  /** Cache writes, each TTL at its own price. */
  writeUsd: number;
  readUsd: number;
  outputUsd: number;
  /** input + writes + reads: what the prompt cost. */
  promptUsd: number;
  totalUsd: number;
}

/** A token count from recorded usage: numbers and numeric strings, anything else is 0. */
function count(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * A request's cache writes by TTL. Claude Code's main thread writes almost
 * everything at the 1-hour TTL (2x input) and subagents at 5 minutes
 * (1.25x), so a single 1.25x multiplier underpriced most writes by 37%.
 * Usage recorded without the split counts as 5-minute writes, the API's
 * default TTL.
 */
export function cacheWriteSplit(usage: RecordedUsage | undefined | null): { fiveMinute: number; oneHour: number; twelveHour: number } {
  const total = count(usage?.cache_creation_input_tokens);
  const split = usage?.cache_creation;
  if (!split || typeof split !== "object") return { fiveMinute: total, oneHour: 0, twelveHour: 0 };
  const all = total || count(split.ephemeral_5m_input_tokens) + count(split.ephemeral_1h_input_tokens) + count(split.ttl_12h_input_tokens);
  const oneHour = Math.min(all, count(split.ephemeral_1h_input_tokens));
  const twelveHour = Math.min(all - oneHour, count(split.ttl_12h_input_tokens));
  return { fiveMinute: all - oneHour - twelveHour, oneHour, twelveHour };
}

/**
 * The write price, relative to input, of a mix of 5-minute and 1-hour
 * writes. Simulations that charge a write that never happened (a cold
 * re-read, a compaction's fresh context) use the session's own mix, since
 * that is the TTL its harness would have written at; 1.25x when nothing was
 * written to learn from.
 */
export function writeMultiplier(fiveMinute: number, oneHour: number, twelveHour = 0): number {
  const total = fiveMinute + oneHour + twelveHour;
  return total > 0 ? (fiveMinute * CACHE_WRITE_5M + oneHour * CACHE_WRITE_1H + twelveHour * CACHE_WRITE_OPENAI_12H) / total : CACHE_WRITE_5M;
}

/**
 * Recorded usage at given rates: uncached input, cache writes priced by
 * TTL, cache reads, output. The rates a request was billed at (its tier,
 * fast mode, US-only, its date) are requestCost's to decide.
 */
export function usageCost(usage: RecordedUsage | undefined | null, pricing: ModelPricing): UsageCost {
  const { fiveMinute, oneHour, twelveHour } = cacheWriteSplit(usage);
  const perM = (tokens: number, usd: number) => (tokens * usd) / 1_000_000;
  const inputUsd = perM(count(usage?.input_tokens), pricing.inputPerM);
  const writeUsd = pricing.cacheWritePerM !== undefined
    ? perM(fiveMinute + oneHour + twelveHour, pricing.cacheWritePerM)
    : perM(fiveMinute * CACHE_WRITE_5M + oneHour * CACHE_WRITE_1H + twelveHour * CACHE_WRITE_OPENAI_12H, pricing.inputPerM);
  const readUsd = perM(count(usage?.cache_read_input_tokens), pricing.cacheReadPerM);
  const outputUsd = perM(count(usage?.output_tokens), pricing.outputPerM);
  const promptUsd = inputUsd + writeUsd + readUsd;
  return { inputUsd, writeUsd, readUsd, outputUsd, promptUsd, totalUsd: promptUsd + outputUsd };
}

/** US-only inference on Claude 4.6 and later: 1.1x on every token category (Anthropic, "Data residency pricing", read 2026-11-08). */
export const US_ONLY_MULTIPLIER = 1.1;
/**
 * Claude's web search tool: $10 per 1,000 searches, on top of its tokens
 * (Anthropic, "Web search tool", read 2026-11-08). A token price, so not
 * under the US-only multiplier. Web fetch has no charge beyond its tokens;
 * code execution bills container time (1,550 free hours a month, then $0.05
 * an hour), which usage does not record per request: not modelled.
 */
export const WEB_SEARCH_USD = 10 / 1000;

/** The tokens a request's prompt holds: uncached input, cache reads and cache writes (what a long-prompt tier counts). */
export function promptTokens(usage: RecordedUsage | undefined | null): number {
  return count(usage?.input_tokens) + count(usage?.cache_read_input_tokens) + count(usage?.cache_creation_input_tokens);
}

/** UTC midnight of a "YYYY-MM-DD" day. */
const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`);

const scaled = (p: ModelPricing, k: number): ModelPricing => (k === 1 ? p : { inputPerM: p.inputPerM * k, outputPerM: p.outputPerM * k, cacheReadPerM: p.cacheReadPerM * k, ...(p.cacheWritePerM !== undefined ? { cacheWritePerM: p.cacheWritePerM * k } : {}) });

/**
 * The rates a model's requests bill at, from its row and what the request
 * recorded: `rates` for a prompt up to `over` tokens, `longRates` beyond
 * (no tier: `over` absent). Fast mode replaces the rates (its price holds
 * across the full context window); US-only scales them. A request on or
 * after the day its row's price changes (`changedOn`) is priced at the
 * price the page said would follow, or the old one when it said none: an
 * estimate either way (a scheduled price can be called off: Sonnet 5's was).
 */
export interface RateCard {
  rates: ModelPricing;
  over?: number;
  longRates?: ModelPricing;
  /** The list row's own rates, before tier, fast mode and US-only: what the modifiers are measured from. */
  list: ModelPricing;
  /** Fast mode's rates applied. */
  fast?: true;
  /** US-only's 1.1x applied. */
  geo?: true;
  /** Priced by family or past its row's date: an estimate. */
  estimated?: true;
  /** "YYYY-MM-DD": the row's price changed on this day, before the request. */
  changedOn?: string;
  /** Web searches bill per use (Claude). */
  webSearch?: true;
  /**
   * Priced at the organization's rates (Claude Code's managed `modelPricing`,
   * orgrates.ts): its row for the model, or the list price times its
   * multiplier. Every figure on the card is already scaled by `scale`.
   */
  org?: true;
  /** The organization's multiplier, which also scales the web-search fee. */
  scale?: number;
}

/** The rate card for one of `model`'s requests at time `at`, with the modifiers its usage records. Undefined for a model with no price. */
export function rateCard(model: string | undefined, usage?: RecordedUsage | null, at = Date.now()): RateCard | undefined {
  const org = model ? orgRates() : undefined;
  const own = org && orgRowFor(org, model!);
  if (own) {
    // A contracted row is charged as written: no tier, fast mode, US-only or date; then the multiplier.
    const rates = scaled(own, org!.multiplier);
    return { rates, list: rates, org: true, ...(org!.multiplier !== 1 ? { scale: org!.multiplier } : {}), ...(/claude/i.test(model!) ? { webSearch: true as const } : {}) };
  }
  const r = row(model);
  if (!r) return undefined;
  const [, list, b = {}] = r;
  // A request with no time of its own (a row without a timestamp) is priced as of now, the default:
  // past a change that is the newer price, labelled an estimate with its day. NaN compared as never
  // expired, so such a row got an ended price unlabelled in some reports and today's in others.
  if (!Number.isFinite(at)) at = Date.now();
  const expired = b.changes !== undefined && at >= dayStart(b.changes);
  // Routed to another model: its card, so a later change of that model's price follows (and is the day said).
  const to = expired && b.routes ? rateCard(b.routes, usage, at) : undefined;
  if (to) return { ...to, estimated: true, changedOn: to.changedOn ?? b.changes };
  const base = expired && b.then ? b.then : list;
  const long = expired && b.then ? undefined : b.long;
  const fast = usage?.speed === "fast" && b.fast ? b.fast : undefined;
  const geo = usage?.inference_geo === "us" && b.geo ? US_ONLY_MULTIPLIER : 1;
  const card: RateCard = { rates: scaled(fast ?? base, geo), list: base };
  if (long && !fast) { card.over = long.over; card.longRates = scaled(long.rates, geo); }
  if (fast) card.fast = true;
  if (geo !== 1) card.geo = true;
  if (b.fallback || expired) card.estimated = true;
  if (expired) card.changedOn = b.changes;
  if (/claude/i.test(model!)) card.webSearch = true;
  if (org && orgApplies(org, model)) {
    const k = org.multiplier;
    card.rates = scaled(card.rates, k);
    card.list = scaled(card.list, k);
    if (card.longRates) card.longRates = scaled(card.longRates, k);
    card.org = true;
    card.scale = k;
  }
  return card;
}

/** A card's rates for a prompt of `prompt` tokens: its long tier's past `over`. */
export function ratesAt(card: RateCard, prompt: number): ModelPricing {
  return card.over !== undefined && prompt > card.over ? card.longRates! : card.rates;
}

/**
 * What a request's billing modifiers added to its list-row price, in USD:
 * fast mode, US-only inference, a long-prompt tier, and the web searches it
 * ran (`webSearches` of them, `webSearchUsd`).
 */
export interface Modifiers { fastUsd: number; geoUsd: number; longUsd: number; webSearchUsd: number; webSearches: number }

export const NO_MODIFIERS: Readonly<Modifiers> = Object.freeze({ fastUsd: 0, geoUsd: 0, longUsd: 0, webSearchUsd: 0, webSearches: 0 });

export interface RequestCost extends UsageCost {
  /** The rates its tokens were billed at (the parts above); `totalUsd` adds the web searches. */
  rates: ModelPricing;
  modifiers: Modifiers;
  /** Priced by family, or past the day its row's price changed: an estimate. */
  estimated?: true;
  /** "YYYY-MM-DD": its row's price changed on this day, before the request. */
  changedOn?: string;
  /** Priced at the organization's rates (RateCard.org). */
  org?: true;
}

/**
 * What one recorded request cost, as billed: its model's row at the time it
 * ran, its prompt's tier, fast mode, US-only inference, cache writes by TTL,
 * and per-use tool fees. The one place a request's price is decided, so
 * every report agrees with the others and with the bill. `at`: when it ran.
 * Undefined for a model with no price.
 */
export function requestCost(model: string | undefined, usage: RecordedUsage | undefined | null, at = Date.now()): RequestCost | undefined {
  const card = rateCard(model, usage, at);
  if (!card) return undefined;
  const prompt = promptTokens(usage);
  const rates = ratesAt(card, prompt);
  const c = usageCost(usage, rates);
  const searches = card.webSearch ? count(usage?.server_tool_use?.web_search_requests) : 0;
  const m: Modifiers = { ...NO_MODIFIERS, webSearches: searches, webSearchUsd: searches * WEB_SEARCH_USD * (card.scale ?? 1) };
  if (card.fast || card.geo || rates !== card.rates || card.over !== undefined) {
    // Each modifier measured from the step before it: list row, its tier, fast mode, US-only.
    const geo = card.geo ? US_ONLY_MULTIPLIER : 1;
    const preGeo = c.totalUsd / geo;
    const list = usageCost(usage, card.list).totalUsd;
    const tiered = card.longRates && prompt > card.over! ? usageCost(usage, scaled(card.longRates, 1 / geo)).totalUsd : list;
    m.longUsd = tiered - list;
    m.fastUsd = card.fast ? preGeo - tiered : 0;
    m.geoUsd = c.totalUsd - preGeo;
  }
  return { ...c, totalUsd: c.totalUsd + m.webSearchUsd, rates, modifiers: m, ...(card.estimated ? { estimated: true } : {}), ...(card.changedOn ? { changedOn: card.changedOn } : {}), ...(card.org ? { org: true as const } : {}) };
}

/** `a` plus `b`, part by part. */
export function addModifiers(a: Modifiers, b: Readonly<Modifiers>): Modifiers {
  a.fastUsd += b.fastUsd; a.geoUsd += b.geoUsd; a.longUsd += b.longUsd; a.webSearchUsd += b.webSearchUsd; a.webSearches += b.webSearches;
  return a;
}

/**
 * When a model's price in the table stops being its list price: the day
 * (YYYY-MM-DD) and, when the page said, the price from then. Undefined for
 * a row with no end date. What `doctor` and the budget say once it has passed.
 */
export function priceChange(model?: string): { on: string; then?: ModelPricing } | undefined {
  const b = row(model)?.[2];
  return b?.changes ? { on: b.changes, ...(b.then ? { then: b.then } : {}) } : undefined;
}

/** "gemini-4-argon's price changed on 2026-12-01; a newer context-doctor knows the new one": said for each model priced past its row's date. */
export function priceChangedText(models: Array<[model: string, on: string]>): string {
  const byDay = new Map<string, string[]>();
  for (const [m, on] of models) { const l = byDay.get(on) ?? byDay.set(on, []).get(on)!; if (!l.includes(m)) l.push(m); }
  return [...byDay].map(([on, ms]) => `${ms.slice(0, 3).join(", ")}${ms.length > 3 ? " and others" : ""}: price changed on ${on}`).join("; ") + "; a newer context-doctor knows the new one";
}

/**
 * OpenAI usage, in any of its shapes, as RecordedUsage: Responses
 * (`input_tokens`, `input_tokens_details.cached_tokens`, `cache_write_tokens`
 * and its `cache_write_tokens_details.ttl_30m_tokens` / `ttl_12h_tokens`),
 * Chat Completions (`prompt_tokens`, `prompt_tokens_details`,
 * `completion_tokens`) and Codex rollouts (`cached_input_tokens`,
 * `cache_write_input_tokens`). OpenAI's input count holds every input token
 * once, each billed at the uncached, cached or write rate, so the uncached
 * part is what is left after reads AND writes. Writes without a split are
 * 30-minute writes, the default lifetime: Codex rollouts record only the
 * total, so a Codex 12-hour write would be priced at half its 2.5x.
 */
export function openAIUsage(raw: Record<string, any> | undefined | null): RecordedUsage {
  const u = raw ?? {};
  const details = u.input_tokens_details ?? u.prompt_tokens_details ?? {};
  const input = count(u.input_tokens ?? u.prompt_tokens);
  const cached = count(details.cached_tokens ?? u.cached_input_tokens);
  const writes = count(details.cache_write_tokens ?? u.cache_write_input_tokens);
  const split = details.cache_write_tokens_details ?? {};
  const twelveHour = Math.min(writes, count(split.ttl_12h_tokens));
  return {
    input_tokens: Math.max(0, input - cached - writes),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: writes,
    cache_creation: { ephemeral_5m_input_tokens: writes - twelveHour, ephemeral_1h_input_tokens: 0, ttl_12h_input_tokens: twelveHour },
    output_tokens: count(u.output_tokens ?? u.completion_tokens),
  };
}

/**
 * Rough time-to-first-token impact of input size. Prompt processing on major
 * providers runs on the order of tens of thousands of tokens per second;
 * ~25k tok/s is a serviceable cross-provider planning number, so every 10k
 * input tokens costs roughly 0.4s of TTFT (much less on cache hits).
 */
export function estimatedTtftSeconds(inputTokens: number): number {
  return inputTokens / 25_000;
}

export function formatUsd(amount: number): string {
  // Same reasoning as formatTokens: "$NaN" is worse than "$0.00".
  if (!Number.isFinite(amount)) return "$0.00";
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(4)}`;
}
