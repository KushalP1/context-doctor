/**
 * The profiler: turns a normalized conversation into a breakdown of where
 * tokens go, plus a list of actionable findings ("what's eating my window").
 */

import { createHash } from "node:crypto";
import { NormalizedConversation, NormalizedMessage } from "./parse.js";
import { contextWindowFor, estimateTokens, MESSAGE_OVERHEAD_TOKENS, providerFor } from "./tokens.js";
import { estimatedTtftSeconds, inputCostUsd, pricingFor } from "./pricing.js";
import { hasBase64Blob } from "./blob.js";

export type Category = "system" | "user" | "assistant" | "tool_calls" | "tool_results" | "other";

export interface MessageProfile {
  index: number;
  role: string;
  kind: string;
  tokens: number;
  preview: string;
  toolName?: string;
}

export type FindingId =
  | "large_tool_result"
  | "duplicate_content"
  | "near_duplicate"
  | "repeated_tool_call"
  | "repeated_file_read"
  | "retained_error_output"
  | "base64_blob"
  | "long_history"
  | "large_system_prompt"
  | "cache_ordering"
  | "near_window_limit";

export interface Finding {
  id: FindingId;
  severity: "info" | "warn" | "high";
  /** Estimated tokens recoverable by acting on this finding (0 = advisory). */
  estSavings: number;
  message: string;
  suggestion: string;
  /** Message indexes involved. */
  messages: number[];
}

export interface CostEstimate {
  /** Input cost of sending this context once, USD (estimate). */
  perCallUsd: number;
  /** Input cost over 1,000 calls — the number that makes people act. */
  per1kCallsUsd: number;
  /** USD recoverable per call if all savings findings are applied. */
  savingsPerCallUsd: number;
  /** Same, over 1,000 calls. */
  savingsPer1kCallsUsd: number;
  /** Estimated seconds of time-to-first-token attributable to this input size. */
  ttftSeconds: number;
  /** TTFT seconds saved per call if savings are applied. */
  ttftSavedSeconds: number;
}

export interface ContextProfile {
  totalTokens: number;
  model?: string;
  contextWindow?: number;
  usagePct?: number;
  messageCount: number;
  categories: Record<Category, number>;
  largestMessages: MessageProfile[];
  findings: Finding[];
  /** Total estimated savings if all findings with savings are acted on. */
  totalEstSavings: number;
  /** Present when the model has a known price. All figures are estimates. */
  cost?: CostEstimate;
  sourceFormat: string;
  /** Propagated from parsing: input could not be read as a conversation. */
  parseWarning?: string;
}

function categoryOf(m: NormalizedMessage): Category {
  switch (m.kind) {
    case "system": return "system";
    case "user": return "user";
    case "assistant": return "assistant";
    case "tool_call": return "tool_calls";
    case "tool_result": return "tool_results";
    default: return "other";
  }
}

/**
 * Total recoverable tokens, counted as a UNION rather than a sum.
 *
 * Findings legitimately overlap: an oversized tool result can also be a
 * near-duplicate, and a long history contains both. Adding their estimates
 * would promise savings the same tokens can only deliver once. Each
 * message-scoped finding is attributed to the message that would actually be
 * removed (the LAST index — for a duplicate pair, the later copy), keeping the
 * largest claim per message; whole-conversation findings then take only what
 * is left unclaimed. The result is capped below the total, since no
 * optimization reclaims an entire context.
 */
function unionSavings(findings: Finding[], totalTokens: number): number {
  const perMessage = new Map<number, number>();
  let unscoped = 0;

  for (const f of findings) {
    if (f.estSavings <= 0) continue;
    if (f.messages.length === 0) {
      unscoped += f.estSavings;
      continue;
    }
    const target = f.messages[f.messages.length - 1];
    perMessage.set(target, Math.max(perMessage.get(target) ?? 0, f.estSavings));
  }

  const scoped = [...perMessage.values()].reduce((a, b) => a + b, 0);
  // Whole-conversation findings can only claim tokens no message-scoped
  // finding already claimed.
  const headroom = Math.max(0, totalTokens - scoped);
  const total = scoped + Math.min(unscoped, headroom);
  // A context can never be optimized away entirely; 90% is the ceiling any
  // strategy set could plausibly reach.
  return Math.min(total, Math.round(totalTokens * 0.9));
}

function preview(text: string, len = 90): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > len ? clean.slice(0, len) + "…" : clean;
}

