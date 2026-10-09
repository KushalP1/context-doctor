/**
 * Autopilot in process: `withContextDoctor(client)` for apps that cannot send
 * their API traffic through the local proxy (serverless and edge functions,
 * managed hosts, anything without a sidecar).
 *
 *   import Anthropic from "@anthropic-ai/sdk";
 *   import { withContextDoctor } from "context-doctor";
 *   const client = withContextDoctor(new Anthropic());
 *
 * Works on the official Anthropic, OpenAI and Google Gen AI SDK clients (and
 * anything shaped like them): messages.create/stream,
 * chat.completions.create/stream/parse, responses.create/stream/parse (beta
 * namespaces included) and models.generateContent/generateContentStream.
 * Gemini chat sessions (ai.chats) keep their history inside the SDK, out of
 * reach; use generateContent with your own history to get autopilot. Each request goes
 * through the same AutoClearer the proxy uses: stale tool output is cleared
 * only when the prompt cache is cold, so a request never costs more.
 *
 * The request is cloned before it is changed. Apps keep their history in the
 * arrays they pass, and rewriting those in place would be the silent history
 * rewriting this project rules out; only the copy that goes on the wire is
 * slimmer.
 *
 * State lives in this process. Run one process per conversation stream (a
 * server, a worker, an agent) and it behaves like the proxy. A conversation
 * this instance has not seen is treated as warm, so a fresh serverless
 * instance never clears blind; pass `statePath` on shared storage when many
 * instances serve the same conversations.
 */

import { AutoClearer, type AutoClearOptions, type AutoClearResult } from "./autoclear.js";

const WRAPPED = new Set([
  "messages.create",
  "messages.stream",
  "beta.messages.create",
  "beta.messages.stream",
  "chat.completions.create",
  "chat.completions.stream",
  "chat.completions.parse",
  "beta.chat.completions.create",
  "beta.chat.completions.stream",
  "beta.chat.completions.parse",
  "responses.create",
  "responses.stream",
  "responses.parse",
  // Google's @google/genai: ai.models.generateContent({ model, contents, config })
  "models.generateContent",
  "models.generateContentStream",
]);
const PARENTS = new Set([...WRAPPED].flatMap((p) => p.split(".").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("."))));

export interface WrapOptions extends AutoClearOptions {
  /** Called after each request is prepared: what autopilot did, and the model. */
  onRequest?: (info: AutoClearResult & { method: string; model?: string }) => void;
  /** Share one clearer between several clients (default: one per wrapped client). */
  clearer?: AutoClearer;
}

export interface WrapStats {
  requests: number;
  changed: number;
  tokensRemoved: number;
}

const STATS = Symbol.for("context-doctor.stats");

/** Totals for a wrapped client: requests seen, how many autopilot slimmed, tokens not sent. */
export function contextDoctorStats(client: object): WrapStats | undefined {
  return (client as Record<symbol, WrapStats>)[STATS];
}

export function withContextDoctor<T extends object>(client: T, options: WrapOptions = {}): T {
  const { onRequest, clearer: shared, ...clearOpts } = options;
  const clearer = shared ?? new AutoClearer({ unseenIsWarm: true, ...clearOpts });
  const stats: WrapStats = { requests: 0, changed: 0, tokensRemoved: 0 };

  const prepare = (method: string, params: unknown): unknown => {
    if (!params || typeof params !== "object" || Array.isArray(params)) return params;
    // Copy the top level and deep-clone only the history, the one part
    // autopilot rewrites: the rest can hold things that do not clone
    // (an AbortSignal or callable tools in @google/genai's config).
    stats.requests++;
    const src = params as Record<string, unknown>;
    const field = ["messages", "input", "contents"].find((k) => Array.isArray(src[k]));
    if (!field) return params;
    let body: Record<string, unknown>;
    try {
      body = { ...src, [field]: structuredClone(src[field]) };
    } catch {
      return params; // something uncloneable inside the history: leave the request alone
    }
    const result = clearer.apply(body);
    if (result.changed) {
      stats.changed++;
      stats.tokensRemoved += result.tokensRemoved;
    }
    try {
      onRequest?.({ ...result, method, model: typeof body.model === "string" ? body.model : undefined });
    } catch {
      /* a logging callback must not fail the request */
    }
    return result.changed ? body : params;
  };

  const wrap = (target: object, path: string): object =>
    new Proxy(target, {
      get(obj, prop, receiver) {
        if (prop === STATS && path === "") return stats;
        const value = Reflect.get(obj, prop, receiver);
        if (typeof prop !== "string") return value;
        const full = path ? `${path}.${prop}` : prop;
        if (WRAPPED.has(full) && typeof value === "function") {
          return function (this: unknown, params: unknown, ...rest: unknown[]) {
            return value.call(obj, prepare(full, params), ...rest);
          };
        }
        if (PARENTS.has(full) && value && typeof value === "object") return wrap(value, full);
        return value;
      },
    });

  return wrap(client, "") as T;
}
