/**
 * Autopilot in process: `withContextDoctor(client)` for apps that cannot send
 * their API traffic through the local proxy (serverless and edge functions,
 * managed hosts, anything without a sidecar).
 *
 *   import Anthropic from "@anthropic-ai/sdk";
 *   import { withContextDoctor } from "context-doctor";
 *   const client = withContextDoctor(new Anthropic());
 *
 * Works on the official Anthropic and OpenAI SDK clients (and anything shaped
 * like them): messages.create/stream, chat.completions.create/stream/parse and
 * responses.create/stream/parse, beta namespaces included. Each request goes
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
import { AutoClearer } from "./autoclear.js";
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
]);
const PARENTS = new Set([...WRAPPED].flatMap((p) => p.split(".").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("."))));
const STATS = Symbol.for("context-doctor.stats");
/** Totals for a wrapped client: requests seen, how many autopilot slimmed, tokens not sent. */
export function contextDoctorStats(client) {
    return client[STATS];
}
export function withContextDoctor(client, options = {}) {
    const { onRequest, clearer: shared, ...clearOpts } = options;
    const clearer = shared ?? new AutoClearer({ unseenIsWarm: true, ...clearOpts });
    const stats = { requests: 0, changed: 0, tokensRemoved: 0 };
    const prepare = (method, params) => {
        if (!params || typeof params !== "object" || Array.isArray(params))
            return params;
        let body;
        try {
            body = structuredClone(params);
        }
        catch {
            return params; // something uncloneable (a function, a stream): leave the request alone
        }
        const result = clearer.apply(body);
        stats.requests++;
        if (result.changed) {
            stats.changed++;
            stats.tokensRemoved += result.tokensRemoved;
        }
        try {
            onRequest?.({ ...result, method, model: typeof body.model === "string" ? body.model : undefined });
        }
        catch {
            /* a logging callback must not fail the request */
        }
        return result.changed ? body : params;
    };
    const wrap = (target, path) => new Proxy(target, {
        get(obj, prop, receiver) {
            if (prop === STATS && path === "")
                return stats;
            const value = Reflect.get(obj, prop, receiver);
            if (typeof prop !== "string")
                return value;
            const full = path ? `${path}.${prop}` : prop;
            if (WRAPPED.has(full) && typeof value === "function") {
                return function (params, ...rest) {
                    return value.call(obj, prepare(full, params), ...rest);
                };
            }
            if (PARENTS.has(full) && value && typeof value === "object")
                return wrap(value, full);
            return value;
        },
    });
    return wrap(client, "");
}
