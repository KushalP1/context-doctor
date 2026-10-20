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
import { createHash, timingSafeEqual } from "node:crypto";
import { optimizeConversation } from "./optimize.js";
import { AutoClearer, optsIntoThinkingCheck, thinkingAfter } from "./autoclear.js";
import { existsSync } from "node:fs";
import { formatTokens, CHARS_PER_TOKEN, providerFor } from "./tokens.js";
import { formatUsd, inputCostUsd, pricingFor } from "./pricing.js";
import { recordLedger } from "./ledger.js";
import { minCacheableTokens } from "./cacheplan.js";
import { withPromptCacheKey } from "./cachekey.js";
/** Reported by /health so `autopilot status` can tell an outdated service from a current one. */
export const PROXY_VERSION = "0.34.0";
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
/**
 * Where a request goes. The endpoints we optimize are fixed; EVERY other path
 * is forwarded untouched, because a client routed through the proxy (Claude
 * Code under autopilot, an SDK) also lists models, uploads files, counts
 * tokens. Until 0.24 those got a 404 and broke the feature for that client.
 * Unknown paths go to Anthropic when the request says it is one (Anthropic
 * clients always send anthropic-version, or x-api-key; OAuth calls send
 * anthropic-beta; Anthropic keys and tokens start sk-ant-), else to OpenAI.
 * Under autopilot the default flips: Claude Code is the client it is
 * installed for, and a Bearer-only request from it (its OAuth token) sent to
 * OpenAI would hand an Anthropic credential to another company. There only a
 * request carrying an OpenAI-style key (sk-..., not sk-ant-...) goes to OpenAI.
 * Google's Gemini API (GOOGLE_GEMINI_BASE_URL) is recognised by its key
 * header, its /v1beta paths, or a `model:method` path such as
 * /v1/models/gemini-3-pro:generateContent.
 */
