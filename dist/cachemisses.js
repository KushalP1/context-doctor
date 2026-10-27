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
import { estimateTokens, formatTokens, realModel } from "./tokens.js";
import { CACHE_WRITE_1H, CACHE_WRITE_5M, pricingFor } from "./pricing.js";
import { compareVersions } from "./modelswitch.js";
import { diagnosedMisses, missLogPath } from "./missledger.js";
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
export function missesInTranscript(path, since = 0, add = () => { }, onRequest = () => { }, 
/** Shared by every transcript of one report: a fork's copied rows (same uuids) have no first request of their own. */
runRows) {
    let prev;
    let lastId;
    let compacted = false;
    let apiError = false;
    let blocks = 0;
    let edited = false;
    let firstUser;
    let started = false;
    forEachLine(path, (line) => {
        // Cheap row counting without a parse: Claude Code writes one row per
        // content block, so main-chain rows since the last request are the blocks
        // it added (what the 20-block lookback counts).
        const usage = line.includes('"usage"');
        if (!usage && !line.includes("compact_boundary") && !line.includes("api_error")) {
            if ((line.includes('"type":"user"') || line.includes('"type":"assistant"')) && !line.includes('"isSidechain":true')) {
                blocks++;
                // The first thing the user typed: part of the first request, not of the overhead.
                if (!started && firstUser === undefined && line.includes('"type":"user"') && !line.includes('"isMeta":true')) {
                    try {
                        const e = JSON.parse(line);
                        const c = e?.message?.content;
                        const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n") : "";
                        if (text)
                            firstUser = text;
                    }
                    catch {
                        /* not a row */
                    }
                }
            }
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
        const version = typeof e.version === "string" && /^\d+\.\d+\.\d+$/.test(e.version) ? e.version : undefined;
        // A transcript that opens with a parent's copied rows (a fork) has no
        // first request of its own: the parent's file holds the same uuid.
        const uuid = typeof e.uuid === "string" ? e.uuid : undefined;
        const copied = uuid !== undefined && runRows !== undefined && runRows.has(uuid);
        if (uuid !== undefined)
            runRows?.add(uuid);
        const first = !started && !copied ? Math.max(0, total - estimateTokens(firstUser ?? "", model)) : undefined;
        started = true;
        if (at >= since) {
            const price = pricingFor(model);
            const w1h = Math.min(write, num(u.cache_creation?.ephemeral_1h_input_tokens));
            const w5m = u.cache_creation ? Math.min(write - w1h, num(u.cache_creation?.ephemeral_5m_input_tokens)) : write - w1h;
            onRequest(price ? (write * price.inputPerM * (oneHour ? CACHE_WRITE_1H : CACHE_WRITE_5M)) / 1e6 : 0, { at, version, write, oneHour: w1h, fiveMinute: w5m, first, model, entrypoint: typeof e.entrypoint === "string" ? e.entrypoint.slice(0, 40) : undefined });
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
                add({ model, contextTokens: prev.total, version }, miss);
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
export function cacheMisses(days = 30, paths, onProgress, missLog = missLogPath()) {
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
    const versions = new Map();
    const versionOf = (v) => versions.get(v) ?? versions.set(v, { requests: 0, sessions: new Set(), firsts: [], writes: 0, oneHour: 0, fiveMinute: 0, eligible: 0, misses: 0, byModel: new Map(), ttlBy: new Map(), from: Infinity, to: 0 }).get(v);
    const runRows = new Set();
    for (const [i, p] of targets.entries()) {
        onProgress?.(i, targets.length);
        try {
            missesInTranscript(p, since, (e, miss) => {
                eligible++;
                bump(models, e.model, miss);
                bump(sizes, bucketOf(e.contextTokens), miss);
                if (e.version) {
                    const v = versionOf(e.version);
                    v.eligible++;
                    if (miss)
                        v.misses++;
                    const m = v.byModel.get(e.model) ?? v.byModel.set(e.model, { eligible: 0, misses: 0 }).get(e.model);
                    m.eligible++;
                    if (miss)
                        m.misses++;
                }
                if (miss) {
                    all.push(miss);
                    causes[miss.cause]++;
                }
            }, (writeUsd, info) => {
                requests++;
                cacheWriteUsd += writeUsd;
                if (!info.version)
                    return;
                const v = versionOf(info.version);
                v.requests++;
                v.sessions.add(p);
                v.writes += info.write;
                v.oneHour += info.oneHour;
                v.fiveMinute += info.fiveMinute;
                const key = `${info.model ?? "an unknown model"}${info.entrypoint ? ` in ${info.entrypoint}` : ""}`;
                const t = v.ttlBy.get(key) ?? v.ttlBy.set(key, { requests: 0, oneHour: 0, fiveMinute: 0 }).get(key);
                t.requests++;
                t.oneHour += info.oneHour;
                t.fiveMinute += info.fiveMinute;
                v.from = Math.min(v.from, info.at);
                v.to = Math.max(v.to, info.at);
                if (info.first !== undefined && info.first > 1000)
                    v.firsts.push(info.first);
            }, runRows);
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
        ...versionReport(versions),
        diagnosed: diagnosedMisses(since, missLog),
    };
}
const median = (xs) => {
    if (!xs.length)
        return undefined;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
};
/** Enough of a version to compare it: requests for rates and shares, new sessions for the first request. */
const MIN_VERSION_REQUESTS = 200;
const MIN_VERSION_FIRSTS = 5;
/**
 * Per version, oldest first, and the step changes between consecutive
 * versions with enough data (thin versions are skipped over, so a change
 * is credited to the first well-measured version after it):
 *  - the 1-hour share of cache writes moving by 30+ points (the TTL
 *    regressions users report after upgrades: 1 h to 5 min);
 *  - the median first request (fixed overhead) moving by 15% and 3k tokens;
 *  - one model's miss rate doubling (or halving), beyond chance at 99%,
 *    5+ misses, 100+ warm requests on each version.
 * Cache writes per request are shown, not flagged (they follow the work).
 */
export function versionReport(versions) {
    const byVersion = [...versions.entries()]
        .sort((a, b) => compareVersions(a[0], b[0]))
        .map(([version, v]) => ({
        version,
        requests: v.requests,
        sessions: v.sessions.size,
        firstRequests: v.firsts.length,
        firstMedian: median(v.firsts),
        writesPerRequest: v.requests ? v.writes / v.requests : 0,
        oneHourShare: v.oneHour + v.fiveMinute > 0 ? v.oneHour / (v.oneHour + v.fiveMinute) : undefined,
        eligible: v.eligible,
        misses: v.misses,
        missRate: v.eligible ? v.misses / v.eligible : 0,
        byModel: [...v.byModel.entries()].map(([model, m]) => ({ model, ...m })),
        ttlBy: [...v.ttlBy.entries()].map(([key, t]) => ({ key, requests: t.requests, oneHourShare: t.oneHour + t.fiveMinute > 0 ? t.oneHour / (t.oneHour + t.fiveMinute) : undefined })),
        from: Number.isFinite(v.from) ? new Date(v.from).toISOString() : "",
        to: v.to ? new Date(v.to).toISOString() : "",
    }));
    const regressions = [];
    const step = (metric, ok, value, changed, say) => {
        let prev;
        for (const v of byVersion) {
            if (!ok(v) || value(v) === undefined)
                continue;
            if (prev) {
                const x = value(prev), y = value(v);
                if (changed(prev, v, x, y))
                    regressions.push({ metric, from: prev.version, to: v.version, before: x, after: y, text: say(prev, v, x, y) });
            }
            prev = v;
        }
    };
    const share = (x) => `${Math.round(x * 100)}%`;
    // The 1-hour share, within one model on one surface (the desktop app and
    // the terminal, an API key and a subscription, can each pick the TTL):
    // the same model on the same surface, version against version.
    const groups = new Set(byVersion.flatMap((v) => v.ttlBy.map((t) => t.key)));
    for (const key of groups) {
        let prev;
        for (const v of byVersion) {
            const t = v.ttlBy.find((x) => x.key === key);
            if (!t || t.requests < MIN_VERSION_REQUESTS || t.oneHourShare === undefined)
                continue;
            if (prev && Math.abs(t.oneHourShare - prev.share) >= 0.3) {
                const x = prev.share, y = t.oneHourShare;
                regressions.push({
                    metric: "1-hour cache share",
                    from: prev.v.version,
                    to: v.version,
                    before: x,
                    after: y,
                    text: `On ${key}, cache writes at the 1-hour TTL went from ${share(x)} on ${prev.v.version} to ${share(y)} on ${v.version}: ${y < x ? "more of the cache now expires after 5 minutes, so a short pause re-writes it" : "the cache now survives pauses up to an hour"}.`,
                });
            }
            prev = { v, share: t.oneHourShare };
        }
    }
    step("first request", (v) => v.firstRequests >= MIN_VERSION_FIRSTS, (v) => v.firstMedian, (_a, _b, x, y) => Math.abs(y - x) >= Math.max(3000, 0.15 * x), (a, b, x, y) => `A new session's first request (the fixed overhead) went from ~${formatTokens(x)} on ${a.version} to ~${formatTokens(y)} on ${b.version} (median of ${a.firstRequests} and ${b.firstRequests} sessions; your CLAUDE.md, rules and MCP servers move it too: context-doctor overhead).`);
    // Miss rates: within one model, version against version, since a version's
    // overall rate mostly follows the models it ran (Sonnet 5 missed 10x as
    // often as Opus 5.5 on the author's machine).
    const models = new Set(byVersion.flatMap((v) => v.byModel.map((m) => m.model)));
    for (const model of models) {
        let prev;
        for (const v of byVersion) {
            const m = v.byModel.find((x) => x.model === model);
            if (!m || m.eligible < MIN_ELIGIBLE)
                continue;
            if (prev) {
                const a = prev.m, x = a.misses / a.eligible, y = m.misses / m.eligible;
                if (Math.max(a.misses, m.misses) >= 5 && (y >= 2 * x || x >= 2 * y) && differs({ ...a, rate: x, extraUsd: 0 }, { ...m, rate: y, extraUsd: 0 })) {
                    regressions.push({
                        metric: "miss rate",
                        from: prev.v.version,
                        to: v.version,
                        before: x,
                        after: y,
                        text: `On ${model} the cache missed on ${pct(y)} of warm requests with ${v.version}, against ${pct(x)} with ${prev.v.version} (${m.misses} of ${m.eligible}; ${a.misses} of ${a.eligible}).`,
                    });
                }
            }
            prev = { v, m };
        }
    }
    // Writes per request are in the table, not flagged: they follow the work
    // (a big file read writes a lot) as much as the version. Measured on the
    // author's history, 8 of 17 version-to-version "changes" were this alone.
    regressions.sort((a, b) => compareVersions(a.to, b.to));
    return { byVersion, regressions };
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
/** Words into lines of at most `width` characters. */
function wrap(text, width) {
    const lines = [];
    let line = "";
    for (const word of text.split(" ")) {
        if (line && line.length + 1 + word.length > width) {
            lines.push(line);
            line = word;
        }
        else
            line = line ? `${line} ${word}` : word;
    }
    if (line)
        lines.push(line);
    return lines;
}
/** Claude Code's own diagnosis, or how to start recording it. */
export function renderDiagnosed(d) {
    if (d.misses === 0) {
        return [
            "Why, in Claude Code's words: nothing recorded yet. Claude Code 2.1.260+ diagnoses",
            "each miss (tools changed, system prompt changed, idle past the TTL...) and tells",
            "the status line; `context-doctor install --statusline` records it for this report.",
        ];
    }
    const out = [
        `Why, in Claude Code's words (${d.misses} misses in ${d.sessions} session${d.sessions === 1 ? "" : "s"} since ${new Date(d.from ?? 0).toISOString().slice(0, 10)},`,
        `~${formatTokens(d.tokens)} tokens re-written, ${money(d.extraUsd)} above cache-read price; Claude Code also counts`,
        "a cache gone cold after a pause):",
    ];
    for (const c of d.byCause.slice(0, 8)) {
        out.push(`  ${String(c.misses).padStart(5)}  ${c.label.padEnd(38)} ${`~${formatTokens(c.tokens)}`.padStart(7)} ${money(c.extraUsd).padStart(9)}`);
        if (c.fix)
            out.push(...wrap(c.fix, 70).map((l) => `         ${l}`));
    }
    if (d.byCause.length > 8)
        out.push(`  (${d.byCause.length - 8} more causes in --json)`);
    return out;
}
export function renderCacheMisses(r, limitLines) {
    const out = ["CACHE MISSES WITHIN THE CACHE LIFETIME", "═".repeat(60)];
    if (r.eligible === 0) {
        out.push(`No Claude Code requests in the last ${r.days} days that could have read a warm cache (consecutive, within the cache lifetime, over 20k tokens).`);
        if (r.diagnosed.misses > 0)
            out.push("", ...renderDiagnosed(r.diagnosed));
        return out.join("\n");
    }
    const share = r.cacheWriteUsd > 0 ? ` (${Math.round((r.extraUsd / r.cacheWriteUsd) * 100)}% of your ${money(r.cacheWriteUsd)} of cache writes)` : "";
    out.push(`Last ${r.days} days, ${r.transcripts} transcripts, ${r.requests.toLocaleString("en-US")} requests.`, `${r.misses} of ${r.eligible.toLocaleString("en-US")} warm requests (${pct(r.misses / r.eligible)}) re-wrote the cache instead of reading it:`, `~${formatTokens(r.missWriteTokens)} tokens written again, ${money(r.extraUsd)} above cache-read price${share}.` +
        (r.unpricedMisses ? ` ${r.unpricedMisses} on unpriced models not included.` : ""), ...(limitLines?.length ? ["", ...limitLines] : []), "", `  ${"model".padEnd(24)} ${"misses".padStart(14)} ${"rate".padStart(7)} ${"cost".padStart(9)}`);
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
    out.push("", ...renderDiagnosed(r.diagnosed));
    const shown = r.byVersion.filter((v) => v.requests >= 50);
    if (shown.length >= 2) {
        out.push("", "By Claude Code version (versions with 50+ requests):", `  ${"version".padEnd(9)} ${"requests".padStart(8)} ${"1st req".padStart(8)} ${"writes/req".padStart(10)} ${"1h share".padStart(9)} ${"miss rate".padStart(10)}`);
        for (const v of shown.slice(-12)) {
            out.push(`  ${v.version.padEnd(9)} ${String(v.requests).padStart(8)} ${(v.firstMedian !== undefined ? `~${formatTokens(v.firstMedian)}` : "–").padStart(8)} ${`~${formatTokens(v.writesPerRequest)}`.padStart(10)} ${(v.oneHourShare !== undefined ? `${Math.round(v.oneHourShare * 100)}%` : "–").padStart(9)} ${(v.eligible ? pct(v.missRate) : "–").padStart(10)}`);
        }
        if (shown.length > 12)
            out.push(`  (${shown.length - 12} older versions in --json)`);
    }
    if (r.regressions.length) {
        out.push("", "Changes after an upgrade:");
        for (const g of r.regressions)
            out.push(`  • ${g.text}`);
        out.push("  Read with care: these compare one model (and, for the TTL, one surface) across", "  versions, but a version also arrives with new habits, projects and memory files;", "  the sign-in (API key or subscription) is not in the transcript at all.");
    }
    else if (shown.length >= 2) {
        out.push("", "No step change between versions that the numbers support.");
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
    out.push("", "A miss: within the cache lifetime of both requests (5 min, or 1 h when written at", "the 1-hour TTL), no compaction between, previous context over 20k, and the request", "wrote over 60% of that context again. Model switches always miss: each model has", "its own cache. On Claude Code 2.1.251+, `context-doctor install` (or the plugin)", "shows that price before a /model switch.");
    return out.join("\n");
}
