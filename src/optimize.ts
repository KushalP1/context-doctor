/**
 * The optimizer: deterministic, lossless-first strategies that rewrite a
 * conversation's message array to reclaim tokens. No LLM calls — everything
 * here is safe to run offline and inspect before use.
 *
 * Strategies operate on the ORIGINAL JSON structure (not the normalized view)
 * so the output is a drop-in replacement for the input conversation.
 */

import { createHash } from "node:crypto";
import { estimateTokens } from "./tokens.js";

export type StrategyId = "dedupe" | "trim-tool-results" | "prune-history" | "strip-base64";

export interface OptimizeOptions {
  strategies?: StrategyId[];
  /** Tool results older than this many messages from the end get trimmed. */
  keepRecent?: number;
  /** Max tokens a trimmed tool result keeps. */
  maxToolResultTokens?: number;
}

export interface AppliedChange {
  strategy: StrategyId;
  messageIndex: number;
  tokensSaved: number;
  note: string;
}

export interface OptimizeResult {
  /** The rewritten conversation, same shape as the input. */
  conversation: unknown;
  tokensBefore: number;
  tokensAfter: number;
  applied: AppliedChange[];
  /**
   * When prune-history ran: a compact digest of the pruned turns. A host LLM
   * (e.g. the model running in Claude Desktop via MCP) can summarize this and
   * replace the stub message — summarization without any API key.
   */
  prunedDigest?: string;
}

const DEFAULTS: Required<OptimizeOptions> = {
  strategies: ["dedupe", "trim-tool-results", "strip-base64"],
  keepRecent: 6,
  maxToolResultTokens: 300,
};

const BASE64_RE = /(?:data:[\w/+.-]+;base64,)?[A-Za-z0-9+/]{500,}={0,2}/g;

function hash(text: string): string {
  return createHash("sha1").update(text.replace(/\s+/g, " ").trim()).digest("hex");
}

/** Extract all text from a message content value (string or block array). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content
    .map((b: any) => {
      if (typeof b === "string") return b;
      if (b?.type === "text") return b.text ?? "";
      if (b?.type === "tool_result") return textOf(b.content);
      if (b?.type === "tool_use") return JSON.stringify(b.input ?? {});
      return "";
    })
    .join("\n");
}

/**
 * Replace the text of a message content value, preserving block structure.
 * tool_result blocks must keep their type and tool_use_id — the Anthropic API
 * rejects conversations where a tool_use has no matching tool_result — so the
 * replacement text goes INSIDE the first tool_result/text block rather than
 * replacing the block itself. Later text blocks are dropped; other block types
 * (tool_use, image) pass through untouched.
 */
function replaceText(content: unknown, newText: string): unknown {
  if (typeof content === "string" || !Array.isArray(content)) return newText;
  let placed = false;
  const out = content
    .map((b: any) => {
      if (b?.type === "tool_result") {
        const replaced = { ...b, content: placed ? "[removed]" : newText };
        placed = true;
        return replaced;
      }
      if (b?.type === "text") {
        if (placed) return null;
        placed = true;
        return { ...b, text: newText };
      }
      return b;
    })
    .filter(Boolean);
  if (!placed) out.push({ type: "text", text: newText });
  return out;
}

function truncateToTokens(text: string, maxTokens: number): string {
  const approxChars = maxTokens * 4;
  if (text.length <= approxChars) return text;
  const head = text.slice(0, approxChars);
  const omitted = text.length - approxChars;
  return `${head}\n…[context-doctor: trimmed ${omitted} chars of stale tool output]`;
}

function isToolResultMessage(m: any): boolean {
  if (m?.role === "tool") return true;
  if (Array.isArray(m?.content)) return m.content.some((b: any) => b?.type === "tool_result");
  return false;
}

