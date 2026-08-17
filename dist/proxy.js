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
import { optimizeConversation } from "./optimize.js";
import { formatTokens } from "./tokens.js";
import { formatUsd, inputCostUsd, pricingFor } from "./pricing.js";
/** Connection-level headers that must not be forwarded. */
const SKIP_REQUEST_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "accept-encoding", "expect"]);
const SKIP_RESPONSE_HEADERS = new Set(["content-length", "content-encoding", "transfer-encoding", "connection"]);
function upstreamFor(url, opts) {
    if (url.startsWith("/v1/messages"))
        return opts.anthropicUpstream ?? "https://api.anthropic.com";
    if (url.startsWith("/v1/chat/completions") || url.startsWith("/v1/responses") || url.startsWith("/v1/embeddings")) {
        return opts.openaiUpstream ?? "https://api.openai.com";
    }
    return undefined;
}
export function startProxy(opts = {}) {
    const port = opts.port ?? 8787;
    const stats = {
        startedAt: new Date().toISOString(),
        requests: 0,
        optimizedRequests: 0,
        tokensBefore: 0,
        tokensAfter: 0,
        tokensSaved: 0,
        estUsdSaved: 0,
    };
    const server = http.createServer(async (req, res) => {
        const url = req.url ?? "/";
        try {
            if (url === "/health") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, service: "context-doctor-proxy" }));
                return;
            }
            if (url === "/stats") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ...stats, estUsdSaved: Number(stats.estUsdSaved.toFixed(4)) }, null, 2));
                return;
            }
            const upstreamBase = upstreamFor(url, opts);
            if (!upstreamBase) {
                res.statusCode = 404;
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ error: `context-doctor proxy: unsupported path ${url} (supported: /v1/messages, /v1/chat/completions, /v1/responses)` }));
                return;
            }
            const chunks = [];
            for await (const chunk of req)
                chunks.push(chunk);
            let body = Buffer.concat(chunks).toString("utf8");
            // Optimize the message history in flight. Anything unparseable (or with
            // no messages array, e.g. embeddings) passes through untouched.
            stats.requests++;
            let note = "passthrough";
            if (req.method === "POST" && body) {
                try {
                    const result = optimizeConversation(body, opts);
                    const saved = result.tokensBefore - result.tokensAfter;
                    stats.tokensBefore += result.tokensBefore;
                    stats.tokensAfter += result.tokensAfter;
                    if (saved > 0) {
                        body = JSON.stringify(result.conversation);
                        stats.optimizedRequests++;
                        stats.tokensSaved += saved;
                        const pricing = pricingFor(result.conversation?.model);
                        if (pricing)
                            stats.estUsdSaved += inputCostUsd(saved, pricing);
                    }
                    note = saved > 0
                        ? `optimized ${formatTokens(result.tokensBefore)} → ${formatTokens(result.tokensAfter)} tokens (${result.applied.length} changes)`
                        : "clean (nothing to save)";
                }
                catch {
                    /* not a conversation payload — forward as-is */
                }
            }
            const headers = {};
            for (const [key, value] of Object.entries(req.headers)) {
                if (!SKIP_REQUEST_HEADERS.has(key.toLowerCase()) && typeof value === "string")
                    headers[key] = value;
            }
            const upstreamStart = Date.now();
            const upstream = await fetch(upstreamBase + url, {
                method: req.method ?? "POST",
                headers,
                body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
            });
            console.error(`[context-doctor] ${req.method} ${url} → ${upstream.status} in ${Date.now() - upstreamStart}ms | ${note}` +
                (stats.tokensSaved > 0 ? ` | session total: ${formatTokens(stats.tokensSaved)} tokens ≈ ${formatUsd(stats.estUsdSaved)} saved` : ""));
            res.statusCode = upstream.status;
            upstream.headers.forEach((value, key) => {
                if (!SKIP_RESPONSE_HEADERS.has(key))
                    res.setHeader(key, value);
            });
            if (upstream.body) {
                // Pipe through chunk-by-chunk so SSE streaming works unchanged.
                const reader = upstream.body.getReader();
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    res.write(value);
                }
            }
            res.end();
        }
        catch (e) {
            console.error(`[context-doctor] error on ${url}: ${e.message}`);
            if (!res.headersSent) {
                res.statusCode = 502;
                res.setHeader("content-type", "application/json");
            }
            res.end(JSON.stringify({ error: `context-doctor proxy: ${e.message}` }));
        }
    });
    server.listen(port, () => {
        console.error(`context-doctor proxy listening on http://localhost:${port}`);
        console.error(`  Anthropic apps/SDKs: export ANTHROPIC_BASE_URL=http://localhost:${port}`);
        console.error(`  OpenAI apps/SDKs:    export OPENAI_BASE_URL=http://localhost:${port}/v1`);
        console.error(`  Every request's context is optimized in flight; savings are logged here.`);
        console.error(`  Cumulative savings: http://localhost:${port}/stats`);
    });
    return server;
}
