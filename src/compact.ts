/**
 * Compact tool results: a short text, the detail as `structuredContent`, and
 * presentation-only data in `_meta`.
 *
 * Why: every byte of a tool result is re-read on every later turn of the chat.
 * profile_context's full report (bars, message previews) and pack_context's
 * outline (one line per chunk, the heading path repeated on each) are mostly
 * presentation. ChatGPT surfaces `content` and `structuredContent` to the
 * model and keeps `_meta` for the widget only (developers.openai.com/plugins/reference,
 * "Tool results"), so the compact form puts one line of text and
 * the decision-relevant fields in front of the model, and the rest where only
 * a widget would read it.
 *
 * Not the default: a client that ignores `structuredContent` would lose the
 * detail. The server sends this form to ChatGPT (recognised by the
 * `openai/session` or `openai/subject` request metadata, the anonymized
 * conversation and user ids it attaches to tool calls) or when
 * CONTEXT_DOCTOR_RESULTS=compact; everything else gets the full text, as
 * before. Measured sizes are in ROADMAP.md ("Desktop chat apps").
 */

import type { ContextProfile } from "./profile.js";
import type { SketchProfile } from "./sketch.js";
import type { PackResult } from "./pack.js";
import { formatTokens } from "./tokens.js";

export type ResultMode = "full" | "compact";

export interface CompactResult {
  text: string;
  structured: Record<string, unknown>;
  meta: Record<string, unknown>;
}

/**
 * Which form a tool call gets. `requestMeta` is the request's `_meta`.
 * ChatGPT's identification keys mark ChatGPT itself, the client documented to
 * show structuredContent to the model; any `openai/*` key would also catch
 * other OpenAI clients (locale, user agent) that may not. An explicit
 * CONTEXT_DOCTOR_RESULTS (full or compact) wins.
 */
const CHATGPT_KEYS = ["openai/session", "openai/subject"];
export function resultMode(requestMeta: unknown, env: NodeJS.ProcessEnv = process.env): ResultMode {
  const forced = env.CONTEXT_DOCTOR_RESULTS?.trim().toLowerCase();
  if (forced === "full" || forced === "compact") return forced;
  if (requestMeta && typeof requestMeta === "object" && CHATGPT_KEYS.some((k) => typeof (requestMeta as Record<string, unknown>)[k] === "string")) return "compact";
  return "full";
}

const round = (n: number) => Math.round(n);

/** profile_context on a conversation. */
export function compactProfile(p: ContextProfile, fullText: string): CompactResult {
  const top = p.findings[0];
  const pct = p.totalTokens > 0 ? Math.round((p.totalEstSavings / p.totalTokens) * 100) : 0;
  const lines = [
    `~${formatTokens(p.totalTokens)} tokens in ${p.messageCount} messages (${p.sourceFormat})${p.usagePct !== undefined ? `, ${p.usagePct.toFixed(0)}% of the window` : ""}; ~${formatTokens(p.totalEstSavings)} recoverable (${pct}%).`,
  ];
  if (p.parseWarning) lines.unshift(`⚠ ${p.parseWarning}`);
  lines.push(top ? `Act on #1 (first in structuredContent.findings).` : "No findings.");
  const categories = Object.fromEntries(Object.entries(p.categories).filter(([, t]) => t > 0).sort((a, b) => b[1] - a[1]).map(([k, t]) => [k, round(t)]));
  const structured: Record<string, unknown> = {
    total_tokens: round(p.totalTokens),
    messages: p.messageCount,
    recoverable_tokens: round(p.totalEstSavings),
    by_category: categories,
    // One string per finding: JSON keys repeated per object cost more than they say.
    findings: p.findings.slice(0, 6).map((f) => `${f.severity}${f.estSavings > 0 ? ` ~${formatTokens(f.estSavings)}` : ""}: ${f.message} → ${f.suggestion}`),
  };
  if (p.findings.length > 6) structured.more_findings = p.findings.length - 6;
  if (p.model) structured.model = p.model;
  if (p.usagePct !== undefined) structured.window_pct = Number(p.usagePct.toFixed(1));
  if (p.cost) structured.usd_per_call = Number(p.cost.perCallUsd.toFixed(4));
  return {
    text: lines.join("\n"),
    structured,
    // The bar chart and message previews: presentation, and raw conversation
    // text the model already has. A widget can show them; the model need not.
    meta: { "context-doctor/report": fullText, "context-doctor/largest": p.largestMessages.map((m) => ({ index: m.index, kind: m.kind, tokens: round(m.tokens), preview: m.preview })) },
  };
}

