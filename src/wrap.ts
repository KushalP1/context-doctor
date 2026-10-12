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
 *
 * Thinking blocks: on current Claude models a thinking block's signature
 * binds the history before it, and enforced accounts get a 400 for an edited
 * one. As the proxy does, an Anthropic request refused that way is sent
 * again once as the caller wrote it, and the account is remembered so its
 * conversations are not edited where a thinking block follows.
 */

import { createHash, randomUUID } from "node:crypto";
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
/** Methods whose answer can be Anthropic's thinking-signature refusal. */
const ANTHROPIC = new Set(["messages.create", "messages.stream", "beta.messages.create", "beta.messages.stream"]);

/** Anthropic's 400 for a history whose thinking-block signatures no longer match it (the proxy's test, proxy.ts). */
const THINKING_EDIT_REJECTED = /bound to a different conversation|Invalid `signature` in `thinking` block/;

/** The refusal's text when `err` is that 400 as the SDK throws it (status, message, parsed body), else undefined. */
function editRefusal(err: unknown): string | undefined {
  const e = err as { status?: unknown; message?: unknown; error?: unknown } | null;
  if (!e || typeof e !== "object" || e.status !== 400) return undefined;
  let text = String(e.message ?? "");
  try {
    text += " " + JSON.stringify(e.error ?? "");
  } catch {
    /* an unserializable body: the message alone */
  }
  return THINKING_EDIT_REJECTED.test(text) ? text : undefined;
}

const isThenable = (v: unknown): v is PromiseLike<unknown> => !!v && (typeof v === "object" || typeof v === "function") && typeof (v as { then?: unknown }).then === "function";

/**
 * Send the edited request; if the API refuses it for its thinking
 * signatures, send the caller's own request once instead and answer with
 * that, as if nothing happened. `settle` learns the refusal and whether the
 * unedited request then went through.
 *
 * The SDKs answer with a promise carrying extra methods (Anthropic's
 * APIPromise: withResponse, asResponse), so the answer keeps that shape:
 * awaiting it, or any of its promise-returning methods, falls back to the
 * same single resend. A refusal thrown synchronously is handled the same
 * way. A stream object that reports the 400 as an event instead (the
 * Anthropic SDK's MessageStream) is the caller's already and cannot be
 * swapped: that refusal reaches the caller.
 */
function resendIfRefused(send: () => unknown, resend: () => unknown, settle: (refusal: string, accepted: boolean) => void): unknown {
  let again: { value: unknown } | { error: unknown } | undefined;
  const retry = (err: unknown): unknown => {
    const refusal = editRefusal(err);
    if (refusal === undefined) throw err;
    if (!again) {
      try {
        const value = resend();
        again = { value };
        if (isThenable(value)) value.then(() => settle(refusal, true), () => settle(refusal, false));
        else settle(refusal, true);
      } catch (error) {
        again = { error };
        settle(refusal, false);
      }
    }
    if ("error" in again) throw again.error;
    return again.value;
  };
  let first: unknown;
  try {
    first = send();
  } catch (err) {
    return retry(err);
  }
  if (!isThenable(first)) return first;
  let settled: Promise<unknown> | undefined;
  // Created only when the caller awaits it, so a refusal nobody awaits is
  // not turned into an unhandled rejection of our own.
  const answer = () => (settled ??= Promise.resolve(first).then(undefined, retry));
  return new Proxy(first as object, {
    get(target, prop) {
      if (prop === "then" || prop === "catch" || prop === "finally") {
        return (...args: unknown[]) => (answer() as any)[prop](...args);
      }
      const v = Reflect.get(target, prop, target);
      if (typeof v !== "function") return v;
      // Methods run on the SDK's own object (its private fields do not exist on a Proxy).
      return (...args: unknown[]) => {
        const out = v.apply(target, args);
        if (!isThenable(out)) return out;
        return Promise.resolve(out).then(undefined, (err) => {
          const a = retry(err) as Record<string | symbol, unknown> | undefined;
          const m = a?.[prop];
          return typeof m === "function" ? m.apply(a, args) : a;
        });
      };
    },
  });
}

/**
 * Which account a wrapped client speaks for, as the proxy keys it: a salted
 * hash of its credential (never the key itself), so a refusal remembered
 * in a shared clearer or its state file stays with that account. A client
 * with no visible credential gets a key of its own.
 */
function wrapperAccount(client: object): string {
  const c = client as { apiKey?: unknown; authToken?: unknown };
  const credential = typeof c.apiKey === "string" && c.apiKey ? c.apiKey : typeof c.authToken === "string" && c.authToken ? `Bearer ${c.authToken}` : undefined;
  if (!credential) return `wrapper:${randomUUID()}`;
  return createHash("sha256").update(`context-doctor account\0${credential}`).digest("hex").slice(0, 16);
}

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
  // One client, one account: the clearer keeps per account whether its API
  // refuses edited history (AutoClearer.rejectsEdits).
  const account = wrapperAccount(client);

  /** The request to send, and what autopilot changed in it (undefined: sent as the caller wrote it). */
  const prepare = (method: string, params: unknown): { body: unknown; result?: AutoClearResult } => {
    if (!params || typeof params !== "object" || Array.isArray(params)) return { body: params };
    // Copy the top level and deep-clone only the history, the one part
    // autopilot rewrites: the rest can hold things that do not clone
    // (an AbortSignal or callable tools in @google/genai's config).
    stats.requests++;
    const src = params as Record<string, unknown>;
    const field = ["messages", "input", "contents"].find((k) => Array.isArray(src[k]));
    if (!field) return { body: params };
    let body: Record<string, unknown>;
    try {
      body = { ...src, [field]: structuredClone(src[field]) };
    } catch {
      return { body: params }; // something uncloneable inside the history: leave the request alone
    }
    const result = clearer.apply(body, undefined, undefined, account);
    if (result.changed) {
      stats.changed++;
      stats.tokensRemoved += result.tokensRemoved;
    }
    try {
      onRequest?.({ ...result, method, model: typeof body.model === "string" ? body.model : undefined });
    } catch {
      /* a logging callback must not fail the request */
    }
    return result.changed ? { body, result } : { body: params };
  };

  /**
   * The edit was refused for its thinking signatures. As the proxy does:
   * remember the account (a bad signature with no word on the conversation
   * is not ours to learn from, unless the unedited request then went
   * through), and take back what the edit added to the stats and to
   * autopilot's memory. Accepted unedited, the newest thinking is bound to
   * the full history, so none of these clearings may be sent again; refused
   * as well, only this request's new ones never reached the model.
   */
  const refused = (result: AutoClearResult) => (refusal: string, accepted: boolean): void => {
    if (/bound to a different conversation/.test(refusal) || accepted) clearer.noteEditsRejected(account);
    stats.changed--;
    stats.tokensRemoved -= result.tokensRemoved;
    clearer.forget(accepted ? result.appliedIds : result.newIds);
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
            const { body, result } = prepare(full, params);
            if (!result || !ANTHROPIC.has(full)) return value.call(obj, body, ...rest);
            // The resend is the caller's ORIGINAL params, by reference.
            return resendIfRefused(() => value.call(obj, body, ...rest), () => value.call(obj, params, ...rest), refused(result));
          };
        }
        if (PARENTS.has(full) && value && typeof value === "object") return wrap(value, full);
        return value;
      },
    });

  return wrap(client, "") as T;
}