export function upstreamFor(url, opts, headers = {}) {
    const anthropic = opts.anthropicUpstream ?? "https://api.anthropic.com";
    const openai = opts.openaiUpstream ?? "https://api.openai.com";
    if (isGeminiRequest(url, headers))
        return opts.googleUpstream ?? "https://generativelanguage.googleapis.com";
    if (url.startsWith("/v1/messages"))
        return anthropic;
    if (url.startsWith("/v1/chat/completions") || url.startsWith("/v1/responses") || url.startsWith("/v1/embeddings"))
        return openai;
    const auth = headers.authorization;
    const bearer = typeof auth === "string" ? /^Bearer\s+(\S+)/i.exec(auth)?.[1] : undefined;
    if (headers["anthropic-version"] !== undefined || headers["x-api-key"] !== undefined || headers["anthropic-beta"] !== undefined || bearer?.startsWith("sk-ant-")) {
        return anthropic;
    }
    if (opts.autopilot)
        return bearer?.startsWith("sk-") ? openai : anthropic;
    return openai;
}
export function isGeminiRequest(url, headers = {}) {
    return (headers["x-goog-api-key"] !== undefined ||
        /^\/(upload\/)?v1(beta|alpha)\d*\//.test(url) ||
        /^\/v1\/[^?]*:(generateContent|streamGenerateContent|countTokens|embedContent|batchEmbedContents)/.test(url));
}
/** The model a Gemini request names in its path (…/models/<model>:generateContent). */
export function geminiModelFromUrl(url) {
    return /\/models\/([^/:?]+):/.exec(url)?.[1];
}
const GEMINI_CONVERSATION = /\/models\/[^/:?]+:(generateContent|streamGenerateContent)(\?|$)/;
/** Pull exact usage out of a response body — JSON or SSE, either provider. */
function extractUsage(text) {
    const last = (re) => {
        let m;
        let v = -1;
        while ((m = re.exec(text)) !== null)
            v = Number(m[1]);
        return v;
    };
    const input = Math.max(last(/"input_tokens"\s*:\s*(\d+)/g), last(/"prompt_tokens"\s*:\s*(\d+)/g), last(/"promptTokenCount"\s*:\s*(\d+)/g));
    const output = Math.max(last(/"output_tokens"\s*:\s*(\d+)/g), last(/"completion_tokens"\s*:\s*(\d+)/g), last(/"candidatesTokenCount"\s*:\s*(\d+)/g));
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
/** Anthropic's 400 for a history whose thinking-block signatures no longer match it. */
const THINKING_EDIT_REJECTED = /bound to a different conversation|Invalid `signature` in `thinking` block/;
/**
 * Which account a request belongs to, as a salted hash of its credential: the
 * proxy remembers per account whether the API refuses edited history, and
 * never keeps the key itself.
 */
export function accountKey(headers) {
    const credential = headers["x-api-key"] ?? headers.authorization ?? "";
    return createHash("sha256").update(`context-doctor account\0${String(credential)}`).digest("hex").slice(0, 16);
}
/** Whether an Anthropic request's answer may hold thinking blocks: asked for, or a 5.x model, which thinks unless told not to. */
function mayProduceThinking(body) {
    const type = body.thinking?.type;
    if (type === "disabled")
        return false;
    if (type !== undefined)
        return true;
    return /fable|mythos|(opus|sonnet|haiku)-([5-9]|\d\d)/i.test(String(body.model ?? ""));
}
/**
 * For an account that refuses edited history: would sending the optimizer's
 * `edited` body instead of `original` break a thinking signature? It does
 * when a thinking block sits at or after the first changed message, and the
 * stateless optimizer also stays out when the answer may hold thinking: that
 * thinking would be bound to this edit, and nothing guarantees the next
 * request gets the identical edit.
 */
function editBreaksThinking(original, edited) {
    const before = Array.isArray(original.messages) ? original.messages : [];
    const afterMsgs = edited?.messages;
    const after = Array.isArray(afterMsgs) ? afterMsgs : [];
    let first = 0;
    while (first < before.length && first < after.length && JSON.stringify(before[first]) === JSON.stringify(after[first]))
        first++;
    return thinkingAfter(before, first) || mayProduceThinking(original);
}
/**
 * How long a stopping proxy waits for requests in flight. Under launchd's
 * default 20 s exit timeout, so the proxy exits on its own terms rather than
 * by SIGKILL.
 */
const DRAIN_MS = 15_000;
/** Each running proxy's drain, so one signal stops them all. */
const liveServers = new Set();
let signalsInstalled = false;
let stopping = false;
function installSignalHandlers() {
    if (signalsInstalled)
        return;
    signalsInstalled = true;
    const stop = () => {
        if (stopping)
            process.exit(0); // a second Ctrl-C: stop now
        stopping = true;
        void Promise.all([...liveServers].map((d) => d().catch(() => undefined))).finally(() => process.exit(0));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
}
export function startProxy(opts = {}) {
    const port = opts.port ?? 8787;
    // A conversation with no record (first seen since a restart, or evicted) is
    // treated as warm: the state file keeps each conversation's last request
    // time, and without one, clearing could rewrite a cache that is still warm.
    const clearer = opts.autopilot ? new AutoClearer({ statePath: opts.autopilotStatePath, unseenIsWarm: true }) : undefined;
    // Accounts whose API refused an edited history: autopilot keeps them in its
    // state file, the optimizing proxy (which has none) for its lifetime.
    const refusing = new Set();
    const rejectsEdits = (account) => (clearer ? clearer.rejectsEdits(account) : refusing.has(account));
    const noteEditsRejected = (account) => {
        if (clearer)
            clearer.noteEditsRejected(account);
        else
            refusing.add(account);
    };
    const openaiBase = opts.openaiUpstream ?? "https://api.openai.com";
    const keyEnv = process.env.CONTEXT_DOCTOR_CACHE_KEY;
    const addCacheKeys = opts.promptCacheKey ?? (keyEnv === "0" ? false : keyEnv === "1" ? true : /^https:\/\/api\.openai\.com\/?$/.test(openaiBase));
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
        openaiCachedTokens: 0,
        cacheKeysAdded: 0,
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
    /** Requests still being answered, so a shutdown can let them finish. */
    let inFlight = 0;
    const server = http.createServer(async (req, res) => {
        let url = req.url ?? "/";
        inFlight++;
        // A client that goes away (Ctrl-C, an SDK timeout) must take its upstream
        // request with it: without this, a stream the client abandoned at 0.1 s
        // kept running upstream to the end (3 s in the test, minutes of output
        // tokens on a real one).
        const upstreamAbort = new AbortController();
        res.on("close", () => {
            inFlight--;
            if (!res.writableFinished)
                upstreamAbort.abort();
        });
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
            // Codex signed in with ChatGPT, reading a config.toml whose
            // openai_base_url points here (the ChatGPT app's Codex tab shares
            // ~/.codex with a CLI on an API key): without its address it would
            // talk to ChatGPT's Codex backend, so it is relayed there byte for
            // byte. Its path loses the /v1 the OpenAI routes carry, and no rule
            // below matches it: it is never edited.
            const chatgpt = typeof req.headers["chatgpt-account-id"] === "string" && url.startsWith("/v1/");
            if (chatgpt)
                url = url.slice(3);
            const upstreamBase = chatgpt ? (opts.chatgptUpstream ?? "https://chatgpt.com/backend-api/codex") : upstreamFor(url, opts, req.headers);
            if (!upstreamBase) {
                res.statusCode = 404;
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ error: `context-doctor proxy: unsupported path ${url} (supported: /v1/messages, /v1/chat/completions, /v1/responses)` }));
                return;
            }
            const chunks = [];
            for await (const chunk of req)
                chunks.push(chunk);
            // Keep the original bytes: only conversation JSON is ever rewritten, and
            // anything else (a multipart file upload) must reach upstream byte for
            // byte. Decoding everything as UTF-8 corrupted binary bodies.
            const rawBody = Buffer.concat(chunks);
            let body = rawBody.toString("utf8");
            const originalBody = body;
            const conversationPath = /^\/v1\/(messages|chat\/completions|responses)(\?|$)/.test(url);
            // Optimize the message history in flight. Anything unparseable (or with
            // no messages array, e.g. embeddings) passes through untouched.
            // count_tokens is measurement — optimizing it would silently change the
            // number the caller is trying to read, so it always passes through.
            stats.requests++;
            const isMeasurement = url.startsWith("/v1/messages/count_tokens");
            let note = "passthrough";
            const account = accountKey(req.headers);
            /** Takes back what this request's edit added to the stats and to autopilot's memory, when the edit is refused. */
            let undoEdit;
            if (opts.autopilot) {
                const gemini = GEMINI_CONVERSATION.test(url);
                if (req.method === "POST" && body && !isMeasurement && (gemini || /^\/v1\/(messages|chat\/completions|responses)(\?|$)/.test(url))) {
                    const ap = stats.autopilot;
                    ap.paused = Boolean(opts.autopilotPauseFile && existsSync(opts.autopilotPauseFile));
                    if (ap.paused) {
                        note = "autopilot paused";
                    }
                    else {
                        try {
                            const parsed = JSON.parse(body);
                            const urlModel = gemini ? geminiModelFromUrl(url) : undefined;
                            const r = clearer.apply(parsed, Date.now(), urlModel, account);
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
                                const pricing = pricingFor(typeof parsed.model === "string" ? parsed.model : urlModel);
                                // What autopilot removes would mostly have been cached reads: price it so.
                                const usd = pricing ? (r.tokensRemoved / 1e6) * pricing.cacheReadPerM : 0;
                                stats.estUsdSaved += usd;
                                undoEdit = (originalAccepted) => {
                                    if (r.newlyCleared > 0) {
                                        ap.batches--;
                                        ap.resultsCleared -= r.newlyCleared;
                                        if (r.cold)
                                            ap.coldBatches--;
                                    }
                                    ap.changedRequests--;
                                    ap.tokensRemoved -= r.tokensRemoved;
                                    stats.optimizedRequests--;
                                    stats.tokensSaved -= r.tokensRemoved;
                                    stats.estUsdSaved -= usd;
                                    // Accepted unedited: the newest thinking is bound to the full
                                    // history, so none of these clearings may be sent again.
                                    // Refused unedited as well: the earlier clearings are what
                                    // older thinking is bound to; only this request's new ones
                                    // never reached the model.
                                    clearer.forget(originalAccepted ? r.appliedIds : r.newIds, r.conversation);
                                };
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
            else if (req.method === "POST" && body && !isMeasurement && conversationPath) {
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
                            // Anthropic will not cache a prefix under the model's minimum (512 to
                            // 4,096 tokens, cacheplan.ts); below that the advice is useless.
                            const minCacheable = minCacheableTokens(requestModel);
                            if (stablePrefixTokens >= minCacheable && !hasBreakpoint) {
                                // Say WHERE, not just that. A breakpoint caches everything up
                                // to and including the block it sits on, so it belongs on the
                                // LAST stable block: the final tool definition if there are
                                // tools, otherwise the final system block.
                                const where = Array.isArray(parsedBody.tools) && parsedBody.tools.length > 0
                                    ? `the last entry in "tools" (tools come before system in the cached prefix)`
                                    : `the last block of "system"`;
                                advise(`~${stablePrefixTokens}+ tokens of stable system/tools on ${requestModel} without cache_control. ` +
                                    `Add {"cache_control":{"type":"ephemeral"}} to ${where}; everything before it then bills at the cache-read rate (2.5-10% of input) on every call`);
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
                                    if (stableTokens >= minCacheable) {
                                        advise(`messages #0-#${stable - 1} (~${stableTokens} tokens) were identical to the previous ${requestModel} request and carry no cache_control. ` +
                                            `Simplest: a top-level "cache_control":{"type":"ephemeral"} (automatic caching marks the last block and moves it forward each turn); ` +
                                            `or put {"cache_control":{"type":"ephemeral"}} on the last content block of message #${stable - 1}. That run then reads from cache instead of re-billing each turn`);
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
                    const original = JSON.parse(originalBody);
                    stats.tokensBefore += result.tokensBefore;
                    if (saved > 0 && (rejectsEdits(account) || optsIntoThinkingCheck(original)) && editBreaksThinking(original, result.conversation)) {
                        stats.tokensAfter += result.tokensBefore;
                        note = "unchanged: thinking blocks are bound to this history and this account rejects edits to it";
                    }
                    else {
                        stats.tokensAfter += result.tokensAfter;
                        if (saved > 0) {
                            body = JSON.stringify(result.conversation);
                            stats.optimizedRequests++;
                            stats.tokensSaved += saved;
                            const pricing = pricingFor(result.conversation?.model);
                            const usd = pricing ? inputCostUsd(saved, pricing) : 0;
                            stats.estUsdSaved += usd;
                            undoEdit = () => {
                                stats.optimizedRequests--;
                                stats.tokensSaved -= saved;
                                stats.tokensAfter += saved;
                                stats.estUsdSaved -= usd;
                            };
                        }
                        note = saved > 0
                            ? `optimized ${formatTokens(result.tokensBefore)} → ${formatTokens(result.tokensAfter)} tokens (${result.applied.length} changes)`
                            : "clean (nothing to save)";
                    }
                }
                catch {
                    /* not a conversation payload — forward as-is */
                }
            }
            // A stable prompt_cache_key per conversation, where the app sent none
            // and the model routes by it (GPT before 5.6): its requests then land
            // on one cache. Added after autopilot, so its view of the conversation
            // is the app's own.
            if (addCacheKeys && !chatgpt && req.method === "POST" && body && /^\/v1\/(chat\/completions|responses)(\?|$)/.test(url) && upstreamBase === openaiBase) {
                const keyed = withPromptCacheKey(body);
                if (keyed) {
                    body = keyed.body;
                    stats.cacheKeysAdded++;
                    note += `; prompt_cache_key ${keyed.key.slice(0, 11)}…`;
                }
            }
            const headers = {};
            for (const [key, value] of Object.entries(req.headers)) {
                if (!SKIP_REQUEST_HEADERS.has(key.toLowerCase()) && typeof value === "string")
                    headers[key] = value;
            }
            const upstreamStart = Date.now();
            const send = (payload) => fetch(upstreamBase + url, {
                method: req.method ?? "POST",
                headers,
                body: req.method === "GET" || req.method === "HEAD" ? undefined : payload,
                signal: upstreamAbort.signal,
            });
            const edited = body !== originalBody;
            let upstream = await send(edited ? body : rawBody);
            // An edited history can be refused because thinking blocks are bound to
            // the history as it was (thinkingAfter); the 400 comes before any
            // output, and the same body fails again on retry. Send the client's own
            // body once instead and return that answer as if nothing happened, and
            // remember that this account refuses edits, so it is not asked again.
            if (edited && upstream.status === 400) {
                const text = await upstream.text();
                if (THINKING_EDIT_REJECTED.test(text)) {
                    upstream = await send(rawBody);
                    // A bad signature with no word on the conversation is not ours to
                    // learn from, unless the unedited body then went through.
                    if (/bound to a different conversation/.test(text) || upstream.ok)
                        noteEditsRejected(account);
                    undoEdit?.(upstream.ok);
                    note = `edited history refused (thinking blocks are bound to it); resent unedited → ${upstream.status}`;
                }
                else {
                    upstream = new Response(text, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
                }
            }
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
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done)
                            break;
                        res.write(value);
                        if (scanBuf.length < USAGE_SCAN_CAP)
                            scanBuf += decoder.decode(value, { stream: true });
                    }
                }
                catch (e) {
                    reader.cancel().catch(() => undefined);
                    throw e;
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
                    stats.openaiCachedTokens += lastNum(/"cached_tokens"\s*:\s*(\d+)/g);
                }
            }
            res.end();
        }
        catch (e) {
            if (upstreamAbort.signal.aborted) {
                console.error(`[context-doctor] ${req.method} ${url}: client went away; upstream request cancelled`);
                res.destroy();
                return;
            }
            console.error(`[context-doctor] error on ${url}: ${e.message}`);
            if (res.headersSent) {
                // Upstream failed mid-body. Status and part of the body are already
                // with the client; appending a JSON error and ending cleanly made a
                // truncated stream look complete (a 200 whose SSE just stops). Cut
                // the connection instead, so the client sees the failure and retries.
                res.destroy(e);
                return;
            }
            res.statusCode = 502;
            res.setHeader("content-type", "application/json");
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
        clearer?.flush();
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
    // Stop: no new connections, let requests in flight finish (a streamed
    // answer is usually done within seconds), then save. Exiting on the signal
    // cut every open stream, and a service restart (launchd's kickstart -k
    // after an update) sends exactly that signal.
    const drain = async () => {
        checkpoint();
        server.close();
        server.closeIdleConnections?.();
        const end = Date.now() + DRAIN_MS;
        while (inFlight > 0 && Date.now() < end)
            await new Promise((r) => setTimeout(r, 50));
        checkpoint();
    };
    liveServers.add(drain);
    installSignalHandlers();
    // A WebSocket upgrade cannot be relayed (or edited) here. Codex tries
    // Responses over WebSocket first and, on anything but 426, retries five
    // times (~15 s) before it falls back to HTTP; 426 Upgrade Required makes it
    // switch to HTTP for the session at once (codex-rs core/src/client.rs).
    // Answered on the raw socket, which is then closed: handled as an ordinary
    // request, the upgrade left the connection in a state where the client's
    // next request on it never got an answer.
    server.on("upgrade", (_req, socket) => {
        const body = JSON.stringify({ error: "context-doctor proxy: WebSocket transport is not supported here; send the request over HTTP" });
        socket.on("error", () => { });
        socket.end(`HTTP/1.1 426 Upgrade Required\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
    server.on("close", () => {
        liveServers.delete(drain);
        checkpoint();
    });
    const host = opts.host ?? "127.0.0.1";
    // A port already in use was an unhandled 'error' event: a crash with a
    // stack trace, which launchd (KeepAlive) restarted into the same error
    // every 5 s, 45 times in one real log, while a second proxy held the port.
    // One clear line instead, and exit 0 when a context-doctor proxy already
    // serves the port (traffic flows; a service that restarts only on failure
    // stays down), 1 when something else holds it. An app that embeds
    // startProxy and handles 'error' itself keeps that decision.
    server.on("error", (e) => {
        if (server.listenerCount("error") > 1)
            return;
        if (e.code !== "EADDRINUSE") {
            console.error(`context-doctor proxy: cannot listen on ${host}:${port}: ${e.message}`);
            process.exit(1);
        }
        const probe = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
        fetch(`http://${probe}:${port}/health`, { signal: AbortSignal.timeout(2000) })
            .then((r) => r.json())
            .catch(() => undefined)
            .then((h) => {
            if (h?.service === "context-doctor-proxy") {
                console.error(`context-doctor proxy: port ${port} is already served by a context-doctor proxy (v${h.version ?? "?"}); this one exits.`);
                process.exit(0);
            }
            console.error(`context-doctor proxy: port ${port} on ${host} is in use by another program; exiting.`);
            process.exit(1);
        });
    });
    server.listen(port, host, () => {
        // Print the token as <token>, never the value: this log is what people paste into bug reports.
        const prefix = opts.token ? "/t/<token>" : "";
        console.error(`context-doctor proxy listening on http://${host}:${port}`);
        console.error(`  Anthropic apps/SDKs: export ANTHROPIC_BASE_URL=http://localhost:${port}${prefix}`);
        console.error(`  OpenAI apps/SDKs:    export OPENAI_BASE_URL=http://localhost:${port}${prefix}/v1`);
        console.error(opts.autopilot
            ? `  Autopilot: stale re-runnable tool output is cleared only when the prompt cache is cold; savings are logged here.`
            : `  Every request's context is optimized in flight; savings are logged here.`);
        console.error(`  Cumulative savings: http://localhost:${port}${prefix}/stats`);
        if (opts.token) {
            console.error(`  Token required: every path except /health must start with /t/<token>/.`);
            console.error(`  Cursor with your own OpenAI key: expose this port on HTTPS (a tunnel), then Settings > Models > OpenAI API Key >`);
            console.error(`  "Override OpenAI Base URL" = https://<your-host>/t/<token>/v1. Cursor's servers call that URL, so 127.0.0.1 will not work there.`);
        }
    });
    return server;
}