export function optimizeConversation(input: string, options: OptimizeOptions = {}): OptimizeResult {
  // ?? per field (not object spread) so an explicit `undefined` from a caller
  // still falls back to the default.
  const opts: Required<OptimizeOptions> = {
    strategies: options.strategies ?? DEFAULTS.strategies,
    keepRecent: options.keepRecent ?? DEFAULTS.keepRecent,
    maxToolResultTokens: options.maxToolResultTokens ?? DEFAULTS.maxToolResultTokens,
  };
  let data: any;
  try {
    data = JSON.parse(input);
  } catch {
    throw new Error("optimize requires a JSON conversation (message array, or object with a `messages` field)");
  }

  const messages: any[] = Array.isArray(data) ? data : data.messages;
  if (!Array.isArray(messages)) {
    throw new Error("No `messages` array found in input");
  }

  const tokensBefore = messages.reduce((s, m) => s + estimateTokens(textOf(m.content)), 0);
  const applied: AppliedChange[] = [];

  // -- strip-base64: replace inline blobs with a placeholder --------------------
  if (opts.strategies.includes("strip-base64")) {
    messages.forEach((m, i) => {
      const text = textOf(m.content);
      if (!BASE64_RE.test(text)) return;
      BASE64_RE.lastIndex = 0;
      const before = estimateTokens(text);
      const cleaned = text.replace(BASE64_RE, "[context-doctor: base64 blob removed — use file/image APIs instead]");
      const saved = before - estimateTokens(cleaned);
      if (saved > 50) {
        m.content = replaceText(m.content, cleaned);
        applied.push({ strategy: "strip-base64", messageIndex: i, tokensSaved: saved, note: "Removed inline base64 data" });
      }
    });
  }

  // -- dedupe: identical content beyond the first occurrence --------------------
  if (opts.strategies.includes("dedupe")) {
    const seen = new Map<string, number>();
    messages.forEach((m, i) => {
      const text = textOf(m.content);
      if (text.length < 300) return;
      const h = hash(text);
      const first = seen.get(h);
      if (first === undefined) {
        seen.set(h, i);
        return;
      }
      const saved = estimateTokens(text);
      m.content = replaceText(m.content, `[context-doctor: identical to message #${first} — content removed]`);
      applied.push({ strategy: "dedupe", messageIndex: i, tokensSaved: saved, note: `Duplicate of message #${first}` });
    });
  }

  // -- trim-tool-results: shrink stale tool output ------------------------------
  if (opts.strategies.includes("trim-tool-results")) {
    const cutoff = messages.length - opts.keepRecent;
    messages.forEach((m, i) => {
      if (i >= cutoff || !isToolResultMessage(m)) return;
      const text = textOf(m.content);
      const before = estimateTokens(text);
      if (before <= opts.maxToolResultTokens) return;
      const trimmed = truncateToTokens(text, opts.maxToolResultTokens);
      m.content = replaceText(m.content, trimmed);
      applied.push({
        strategy: "trim-tool-results",
        messageIndex: i,
        tokensSaved: before - estimateTokens(trimmed),
        note: "Stale tool result truncated",
      });
    });
  }

  // -- prune-history: replace the older half with a stub ------------------------
  // Opt-in only: it is lossy, so it is not in the default strategy set.
  let prunedDigest: string | undefined;
  if (opts.strategies.includes("prune-history") && messages.length > opts.keepRecent * 2) {
    const keepFrom = messages.length - opts.keepRecent;
    const pruned = messages.slice(0, keepFrom);
    const prunedTokens = pruned.reduce((s, m) => s + estimateTokens(textOf(m.content)), 0);
    // Digest: first ~200 chars of each pruned turn — enough for a host LLM to
    // write a faithful summary, small enough not to defeat the pruning.
    prunedDigest = pruned
      .map((m, i) => `[${i}:${m.role}] ${textOf(m.content).replace(/\s+/g, " ").slice(0, 200)}`)
      .join("\n");
    const stub = {
      role: "user",
      content:
        `[context-doctor: ${pruned.length} earlier messages (~${prunedTokens} tokens) pruned. ` +
        `Replace this stub with an LLM-written summary of those turns for best results.]`,
    };
    messages.splice(0, keepFrom, stub);
    applied.push({
      strategy: "prune-history",
      messageIndex: 0,
      tokensSaved: prunedTokens - estimateTokens(stub.content),
      note: `Pruned ${pruned.length} old messages`,
    });
  }

  const tokensAfter = messages.reduce((s, m) => s + estimateTokens(textOf(m.content)), 0);
  return { conversation: data, tokensBefore, tokensAfter, applied, prunedDigest };
}
