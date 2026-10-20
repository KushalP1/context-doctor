/**
 * `context-doctor cache-misses`: requests that re-wrote the prompt cache while
 * it should still have been warm.
 *
 * Claude Code caches the conversation as it goes; the next request within the
 * cache's lifetime reads that prefix at the cache-read rate (5-10% of input)
 * and writes only what is new. When a request instead writes most of the
 * context again, at 1.25x input (2x at the 1-hour TTL), the cache missed.
 * Some misses are expected (a model switch: each model has its own cache;
 * a compaction: a new history), the rest are invisible from the client.
 *
 * Definition, request by request over each main-chain transcript:
 *  - two consecutive requests (sidechains and synthetic replies skipped),
 *    with no compaction (compact_boundary) between them;
 *  - the gap under the cache lifetime of both: 1 hour when the request wrote
 *    to the 1-hour cache (usage.cache_creation.ephemeral_1h_input_tokens > 0),
 *    else 5 minutes;
 *  - the previous request's context over 20k tokens (smaller ones are noise);
 *  - a miss when the request's cache_creation_input_tokens exceed 60% of the
 *    previous request's whole context (input + cache read + cache write).
 *
 * Priced above what the same tokens would have cost as cache reads: the
 * re-written part (up to the previous context) at the write rate minus the
 * read rate. Measured on the author's last 30 days (Oct 2026): 390 misses in
 * 29,287 requests, ~$1,925 above cache-read price, 28% of all cache-write
 * spend; 382 of them with nothing in the transcript to explain them.
 */
