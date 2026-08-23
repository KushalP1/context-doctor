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
/** Pull exact usage out of a response body — JSON or SSE, either provider. */
function extractUsage(text) {
    const last = (re) => {
        let m;
        let v = -1;
        while ((m = re.exec(text)) !== null)
            v = Number(m[1]);
        return v;
    };
    const input = Math.max(last(/"input_tokens"\s*:\s*(\d+)/g), last(/"prompt_tokens"\s*:\s*(\d+)/g));
    const output = Math.max(last(/"output_tokens"\s*:\s*(\d+)/g), last(/"completion_tokens"\s*:\s*(\d+)/g));
    if (input < 0 && output < 0)
        return null;
    return { input: Math.max(input, 0), output: Math.max(output, 0) };
}
function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
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
        upstreamInputTokens: 0,
        upstreamOutputTokens: 0,
        advice: [],
    };
    /** Last stable-prefix fingerprint per model, for cache-invalidation advice. */
    const prefixFingerprints = new Map();
    const advise = (msg) => {
        if (stats.advice.includes(msg) || stats.advice.length >= 10)
            return;
        stats.advice.push(msg);
        console.error(`[context-doctor] cache advisor: ${msg}`);
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
            // count_tokens is measurement — optimizing it would silently change the
            // number the caller is trying to read, so it always passes through.
            stats.requests++;
            const isMeasurement = url.startsWith("/v1/messages/count_tokens");
            let note = "passthrough";
            if (req.method === "POST" && body && !isMeasurement) {
                try {
                    // Per-route overrides: first modelPrefix match wins.
                    let effective = opts;
                    let requestModel;
                    try {
                        const parsedBody = JSON.parse(body);
                        requestModel = parsedBody.model;
                        const route = requestModel ? opts.routes?.find((r) => requestModel.startsWith(r.modelPrefix)) : undefined;
                        if (route) {
                            effective = {
                                strategies: route.strategies ?? opts.strategies,
                                keepRecent: route.keepRecent ?? opts.keepRecent,
                                maxToolResultTokens: route.maxToolResultTokens ?? opts.maxToolResultTokens,
                            };
                        }
                        // Prompt-cache advisor (Anthropic requests): the proxy sees real
                        // sequences, so cache-hostile patterns are observable facts here.
                        if (url.startsWith("/v1/messages") && requestModel) {
                            const stablePrefix = JSON.stringify(parsedBody.tools ?? null) + JSON.stringify(parsedBody.system ?? null);
                            if (stablePrefix.length > 4000 && !body.includes("cache_control")) {
                                advise(`~${Math.round(stablePrefix.length / 4)}+ tokens of stable system/tools on ${requestModel} without cache_control — adding a breakpoint would cut those to ~10% cost per call`);
                            }
                            const fp = fnv1a(stablePrefix);
                            const prev = prefixFingerprints.get(requestModel);
                            if (prev !== undefined && prev !== fp) {
                                advise(`system/tools prefix changed between ${requestModel} requests — every change re-bills the whole cached prefix; keep it byte-stable`);
                            }
                            prefixFingerprints.set(requestModel, fp);
                        }
                    }
                    catch {
                        /* body isn't JSON — global opts apply */
                    }
                    const result = optimizeConversation(body, effective);
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
                // Pipe through chunk-by-chunk so SSE streaming works unchanged, while
                // accumulating a bounded copy to read exact usage after the fact.
                const USAGE_SCAN_CAP = 2 * 1024 * 1024;
                let scanBuf = "";
                const decoder = new TextDecoder();
                const reader = upstream.body.getReader();
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    res.write(value);
                    if (scanBuf.length < USAGE_SCAN_CAP)
                        scanBuf += decoder.decode(value, { stream: true });
                }
                if (upstream.ok && !isMeasurement) {
                    const usage = extractUsage(scanBuf);
                    if (usage) {
                        stats.upstreamInputTokens += usage.input;
                        stats.upstreamOutputTokens += usage.output;
                    }
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
    const host = opts.host ?? "127.0.0.1";
    server.listen(port, host, () => {
        console.error(`context-doctor proxy listening on http://${host}:${port}`);
        console.error(`  Anthropic apps/SDKs: export ANTHROPIC_BASE_URL=http://localhost:${port}`);
        console.error(`  OpenAI apps/SDKs:    export OPENAI_BASE_URL=http://localhost:${port}/v1`);
        console.error(`  Every request's context is optimized in flight; savings are logged here.`);
        console.error(`  Cumulative savings: http://localhost:${port}/stats`);
    });
    return server;
}
