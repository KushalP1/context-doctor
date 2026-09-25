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
import { timingSafeEqual } from "node:crypto";
import { optimizeConversation } from "./optimize.js";
import { AutoClearer } from "./autoclear.js";
import { existsSync } from "node:fs";
import { formatTokens, CHARS_PER_TOKEN, providerFor } from "./tokens.js";
import { formatUsd, inputCostUsd, pricingFor } from "./pricing.js";
import { recordLedger } from "./ledger.js";
/** Reported by /health so `autopilot status` can tell an outdated service from a current one. */
export const PROXY_VERSION = "0.20.1";
/** Connection-level headers that must not be forwarded. */
const SKIP_REQUEST_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "accept-encoding", "expect"]);
const SKIP_RESPONSE_HEADERS = new Set(["content-length", "content-encoding", "transfer-encoding", "connection"]);
/**
 * Remove a leading `/t/<token>` from a request path, or return undefined when
 * the prefix is absent or the token differs. The comparison is constant time
 * so the token cannot be guessed a character at a time.
 */
export function stripToken(url, token) {
    const prefix = "/t/";
    if (!url.startsWith(prefix))
        return undefined;
    const end = url.indexOf("/", prefix.length);
    const candidate = end === -1 ? url.slice(prefix.length) : url.slice(prefix.length, end);
    const a = Buffer.from(candidate), b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b))
        return undefined;
    const rest = end === -1 ? "/" : url.slice(end);
    return rest;
}
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
    const clearer = opts.autopilot ? new AutoClearer({ statePath: opts.autopilotStatePath }) : undefined;
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
        upstreamCacheReadTokens: 0,
        upstreamCacheWriteTokens: 0,
        autopilot: opts.autopilot
            ? { enabled: true, paused: false, requests: 0, changedRequests: 0, batches: 0, coldBatches: 0, resultsCleared: 0, tokensRemoved: 0, lastReason: "" }
            : undefined,
    };
    /** Last stable-prefix fingerprint per model, for cache-invalidation advice. */
    const prefixFingerprints = new Map();
    /** Per-message fingerprints of the previous request per model, for breakpoint placement. */
    const messageFingerprints = new Map();
    const advise = (msg) => {
        if (stats.advice.includes(msg) || stats.advice.length >= 10)
            return;
        stats.advice.push(msg);
        console.error(`[context-doctor] cache advisor: ${msg}`);
    };
    const server = http.createServer(async (req, res) => {
        let url = req.url ?? "/";
        try {
            if (url === "/health") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, service: "context-doctor-proxy", autopilot: Boolean(opts.autopilot), version: PROXY_VERSION }));
                return;
            }
            if (opts.token) {
                const stripped = stripToken(url, opts.token);
                if (stripped === undefined) {
                    res.statusCode = 401;
                    res.setHeader("content-type", "application/json");
                    res.end(JSON.stringify({ error: "context-doctor proxy: this proxy requires its token in the path: /t/<token>/v1/..." }));
                    return;
                }
                url = stripped;
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
            if (opts.autopilot) {
                if (req.method === "POST" && body && !isMeasurement && /^\/v1\/(messages|chat\/completions|responses)(\?|$)/.test(url)) {
                    const ap = stats.autopilot;
                    ap.paused = Boolean(opts.autopilotPauseFile && existsSync(opts.autopilotPauseFile));
                    if (ap.paused) {
                        note = "autopilot paused";
                    }
                    else {
                        try {
                            const parsed = JSON.parse(body);
                            const r = clearer.apply(parsed);
                            ap.requests++;
                            ap.lastReason = r.reason;
                            if (r.newlyCleared > 0) {
                                ap.batches++;
                                ap.resultsCleared += r.newlyCleared;
                                if (r.cold)
                                    ap.coldBatches++;
                            }
                            if (r.changed) {
                                body = JSON.stringify(parsed);
                                ap.changedRequests++;
                                ap.tokensRemoved += r.tokensRemoved;
                                stats.optimizedRequests++;
                                stats.tokensSaved += r.tokensRemoved;
                                const pricing = pricingFor(typeof parsed.model === "string" ? parsed.model : undefined);
                                if (pricing)
                                    stats.estUsdSaved += inputCostUsd(r.tokensRemoved, pricing);
                                note = `autopilot: ${formatTokens(r.tokensRemoved)} tokens of stale tool output not sent (${r.reason})`;
                            }
                            else {
                                note = `autopilot: ${r.reason}`;
                            }
                        }
                        catch {
                            note = "autopilot: unparseable body, forwarded unchanged";
                        }
                    }
                }
            }
            else if (req.method === "POST" && body && !isMeasurement) {
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
                                trimBoundaryStep: opts.trimBoundaryStep,
                            };
                        }
                        // Prompt-cache advisor (Anthropic requests): the proxy sees real
                        // sequences, so cache-hostile patterns are observable facts here.
                        if (url.startsWith("/v1/messages") && requestModel) {
                            const stablePrefix = JSON.stringify(parsedBody.tools ?? null) + JSON.stringify(parsedBody.system ?? null);
                            const hasBreakpoint = body.includes("cache_control");
                            const stablePrefixTokens = Math.round(stablePrefix.length / CHARS_PER_TOKEN[providerFor(requestModel)].code);
                            // Anthropic will not cache a prefix under ~1024 tokens; below that the advice is useless.
                            if (stablePrefixTokens >= 1024 && !hasBreakpoint) {
                                // Say WHERE, not just that. A breakpoint caches everything up
                                // to and including the block it sits on, so it belongs on the
                                // LAST stable block: the final tool definition if there are
                                // tools, otherwise the final system block.
                                const where = Array.isArray(parsedBody.tools) && parsedBody.tools.length > 0
                                    ? `the last entry in "tools" (tools come before system in the cached prefix)`
                                    : `the last block of "system"`;
                                advise(`~${stablePrefixTokens}+ tokens of stable system/tools on ${requestModel} without cache_control. ` +
                                    `Add {"cache_control":{"type":"ephemeral"}} to ${where}; everything before it then bills at ~10% on every call`);
                            }
                            const fp = fnv1a(stablePrefix);
                            const prev = prefixFingerprints.get(requestModel);
                            if (prev !== undefined && prev !== fp) {
                                advise(`system/tools prefix changed between ${requestModel} requests — every change re-bills the whole cached prefix; keep it byte-stable`);
                            }
                            prefixFingerprints.set(requestModel, fp);
                            // Second breakpoint: the conversation itself. Between two
                            // consecutive requests the older messages are usually identical;
                            // that run is cacheable too, and it is what re-bills every turn
                            // when nothing marks it. Find the longest message prefix that
                            // survived from the previous request and point at its last message.
                            const msgs = Array.isArray(parsedBody.messages)
                                ? parsedBody.messages
                                : [];
                            const hashes = msgs.map((m) => fnv1a(JSON.stringify(m)));
                            const prevHashes = messageFingerprints.get(requestModel);
                            if (prevHashes && !hasBreakpoint) {
                                let stable = 0;
                                while (stable < hashes.length && stable < prevHashes.length && hashes[stable] === prevHashes[stable])
                                    stable++;
                                if (stable >= 2) {
                                    const stableChars = msgs.slice(0, stable).reduce((n, m) => n + JSON.stringify(m).length, 0);
                                    const stableTokens = Math.round(stableChars / CHARS_PER_TOKEN[providerFor(requestModel)].code);
                                    // Anthropic will not cache a prefix under ~1024 tokens (2048 on Haiku).
                                    if (stableTokens >= 1024) {
                                        advise(`messages #0-#${stable - 1} (~${stableTokens} tokens) were identical to the previous ${requestModel} request and carry no cache_control. ` +
                                            `Put {"cache_control":{"type":"ephemeral"}} on the last content block of message #${stable - 1}; that run then reads from cache instead of re-billing each turn`);
                                    }
                                }
                            }
                            messageFingerprints.set(requestModel, hashes);
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
                    // Streams repeat the usage object; the last figure is the final one.
                    const lastNum = (re) => { let m, v = 0; while ((m = re.exec(scanBuf)) !== null)
                        v = Number(m[1]); return v; };
                    stats.upstreamCacheReadTokens += lastNum(/"cache_read_input_tokens"\s*:\s*(\d+)/g);
                    stats.upstreamCacheWriteTokens += lastNum(/"cache_creation_input_tokens"\s*:\s*(\d+)/g);
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
    // Savings live in memory, so a restart would erase the record the dashboard
    // and report draw on. Checkpoint the delta to the ledger periodically and on
    // shutdown, so the history survives the process.
    let checkpointedTokens = 0;
    let checkpointedUsd = 0;
    let checkpointedRequests = 0;
    const checkpoint = () => {
        const savedDelta = stats.tokensSaved - checkpointedTokens;
        if (savedDelta <= 0)
            return;
        recordLedger({
            ev: "proxy",
            src: "proxy",
            saved: savedDelta,
            usd: Number((stats.estUsdSaved - checkpointedUsd).toFixed(6)),
            requests: stats.optimizedRequests - checkpointedRequests,
        });
        checkpointedTokens = stats.tokensSaved;
        checkpointedUsd = stats.estUsdSaved;
        checkpointedRequests = stats.optimizedRequests;
    };
    const checkpointTimer = setInterval(checkpoint, 60_000);
    checkpointTimer.unref?.(); // never hold the process open on our account
    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.once(signal, () => {
            checkpoint();
            process.exit(0);
        });
    }
    server.on("close", checkpoint);
    const host = opts.host ?? "127.0.0.1";
    server.listen(port, host, () => {
        // Print the token as <token>, never the value: this log is what people paste into bug reports.
        const prefix = opts.token ? "/t/<token>" : "";
        console.error(`context-doctor proxy listening on http://${host}:${port}`);
        console.error(`  Anthropic apps/SDKs: export ANTHROPIC_BASE_URL=http://localhost:${port}${prefix}`);
        console.error(`  OpenAI apps/SDKs:    export OPENAI_BASE_URL=http://localhost:${port}${prefix}/v1`);
        console.error(`  Every request's context is optimized in flight; savings are logged here.`);
        console.error(`  Cumulative savings: http://localhost:${port}${prefix}/stats`);
        if (opts.token) {
            console.error(`  Token required: every path except /health must start with /t/<token>/.`);
            console.error(`  Cursor with your own OpenAI key: expose this port on HTTPS (a tunnel), then Settings > Models > OpenAI API Key >`);
            console.error(`  "Override OpenAI Base URL" = https://<your-host>/t/<token>/v1. Cursor's servers call that URL, so 127.0.0.1 will not work there.`);
        }
    });
    return server;
}