/** profile_context on a chat-app sketch. */
export function compactSketch(p: SketchProfile, fullText: string): CompactResult {
  // The sketch report is short already: what makes it longer than it needs to
  // be is every finding's action. Only #1 is acted on, so only #1 keeps its
  // action (in the text); the rest are one line each.
  const [top, ...rest] = p.findings;
  const lines = [`~${formatTokens(p.totalTokens)} tokens, ${p.turns} turns${p.usagePct !== undefined ? `, ~${p.usagePct}% of the window` : ""} (estimate); ~${formatTokens(p.totalEstSavings)} recoverable, only in a new chat.`];
  if (top) {
    lines.push(`Act on #1 now: ${top.message} → ${top.action}`);
    lines.push("This chat's history cannot be edited: what is already here comes back only in a new chat (save_handoff).");
  } else lines.push("No findings. Keep going.");
  const structured: Record<string, unknown> = {
    total_tokens: p.totalTokens,
    recoverable_tokens: p.totalEstSavings,
    recoverable_by: "a new chat (handoff)",
  };
  if (rest.length) structured.other_findings = rest.map((f) => `${f.severity}${f.estSavings > 0 ? ` ~${formatTokens(f.estSavings)}` : ""}: ${f.message}`);
  if (p.usagePct !== undefined) structured.window_pct = p.usagePct;
  if (p.perTurnUsd !== undefined) structured.usd_per_turn = Number(p.perTurnUsd.toFixed(4));
  return { text: lines.join("\n"), structured, meta: { "context-doctor/report": fullText } };
}

/** "#2-5" for a run of consecutive chunk numbers. */
function idRange(first: string, last: string): string {
  const n = (id: string) => id.slice(id.lastIndexOf("#") + 1);
  return first === last ? `#${n(first)}` : `#${n(first)}-${n(last)}`;
}

/** The last segment of a heading path, without the "(cont.)" a split chunk carries. */
function shortHeading(heading: string): string {
  const base = heading.replace(/\s*\(cont\.\)$/, "");
  const parts = base.split(" > ");
  return parts[parts.length - 1] || base;
}

/** pack_context with no query: sections instead of one line per chunk. */
export function compactOutline(r: PackResult, fullText: string, maxSections = 120): CompactResult {
  // Consecutive chunks of one source under the same heading are one section.
  const bySource = new Map<string, Array<{ first: string; last: string; heading: string; tokens: number }>>();
  for (const c of r.chunks) {
    const list = bySource.get(c.source) ?? [];
    const heading = shortHeading(c.heading);
    const prev = list[list.length - 1];
    if (prev && prev.heading === heading) {
      prev.last = c.id;
      prev.tokens += c.tokens;
    } else list.push({ first: c.id, last: c.id, heading, tokens: c.tokens });
    bySource.set(c.source, list);
  }
  let budget = maxSections;
  let omitted = 0;
  const sources = [...bySource.entries()].map(([name, sections]) => {
    const shown = sections.slice(0, Math.max(0, budget));
    budget -= shown.length;
    omitted += sections.length - shown.length;
    const tokens = sections.reduce((n, s) => n + s.tokens, 0);
    return { name, tokens: round(tokens), sections: shown.map((s) => `${idRange(s.first, s.last)} ${s.heading} ~${formatTokens(s.tokens)}`) };
  });
  const names = r.sources.length === 1 ? r.sources[0].name : `${r.sources.length} files`;
  const example = r.chunks[0]?.id ?? "name#1";
  const text =
    `OUTLINE of ${names}: ~${formatTokens(r.totalTokens)} tokens in ${r.chunks.length} chunks, as sections in structuredContent. ` +
    `Nothing packed: pass a query, or ids (<name>#<n>, e.g. ${example}).`;
  const structured: Record<string, unknown> = { total_tokens: round(r.totalTokens), chunks: r.chunks.length, sources };
  if (omitted > 0) structured.sections_not_shown = omitted;
  return { text, structured, meta: { "context-doctor/outline": fullText } };
}
