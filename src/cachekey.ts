/**
 * A stable `prompt_cache_key` per conversation for OpenAI requests that do
 * not carry one.
 *
 * OpenAI routes a request to a cache by a hash of its first tokens and, when
 * present, the key (prompt-caching guide, checked 2026-10-18). On models
 * before GPT-5.6 (GPT-5.5 and earlier) a stable key per group of related
 * requests is how to keep them on one cache; from GPT-5.6 on the key is
 * optional and only separates cache accounting, so it is left alone there.
 * A key the app set is never touched, and requests that continue a
 * server-side conversation (`previous_response_id`, `conversation`) are left
 * as they are: their history is not in the request to identify.
 *
 * The key is derived from what stays fixed for a conversation's life: its
 * instructions (system/developer messages, Responses `instructions`) and its
 * first user message. Two conversations that open identically share a key,
 * which is what a shared prefix wants anyway.
 */

import { createHash } from "node:crypto";

/** Models whose cache routing uses the key: GPT before 5.6, the o-series, codex-mini. */
export function usesPromptCacheKey(model: unknown): boolean {
  if (typeof model !== "string") return false;
  const m = model.toLowerCase().replace(/^openai\//, "");
  const gpt = /^gpt-(\d+)(?:\.(\d+))?/.exec(m);
  if (gpt) return Number(gpt[1]) < 5 || (Number(gpt[1]) === 5 && Number(gpt[2] ?? 0) < 6);
  return /^(o1|o3|o4)(-|$)|^codex-mini/.test(m);
}

const text = (c: unknown): string => (typeof c === "string" ? c : JSON.stringify(c ?? ""));

/** The fixed part of a conversation: instructions and the first user message. */
function anchor(body: Record<string, any>): string | undefined {
  if (Array.isArray(body.messages)) {
    const msgs = body.messages as Array<Record<string, any>>;
    const first = msgs.findIndex((m) => m?.role === "user");
    if (first < 0) return undefined;
    return [...msgs.slice(0, first).filter((m) => m?.role === "system" || m?.role === "developer").map((m) => text(m.content)), text(msgs[first].content)].join("\0");
  }
  if (typeof body.input === "string") return `${text(body.instructions)}\0${body.input}`;
  if (Array.isArray(body.input)) {
    const items = body.input as Array<Record<string, any>>;
    const first = items.find((i) => i?.role === "user");
    if (!first) return undefined;
    const sys = items.filter((i) => i?.role === "system" || i?.role === "developer").map((i) => text(i.content));
    return [text(body.instructions), ...sys, text(first.content)].join("\0");
  }
  return undefined;
}

/** The request with a conversation key added, or undefined when it should go as it is. */
export function withPromptCacheKey(raw: string): { body: string; key: string } | undefined {
  let body: Record<string, any>;
  try { body = JSON.parse(raw); } catch { return undefined; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  if ("prompt_cache_key" in body || body.previous_response_id || body.conversation) return undefined;
  if (!usesPromptCacheKey(body.model)) return undefined;
  const a = anchor(body);
  if (a === undefined) return undefined;
  const key = "cd-" + createHash("sha256").update(a.slice(0, 20_000)).digest("hex").slice(0, 32);
  body.prompt_cache_key = key;
  return { body: JSON.stringify(body), key };
}