function contentHash(text: string): string {
  return createHash("sha1").update(text.replace(/\s+/g, " ").trim()).digest("hex");
}


/** FNV-1a — cheap deterministic hash for shingle sampling. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Sampled 8-word shingle set for near-duplicate detection. Keeping only
 * ~1/8th of shingles (by hash) shrinks sets ~8x while preserving the Jaccard
 * estimate — pairwise comparison stays cheap even on large sessions.
 */
function sampledShingles(text: string): Set<number> {
  const words = text.toLowerCase().replace(/\s+/g, " ").trim().split(" ");
  // Sampling is a large-text optimization only: short texts keep every
  // shingle (sampling them starves the Jaccard estimate), long ones keep ~1/8.
  const sample = words.length > 1500;
  const out = new Set<number>();
  for (let i = 0; i + 8 <= words.length; i++) {
    const h = fnv1a(words.slice(i, i + 8).join(" "));
    if (!sample || h % 8 === 0) out.add(h);
  }
  return out;
}

/** Similarity at or above which two messages count as near-duplicates. */
const SIMILARITY_THRESHOLD = 0.6;

function jaccard(a: Set<number>, b: Set<number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const v of small) if (large.has(v)) inter++;
  return inter / (a.size + b.size - inter);
}

export function profileConversation(conv: NormalizedConversation, model?: string): ContextProfile {
  const perMessage = conv.messages.map((m) => ({
    msg: m,
    tokens: estimateTokens(m.text) + MESSAGE_OVERHEAD_TOKENS,
  }));

  const totalTokens = perMessage.reduce((sum, p) => sum + p.tokens, 0);
  const categories: Record<Category, number> = {
    system: 0, user: 0, assistant: 0, tool_calls: 0, tool_results: 0, other: 0,
  };
  for (const p of perMessage) categories[categoryOf(p.msg)] += p.tokens;

  const findings: Finding[] = [];

  // -- Large individual tool results ------------------------------------------
  for (const p of perMessage) {
    if (p.msg.kind === "tool_result" && p.tokens > 2000) {
      findings.push({
        id: "large_tool_result",
        severity: p.tokens > 8000 ? "high" : "warn",
        estSavings: Math.round(p.tokens * 0.8),
        message: `Tool result at message #${p.msg.index}${p.msg.toolName ? ` (${p.msg.toolName})` : ""} is ~${p.tokens} tokens.`,
        suggestion: "Truncate or summarize large tool outputs before they enter history; keep only the fields the model actually used.",
        messages: [p.msg.index],
      });
    }
  }

  // -- Exact duplicate content ------------------------------------------------
  const seen = new Map<string, number>();
  for (const p of perMessage) {
    if (p.msg.text.length < 300) continue; // small repeats are cheap
    const h = contentHash(p.msg.text);
    const first = seen.get(h);
    if (first !== undefined) {
      findings.push({
        id: "duplicate_content",
        severity: "warn",
        estSavings: p.tokens - MESSAGE_OVERHEAD_TOKENS,
        message: `Message #${p.msg.index} duplicates the content of message #${first} (~${p.tokens} tokens).`,
        suggestion: "Replace repeated content with a short reference to the first occurrence.",
        messages: [first, p.msg.index],
      });
    } else {
      seen.set(h, p.msg.index);
    }
  }

  // -- Near-duplicates: same content wrapped in different lead-ins -------------
  // Exact hashing (above) misses "here's the doc again: <doc>"; sampled-shingle
  // Jaccard catches it. Capped to the 150 largest 300+-char messages.
  {
    const candidates = perMessage
      .filter((p) => p.msg.text.length >= 300)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 150);
    const shingleSets = candidates.map((p) => sampledShingles(p.msg.text));
    // Jaccard has a hard ceiling of |smaller| / |larger|: two shingle sets of
    // very different sizes CANNOT reach the threshold, so those pairs are
    // skipped without intersecting them. Exact, not heuristic — it changes
    // runtime, never results.
    const sizes = shingleSets.map((set) => set.size);
    const exactDup = new Set(
      findings.filter((f) => f.id === "duplicate_content").flatMap((f) => f.messages)
    );
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i];
        const b = candidates[j];
        if (exactDup.has(a.msg.index) && exactDup.has(b.msg.index)) continue; // already flagged exactly
        const small = Math.min(sizes[i], sizes[j]);
        const large = Math.max(sizes[i], sizes[j]);
        if (large === 0 || small / large < SIMILARITY_THRESHOLD) continue; // cannot clear the bar
        const sim = jaccard(shingleSets[i], shingleSets[j]);
        if (sim >= SIMILARITY_THRESHOLD) {
          const smaller = Math.min(a.tokens, b.tokens);
          const [first, second] = a.msg.index <= b.msg.index ? [a, b] : [b, a];
          findings.push({
            id: "near_duplicate",
            severity: "warn",
            estSavings: Math.round(smaller * sim * 0.9),
            message: `Messages #${first.msg.index} and #${second.msg.index} are ~${Math.round(sim * 100)}% similar (~${smaller} tokens repeated with different framing).`,
            suggestion: "Replace the later copy with a short reference to the first — repeats survive even when the surrounding words differ.",
            messages: [first.msg.index, second.msg.index],
          });
        }
      }
    }
  }

  // -- Repeated identical tool calls ------------------------------------------
  const callSeen = new Map<string, number[]>();
  for (const p of perMessage) {
    if (p.msg.kind !== "tool_call" || !p.msg.toolCallText) continue;
    const key = contentHash(p.msg.toolCallText);
    const list = callSeen.get(key) ?? [];
    list.push(p.msg.index);
    callSeen.set(key, list);
  }
  for (const [, idxs] of callSeen) {
    if (idxs.length > 1) {
      findings.push({
        id: "repeated_tool_call",
        severity: "info",
        estSavings: 0,
        message: `The same tool call (with identical arguments) appears ${idxs.length} times (messages #${idxs.join(", #")}).`,
        suggestion: "Repeated identical calls usually mean the earlier result scrolled out of the model's attention — cache results or surface them in a compact recap instead of re-calling.",
        messages: idxs,
      });
    }
  }

  // -- Same file read again and again -----------------------------------------
  // The dominant waste in agent loops: a file re-read because its earlier
  // contents scrolled out of attention, leaving several full copies in context.
  {
    const readsByPath = new Map<string, number[]>();
    for (const p of perMessage) {
      if (p.msg.kind !== "tool_call" || !p.msg.toolCallText) continue;
      if (!/read|open|cat|view|get_file/i.test(p.msg.toolName ?? "")) continue;
      const match = /"(?:file_path|filePath|path|file)"\s*:\s*"([^"]{3,})"/.exec(p.msg.toolCallText);
      if (!match) continue;
      const path = match[1];
      readsByPath.set(path, [...(readsByPath.get(path) ?? []), p.msg.index]);
    }
    for (const [path, indexes] of readsByPath) {
      if (indexes.length < 3) continue;
      // Each re-read pulls the file in again; all but the last are recoverable.
      const resultTokens = perMessage
        .filter((p) => p.msg.kind === "tool_result" && indexes.some((i) => p.msg.index === i + 1))
        .reduce((sum, p) => sum + p.tokens, 0);
      const savings = Math.round((resultTokens * (indexes.length - 1)) / indexes.length);
      findings.push({
        id: "repeated_file_read",
        severity: savings > 4000 ? "high" : "warn",
        estSavings: savings,
        message: `${path.split("/").pop()} was read ${indexes.length} times (messages #${indexes.join(", #")}), keeping ${indexes.length} copies in context.`,
        suggestion: "Re-read a file only after it changes; otherwise refer back to the copy already in context.",
        messages: indexes,
      });
    }
  }

  // -- Failed tool output kept verbatim ---------------------------------------
  // Stack traces and command failures are read once and never again, yet they
  // are often the largest blocks in an agent transcript.
  for (const p of perMessage) {
    if (p.msg.kind !== "tool_result" || p.tokens < 500) continue;
    const looksFailed =
      /Traceback \(most recent call last\)|command not found|npm error|ERR!|\bexit code [1-9]|Exception in thread|FAILED|error TS\d+/i.test(
        p.msg.text
      );
    if (!looksFailed) continue;
    findings.push({
      id: "retained_error_output",
      severity: "warn",
      estSavings: Math.round(p.tokens * 0.85),
      message: `Message #${p.msg.index} holds ~${p.tokens} tokens of failed tool output (errors, stack trace or non-zero exit).`,
      suggestion: "Keep the one line that identifies the failure and drop the rest — a full trace has no value once the fix is understood.",
      messages: [p.msg.index],
    });
  }

  // -- Base64 / binary blobs ---------------------------------------------------
  for (const p of perMessage) {
    if (hasBase64Blob(p.msg.text)) {
      findings.push({
        id: "base64_blob",
        severity: "high",
        estSavings: Math.round(p.tokens * 0.9),
        message: `Message #${p.msg.index} contains a base64/binary blob (~${p.tokens} tokens of mostly meaningless characters).`,
        suggestion: "Never put base64 in text content — use the provider's file/image APIs or replace with a file reference.",
        messages: [p.msg.index],
      });
    }
  }

  // -- Long history ------------------------------------------------------------
  const turnCount = conv.messages.filter((m) => m.kind === "user" || m.kind === "assistant").length;
  if (turnCount > 40) {
    const olderHalf = perMessage.slice(0, Math.floor(perMessage.length / 2));
    const olderTokens = olderHalf.reduce((s, p) => s + p.tokens, 0);
    findings.push({
      id: "long_history",
      severity: "warn",
      estSavings: Math.round(olderTokens * 0.7),
      message: `Conversation has ${turnCount} turns; the older half holds ~${olderTokens} tokens.`,
      suggestion: "Summarize the older half of the conversation into a compact recap and drop the raw turns (context-doctor optimize --strategy prune-history).",
      messages: [],
    });
  }

  // -- System prompt share -----------------------------------------------------
  if (totalTokens > 0 && categories.system / totalTokens > 0.25 && categories.system > 2000) {
    findings.push({
      id: "large_system_prompt",
      severity: "info",
      estSavings: 0,
      message: `System prompt is ~${categories.system} tokens (${Math.round((categories.system / totalTokens) * 100)}% of the context).`,
      suggestion: "A big system prompt is fine IF it is stable — put it first and use prompt caching (Anthropic: cache_control; OpenAI: automatic prefix caching) so you stop paying full price for it every call.",
      messages: [],
    });
  }

  // -- Cache-friendly ordering (advisory) --------------------------------------
  if (providerFor(model) === "anthropic" || providerFor(model) === "openai") {
    findings.push({
      id: "cache_ordering",
      severity: "info",
      estSavings: 0,
      message: "Prompt caching only matches a byte-identical prefix.",
      suggestion: "Keep stable content (system prompt, tool definitions, reference docs) at the start and never interleave it with per-request content — a single changed byte early in the prompt invalidates the cache for everything after it.",
      messages: [],
    });
  }

  // -- Window pressure ---------------------------------------------------------
  const window = contextWindowFor(model);
  const usagePct = window ? (totalTokens / window) * 100 : undefined;
  if (usagePct !== undefined && usagePct > 70) {
    findings.push({
      id: "near_window_limit",
      severity: usagePct > 90 ? "high" : "warn",
      estSavings: 0,
      message: `Context is at ~${usagePct.toFixed(0)}% of ${model}'s window.`,
      suggestion: "Models degrade well before the hard limit (lost-in-the-middle). Compact now rather than when the request fails.",
      messages: [],
    });
  }

  const largestMessages = perMessage
    .map((p) => ({
      index: p.msg.index,
      role: p.msg.role,
      kind: p.msg.kind,
      tokens: p.tokens,
      preview: preview(p.msg.text),
      toolName: p.msg.toolName,
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);

  const severityRank = { high: 0, warn: 1, info: 2 };
  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.estSavings - a.estSavings);

  const totalEstSavings = unionSavings(findings, totalTokens);
  const pricing = pricingFor(model);
  let cost: CostEstimate | undefined;
  if (pricing) {
    const perCallUsd = inputCostUsd(totalTokens, pricing);
    const savingsPerCallUsd = inputCostUsd(totalEstSavings, pricing);
    cost = {
      perCallUsd,
      per1kCallsUsd: perCallUsd * 1000,
      savingsPerCallUsd,
      savingsPer1kCallsUsd: savingsPerCallUsd * 1000,
      ttftSeconds: estimatedTtftSeconds(totalTokens),
      ttftSavedSeconds: estimatedTtftSeconds(totalEstSavings),
    };
  }

  return {
    totalTokens,
    model,
    contextWindow: window,
    usagePct,
    messageCount: conv.messages.length,
    categories,
    largestMessages,
    findings,
    totalEstSavings,
    cost,
    sourceFormat: conv.sourceFormat,
    parseWarning: conv.parseWarning,
  };
}
