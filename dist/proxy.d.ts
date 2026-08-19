/**
 * Always-on optimization: a local reverse proxy that sits between your app
 * and the Anthropic/OpenAI APIs. Every request's message history is optimized
 * in flight (dedupe, trim stale tool results, strip base64) before being
 * forwarded — no code changes in your app, just a base-URL env var:
 *
 *   ANTHROPIC_BASE_URL=http://localhost:8787        (Anthropic SDKs)
 *   OPENAI_BASE_URL=http://localhost:8787/v1        (OpenAI SDKs)
 *
 * API keys pass through untouched in headers — the proxy stores nothing and
 * talks only to the official upstream endpoints (overridable for testing).
 * Streaming responses are piped through unchanged.
 */
import http from "node:http";
import { OptimizeOptions } from "./optimize.js";
export interface ProxyOptions extends OptimizeOptions {
    port?: number;
    /**
     * Bind address. Defaults to 127.0.0.1 — the proxy relays authenticated
     * traffic and exposes /stats, so it must not listen on the network unless
     * the user explicitly opts in (e.g. --host 0.0.0.0 inside a container).
     */
    host?: string;
    anthropicUpstream?: string;
    openaiUpstream?: string;
}
export interface ProxyStats {
    startedAt: string;
    requests: number;
    optimizedRequests: number;
    tokensBefore: number;
    tokensAfter: number;
    tokensSaved: number;
    /** USD saved on input tokens, when the request's model has a known price. */
    estUsdSaved: number;
}
export declare function startProxy(opts?: ProxyOptions): http.Server;
