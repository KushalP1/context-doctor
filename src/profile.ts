/**
 * The profiler: turns a normalized conversation into a breakdown of where
 * tokens go, plus a list of actionable findings ("what's eating my window").
 */

import { createHash } from "node:crypto";
import { NormalizedConversation, NormalizedMessage } from "./parse.js";
import { contextWindowFor, estimateTokens, MESSAGE_OVERHEAD_TOKENS, providerFor } from "./tokens.js";
import { estimatedTtftSeconds, inputCostUsd, pricingFor } from "./pricing.js";

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
  | "repeated_tool_call"
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

function preview(text: string, len = 90): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > len ? clean.slice(0, len) + "…" : clean;
}

function contentHash(text: string): string {
  return createHash("sha1").update(text.replace(/\s+/g, " ").trim()).digest("hex");
}

const BASE64_RE = /(?:data:[\w/+.-]+;base64,|[A-Za-z0-9+/]{500,}={0,2})/;

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

  // -- Base64 / binary blobs ---------------------------------------------------
  for (const p of perMessage) {
    if (BASE64_RE.test(p.msg.text)) {
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

  const totalEstSavings = findings.reduce((s, f) => s + f.estSavings, 0);
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
  };
}