import { forEachLine, listSessions } from "./session.js";
import { formatTokens, realModel } from "./tokens.js";
import { CACHE_WRITE_1H, CACHE_WRITE_5M, pricingFor } from "./pricing.js";
/** Dollars as a person reads them: "$1,925", "$12.26", "$0". */
function money(n) {
    if (!(n > 0))
        return "$0";
    if (n >= 100)
        return `$${Math.round(n).toLocaleString("en-US")}`;
    if (n >= 0.01)
        return `$${n.toFixed(2)}`;
    return "<$0.01";
}
const FIVE_MIN = 300_000;
const HOUR = 3_600_000;
/** Below this the previous context is too small for a miss to matter (or to be told from noise). */
const MIN_CONTEXT = 20_000;
/** A request that writes more than this share of the previous context re-wrote it. */
const MISS_SHARE = 0.6;
/** Anthropic's cache looks back at most this many blocks from a breakpoint for an earlier hit. */
const LOOKBACK_BLOCKS = 20;
const SIZE_BUCKETS = [["<100k", 100_000], ["100-300k", 300_000], ["300-600k", 600_000], ["600k+", Infinity]];
const bucketOf = (tokens) => SIZE_BUCKETS.find(([, max]) => tokens < max)[0];
const num = (x) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);
/** Misses in one transcript; `since` drops requests before it. */
export function missesInTranscript(path, since = 0, add = () => { }, onRequest = () => { }) {
    let prev;
    let lastId;
    let compacted = false;
    let apiError = false;
    let blocks = 0;
    let edited = false;
    forEachLine(path, (line) => {
        // Cheap row counting without a parse: Claude Code writes one row per
        // content block, so main-chain rows since the last request are the blocks
        // it added (what the 20-block lookback counts).
        const usage = line.includes('"usage"');
        if (!usage && !line.includes("compact_boundary") && !line.includes("api_error")) {
            if ((line.includes('"type":"user"') || line.includes('"type":"assistant"')) && !line.includes('"isSidechain":true'))
                blocks++;
            return;
        }
        let e;
        try {
            e = JSON.parse(line);
        }
        catch {
            return;
        }
        if (!e || typeof e !== "object" || e.isSidechain)
            return;
        if (e.type === "system" && e.subtype === "compact_boundary") {
            compacted = true;
            return;
        }
        if (e.type === "system" && e.subtype === "api_error") {
            apiError = true;
            return;
        }
        if (e.type === "user" || e.type === "assistant")
            blocks++;
        const msg = e.message;
        if (e.type !== "assistant" || !msg?.usage)
            return;
        // One reply is written as several rows sharing its id and usage: count it once.
        if (typeof msg.id === "string" && msg.id === lastId)
            return;
        lastId = typeof msg.id === "string" ? msg.id : undefined;
        const model = realModel(msg.model);
        if (!model)
            return;
        const at = Date.parse(String(e.timestamp ?? ""));
        if (!Number.isFinite(at))
            return;
        const u = msg.usage;
        const write = num(u.cache_creation_input_tokens);
        const read = num(u.cache_read_input_tokens);
        const total = write + read + num(u.input_tokens);
        const oneHour = num(u.cache_creation?.ephemeral_1h_input_tokens) > 0;
        const ttl = oneHour ? HOUR : FIVE_MIN;
        const cm = u.context_management ?? msg.context_management;
        const cmText = cm ? JSON.stringify(cm) : "";
        if (cmText.includes("applied") && !/"applied_edits"\s*:\s*\[\s*\]/.test(cmText))
            edited = true;
        if (at >= since) {
            const price = pricingFor(model);
            if (price)
                onRequest((write * price.inputPerM * (oneHour ? CACHE_WRITE_1H : CACHE_WRITE_5M)) / 1e6);
            if (prev && !compacted && at - prev.at < Math.min(ttl, prev.ttl) && prev.total > MIN_CONTEXT) {
                const isMiss = write > MISS_SHARE * prev.total;
                let miss;
                if (isMiss) {
                    const cause = prev.model !== model ? "model switch"
                        : edited ? "context edited"
                            : apiError ? "after an API error"
                                : blocks > LOOKBACK_BLOCKS ? "over 20 new blocks"
                                    : "nothing visible";
                    miss = {
                        path,
                        at: new Date(at).toISOString(),
                        model,
                        previousModel: prev.model,
                        contextTokens: prev.total,
                        writeTokens: write,
                        readShare: prev.total > 0 ? read / prev.total : 0,
                        gapSeconds: Math.round((at - prev.at) / 1000),
                        cause,
                        extraUsd: price ? (Math.min(write, prev.total) * (price.inputPerM * (oneHour ? CACHE_WRITE_1H : CACHE_WRITE_5M) - price.cacheReadPerM)) / 1e6 : undefined,
                    };
                }
                add({ model, contextTokens: prev.total }, miss);
            }
        }
        prev = { at, total, model, ttl };
        compacted = false;
        apiError = false;
        edited = false;
        blocks = 0;
    });
}
/** Two rates differ beyond chance (two-proportion z-test, 99%). */
function differs(a, b) {
    const p = (a.misses + b.misses) / (a.eligible + b.eligible);
    if (p <= 0 || p >= 1)
        return false;
    const se = Math.sqrt(p * (1 - p) * (1 / a.eligible + 1 / b.eligible));
    return Math.abs(a.rate - b.rate) > 2.58 * se;
}
/** Enough requests for a model's rate to mean something. */
const MIN_ELIGIBLE = 100;
const pct = (x) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;
/** "claude-opus-5-5" → "opus": versions of one family are compared with each other. */
function family(model) {
    return /(opus|sonnet|haiku|fable|mythos)/i.exec(model)?.[1]?.toLowerCase();
}
function recommend(byModel, bySize) {
    const out = [];
    const solid = byModel.filter((m) => m.eligible >= MIN_ELIGIBLE);
    // Within a family: the version that misses least, where another misses
    // significantly more. Same capabilities class, so a fair swap to suggest.
    const families = new Map();
    for (const m of solid) {
        const f = family(m.model);
        if (f)
            families.set(f, [...(families.get(f) ?? []), m]);
    }
    for (const [f, models] of families) {
        if (models.length < 2)
            continue;
        const best = [...models].sort((a, b) => a.rate - b.rate)[0];
        const worse = models.filter((m) => m !== best && m.misses >= 5 && m.rate > best.rate * 2 && differs(m, best));
        if (worse.length === 0)
            continue;
        const name = f[0].toUpperCase() + f.slice(1);
        out.push(`${name}: ${best.model} missed on ${pct(best.rate)} of warm requests; ` +
            worse.map((m) => `${m.model} on ${pct(m.rate)} (${m.misses} misses, ${money(m.extraUsd)})`).join(", ") +
            `. Prefer ${best.model} where you choose the ${name} version.`);
    }
    // Across your models: the outlier, when it is one beyond chance.
    if (solid.length >= 2) {
        const sorted = [...solid].sort((a, b) => b.rate - a.rate);
        const worst = sorted[0];
        const rest = sorted.slice(1);
        const pooled = rest.reduce((s, m) => ({ eligible: s.eligible + m.eligible, misses: s.misses + m.misses }), { eligible: 0, misses: 0 });
        const others = { ...pooled, rate: pooled.eligible ? pooled.misses / pooled.eligible : 0, extraUsd: 0 };
        if (worst.misses >= 10 && worst.rate > others.rate * 3 && differs(worst, others) && !out.some((l) => l.includes(`${worst.model} on`))) {
            out.push(`${worst.model} misses most: ${pct(worst.rate)} of its warm requests (${worst.misses} of ${worst.eligible}, ${money(worst.extraUsd)}), ` +
                `against ${pct(others.rate)} on your other models. Where another model would do, it re-writes the cache less.`);
        }
    }
    // Context size: misses grow with the context, and each costs more there.
    const small = bySize.filter((b) => b.bucket === "<100k" || b.bucket === "100-300k");
    const large = bySize.filter((b) => b.bucket === "300-600k" || b.bucket === "600k+");
    const sum = (bs) => {
        const eligible = bs.reduce((n, b) => n + b.eligible, 0);
        const misses = bs.reduce((n, b) => n + b.misses, 0);
        return { eligible, misses, rate: eligible ? misses / eligible : 0, extraUsd: bs.reduce((n, b) => n + b.extraUsd, 0) };
    };
    const s = sum(small), l = sum(large);
    if (s.eligible >= MIN_ELIGIBLE && l.eligible >= MIN_ELIGIBLE && l.misses >= 10 && l.rate > s.rate * 1.5 && differs(l, s)) {
        out.push(`Above 300k tokens of context the cache missed ${(l.rate / Math.max(s.rate, 1e-9)).toFixed(1)}x as often (${pct(l.rate)} vs ${pct(s.rate)}), ` +
            `and each miss there re-writes more: compacting earlier cuts both (context-doctor compact-window).`);
    }
    return out;
}
export function cacheMisses(days = 30, paths, onProgress) {
    const since = Date.now() - days * 86_400_000;
    // Claude Code transcripts: they record the API's cache usage per request.
    const targets = paths ?? listSessions(10_000).filter((s) => s.path.includes(".claude") && s.modifiedAt.getTime() >= since).map((s) => s.path);
    const models = new Map();
    const sizes = new Map();
    const causes = { "model switch": 0, "context edited": 0, "after an API error": 0, "over 20 new blocks": 0, "nothing visible": 0 };
    const all = [];
    let requests = 0, eligible = 0, cacheWriteUsd = 0;
    const bump = (map, key, miss) => {
        const s = map.get(key) ?? { eligible: 0, misses: 0, rate: 0, extraUsd: 0 };
        s.eligible++;
        if (miss) {
            s.misses++;
            s.extraUsd += miss.extraUsd ?? 0;
        }
        map.set(key, s);
    };
    for (const [i, p] of targets.entries()) {
        onProgress?.(i, targets.length);
        try {
            missesInTranscript(p, since, (e, miss) => {
                eligible++;
                bump(models, e.model, miss);
                bump(sizes, bucketOf(e.contextTokens), miss);
                if (miss) {
                    all.push(miss);
                    causes[miss.cause]++;
                }
            }, (writeUsd) => {
                requests++;
                cacheWriteUsd += writeUsd;
            });
        }
        catch {
            /* one unreadable transcript must not sink the report */
        }
    }
    onProgress?.(targets.length, targets.length);
    const finish = (s) => ({ ...s, rate: s.eligible ? s.misses / s.eligible : 0 });
    const byModel = [...models.entries()].map(([model, s]) => ({ model, ...finish(s) })).sort((a, b) => b.rate - a.rate);
    const bySize = SIZE_BUCKETS.filter(([b]) => sizes.has(b)).map(([bucket]) => ({ bucket, ...finish(sizes.get(bucket)) }));
    return {
        days,
        transcripts: targets.length,
        requests,
        eligible,
        misses: all.length,
        missWriteTokens: all.reduce((n, m) => n + m.writeTokens, 0),
        extraUsd: all.reduce((n, m) => n + (m.extraUsd ?? 0), 0),
        cacheWriteUsd,
        unpricedMisses: all.filter((m) => m.extraUsd === undefined).length,
        byModel,
        bySize,
        causes,
        recommendations: recommend(byModel, bySize),
        largest: [...all].sort((a, b) => (b.extraUsd ?? 0) - (a.extraUsd ?? 0) || b.writeTokens - a.writeTokens).slice(0, 10),
    };
}
/** Worth a line in `savings`: enough misses, and enough money, to act on. */
export function cacheMissesSignificant(r) {
    return r.misses >= 10 && r.extraUsd >= 5;
}
/** The one line `savings` adds when the misses are significant. */
export function cacheMissesLine(r) {
    const share = r.cacheWriteUsd > 0 ? ` (${Math.round((r.extraUsd / r.cacheWriteUsd) * 100)}% of cache writes)` : "";
    // Within the 60 columns the rest of `savings` keeps to.
    return [
        `Also: ${r.misses} cache misses within the cache lifetime cost ${money(r.extraUsd)}`,
        `above cache-read price${share}. By model and`,
        "context size: context-doctor cache-misses",
    ];
}
export function renderCacheMisses(r) {
    const out = ["CACHE MISSES WITHIN THE CACHE LIFETIME", "═".repeat(60)];
    if (r.eligible === 0) {
        out.push(`No Claude Code requests in the last ${r.days} days that could have read a warm cache (consecutive, within the cache lifetime, over 20k tokens).`);
        return out.join("\n");
    }
    const share = r.cacheWriteUsd > 0 ? ` (${Math.round((r.extraUsd / r.cacheWriteUsd) * 100)}% of your ${money(r.cacheWriteUsd)} of cache writes)` : "";
    out.push(`Last ${r.days} days, ${r.transcripts} transcripts, ${r.requests.toLocaleString("en-US")} requests.`, `${r.misses} of ${r.eligible.toLocaleString("en-US")} warm requests (${pct(r.misses / r.eligible)}) re-wrote the cache instead of reading it:`, `~${formatTokens(r.missWriteTokens)} tokens written again, ${money(r.extraUsd)} above cache-read price${share}.` +
        (r.unpricedMisses ? ` ${r.unpricedMisses} on unpriced models not included.` : ""), "", `  ${"model".padEnd(24)} ${"misses".padStart(14)} ${"rate".padStart(7)} ${"cost".padStart(9)}`);
    for (const m of r.byModel) {
        out.push(`  ${m.model.slice(0, 24).padEnd(24)} ${`${m.misses}/${m.eligible}`.padStart(14)} ${pct(m.rate).padStart(7)} ${money(m.extraUsd).padStart(9)}`);
    }
    out.push("", `  ${"context before".padEnd(24)} ${"misses".padStart(14)} ${"rate".padStart(7)} ${"cost".padStart(9)}`);
    for (const b of r.bySize) {
        out.push(`  ${b.bucket.padEnd(24)} ${`${b.misses}/${b.eligible}`.padStart(14)} ${pct(b.rate).padStart(7)} ${money(b.extraUsd).padStart(9)}`);
    }
    const causes = Object.entries(r.causes).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    if (causes.length) {
        out.push("", "Cause, where the transcript shows one:");
        for (const [c, n] of causes)
            out.push(`  ${String(n).padStart(5)}  ${c}`);
        if (r.causes["nothing visible"] > 0) {
            out.push("  \"Nothing visible\": no model switch, compaction, context edit, API error or", "  long tool run before it. The system prompt, tools or memory changing, or the", "  provider evicting the cache early, would look like this from the client.");
        }
    }
    if (r.recommendations.length) {
        out.push("", "What the data supports:");
        for (const rec of r.recommendations)
            out.push(`  • ${rec}`);
    }
    if (r.largest.length) {
        out.push("", "Costliest:");
        for (const m of r.largest.slice(0, 5)) {
            const file = m.path.split(/[\\/]/).pop()?.slice(0, 12) ?? "";
            out.push(`  ${m.at.slice(0, 16).replace("T", " ")}  ${m.model.slice(0, 18).padEnd(18)} ~${formatTokens(m.contextTokens).padStart(5)} ctx, ${m.gapSeconds}s gap, ${m.cause}${m.extraUsd !== undefined ? `, ${money(m.extraUsd)}` : ""}  ${file}`);
        }
    }
    out.push("", "A miss: within the cache lifetime of both requests (5 min, or 1 h when written at", "the 1-hour TTL), no compaction between, previous context over 20k, and the request", "wrote over 60% of that context again. Model switches always miss: each model has", "its own cache.");
    return out.join("\n");
}
