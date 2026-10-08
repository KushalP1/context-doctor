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
import { AutoClearer, type AutoClearOptions, type AutoClearResult } from "./autoclear.js";
export interface WrapOptions extends AutoClearOptions {
    /** Called after each request is prepared: what autopilot did, and the model. */
    onRequest?: (info: AutoClearResult & {
        method: string;
        model?: string;
    }) => void;
    /** Share one clearer between several clients (default: one per wrapped client). */
    clearer?: AutoClearer;
}
export interface WrapStats {
    requests: number;
    changed: number;
    tokensRemoved: number;
}
/** Totals for a wrapped client: requests seen, how many autopilot slimmed, tokens not sent. */
export declare function contextDoctorStats(client: object): WrapStats | undefined;
export declare function withContextDoctor<T extends object>(client: T, options?: WrapOptions): T;
