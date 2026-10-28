/**
 * Cold resume: coming back to a large session after the prompt cache expired.
 *
 * Claude Code caches the conversation for an hour on a subscription (five
 * minutes on the API). Come back later and the next message re-sends the
 * whole context at the cache-WRITE rate (2x input for the 1-hour cache,
 * 1.25x for 5 minutes), and every message after it re-reads it (the model's
 * cache-read rate, 2.5-10% of input). On a 500k-token session that is the
 * most expensive moment of the day, and the one moment `/compact` is
 * cheapest to accept: the cache is being rebuilt anyway.
 *
 * Measured on the author's 133 days of Claude Code history: 401 returns to a
 * session over 150k tokens after more than 65 idle minutes (median context
 * 517k). Compacting right after the first reply, counting the compaction
 * request itself and only the messages up to the next such return, would have
 * saved $4,053 at list price, about $914 a month; it paid off in 296 of 401
 * cases, and the worst single loss was $2.30 (sessions left after a few more
 * messages). So this advises, with the numbers, and the user decides. (That
 * replay priced reads at 0.1x and writes at 1.25x of the session's first
 * model. At each model's own read rate, Opus 5.5 at 5% and Fable 5.1 at
 * 2.5%, the re-reads compaction avoids cost far less: the author's last 7
 * days went from $332 to $139.)
 *
 * It works where the proxy cannot: the desktop app's Code tab runs Claude Code
 * host-orchestrated and drops a settings-file ANTHROPIC_BASE_URL, but it runs
 * the every-prompt hook, which is where this is called from.
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { forEachLine, replyCounter } from "./session.js";
import { cacheWriteSplit, pricingFor, formatUsd, writeMultiplier } from "./pricing.js";
import { contextWindowFor, formatTokens, realModel } from "./tokens.js";
import { claudeDir } from "./claudedir.js";
/**
 * Claude Code's own idle compaction (2.1.290+, account-gated by a server
 * flag; the `idleCompaction` setting can only turn it off). Read from the
 * 2.1.295 and 2.1.299 binaries: while a session sits idle on the 1-hour
 * cache, it compacts at 90% of the cache's lifetime (~54 minutes), while the
 * cache is still warm, when the context holds at least
 * CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS (floor 100k; default 200,000). It
 * skips 5-minute caches ("not_one_hour"), smaller sessions ("small"), a cache
 * that already lapsed (a machine asleep) and sessions near a usage limit.
 * The compact boundary it writes says trigger "auto", the same as a full
 * window, and is followed by an informational row with this text; the
 * headless host's variant (CLAUDE_CODE_SLEEP_COMPACT) queues a hidden
 * `/compact` instead. Either way a compaction ends the idle period, so the
 * cold-resume offer below stays silent after it, and keeps covering what
 * idle compaction skips: 5-minute caches, sessions of 150k-200k tokens, and
 * returns after the machine slept through the compaction moment.
 */
export const IDLE_COMPACT_NOTICE = "Compacted while idle";
/** Claude Code's idle-compaction minimum when CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS is unset (2.1.299). */
export const IDLE_COMPACT_MIN_TOKENS = 200_000;
/** The row Claude Code writes after an idle compaction's boundary. */
export function isIdleCompactNotice(e) {
    return e?.type === "system" && typeof e.content === "string" && e.content.startsWith(IDLE_COMPACT_NOTICE);
}
/** The context at which Claude Code's idle compaction acts, as it reads the environment. */
export function idleCompactMinTokens(env = process.env) {
    const n = Number(env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS);
    return env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS && Number.isFinite(n) ? Math.max(100_000, n) : IDLE_COMPACT_MIN_TOKENS;
}
/**
 * The context at which Claude Code is certain to compact before sending:
 * its auto-compact window, which is the model's, or smaller when
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW or the `autoCompactWindow` setting says
 * so. Not a share of it: on the author's history, cold returns at 95-99% of
 * a 1M window went on for 2 to 51 requests before Claude Code compacted, so
 * an offer there still paid; the one that compacted on the spot came at 96%.
 * The note to the model covers that case instead. Undefined when
 * auto-compaction is off or the window is unknown.
 */
export function autoCompactsAt(model, home = homedir(), env = process.env) {
    if (env.DISABLE_AUTO_COMPACT || env.DISABLE_COMPACT)
        return undefined;
    let settings = {};
    try {
        settings = JSON.parse(readFileSync(join(claudeDir(home), "settings.json"), "utf8")) ?? {};
    }
    catch { /* no settings */ }
    if (settings.autoCompactEnabled === false)
        return undefined;
    const window = contextWindowFor(model);
    const fromEnv = Number(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
    const set = fromEnv > 0 ? fromEnv : typeof settings.autoCompactWindow === "number" && settings.autoCompactWindow > 0 ? settings.autoCompactWindow : undefined;
    const effective = set !== undefined ? Math.min(window ?? set, set) : window;
    return effective;
}
/** Just past Claude Code's one-hour cache, as Claude Code's own idle clearing uses. */
export const COLD_IDLE_MS = 65 * 60_000;
/** Margin past a cache's lifetime before a return counts as cold. */
const COLD_MARGIN_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;
const FIVE_MIN_MS = 5 * 60_000;
/**
 * How long the cache entry a reply left behind lives: one hour when the reply
 * wrote the 1-hour cache, five minutes when it wrote only the 5-minute one,
 * and otherwise whatever the last write before it used (a read refreshes an
 * entry at its own lifetime). Claude Code's main thread wrote the 1-hour cache
 * until 2.1.295, which often writes the 5-minute one (in the author's last 3
 * days, 1,307 main-thread replies wrote only 5-minute entries): a gate fixed
 * at 65 minutes missed every return between 10 and 65 minutes to those
 * sessions, cold as they were. Undefined when nothing says.
 */
function writtenTtlMs(u) {
    // Only an explicit split says: cacheWriteSplit books unsplit writes as
    // 5-minute for pricing, which would make every old transcript look short-lived.
    const split = u?.cache_creation;
    if (!split)
        return undefined;
    if ((split.ephemeral_1h_input_tokens ?? 0) > 0)
        return HOUR_MS;
    if ((split.ephemeral_5m_input_tokens ?? 0) > 0)
        return FIVE_MIN_MS;
    return undefined;
}
/** Below this, a rebuilt cache is cheap and compaction is not worth the interruption. */
export const COLD_MIN_TOKENS = 150_000;
/** What a compacted session restarts from: system prompt and tools plus the summary. */
const AFTER_COMPACT_TOKENS = 45_000;
/** Output tokens a compaction summary costs, at the model's output price. */
const SUMMARY_OUTPUT_TOKENS = 8_000;
export function resumeVerdict(input, now = Date.now()) {
    if (input?.hook_event_name !== "SessionStart" || (input.source !== "resume" && input.source !== "fork"))
        return undefined;
    const secs = input.seconds_since_last_response;
    if (typeof input.prompt_cache_likely_expired !== "boolean" || typeof secs !== "number" || !Number.isFinite(secs))
        return undefined;
    const usd = input.estimated_cache_write_usd;
    return { replyAt: now - secs * 1000, at: now, expired: input.prompt_cache_likely_expired, usd: typeof usd === "number" && Number.isFinite(usd) ? usd : undefined };
}
/**
 * Apply Claude Code's resume verdict to what the transcript showed. It
 * describes this idle period when its reply time matches (seconds are
 * rounded); a "still warm" verdict holds only for the cache's shortest life
 * after it was given. Undefined: no offer.
 */
export function withResumeVerdict(c, v, now = Date.now()) {
    if (!c || !v || Math.abs(c.lastReplyAt - v.replyAt) > 5_000)
        return c;
    if (!v.expired)
        return now - v.at < FIVE_MIN_MS ? undefined : c;
    return v.usd !== undefined ? { ...c, resumeUsd: v.usd, claudeCodePriced: true } : c;
}
function tailLines(path, bytes = 256 * 1024) {
    const size = statSync(path).size;
    const n = Math.min(size, bytes);
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(n);
    try {
        readSync(fd, buf, 0, n, size - n);
    }
    finally {
        closeSync(fd);
    }
    return buf.toString("utf8").split("\n").reverse();
}
/**
 * Is the prompt being submitted now a return to a large, cache-cold session?
 * Reads only the transcript's tail. Undefined when not (or when unreadable).
 */
export function detectColdResume(path, now = Date.now(), idleMs, minTokens = COLD_MIN_TOKENS) {
    try {
        const lines = tailLines(path);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            let e;
            try {
                e = JSON.parse(line);
            }
            catch {
                continue;
            }
            // Compacted since the last reply: the old usage no longer describes the
            // context, and there is nothing large left to warn about.
            if (e?.type === "system" && e.subtype === "compact_boundary")
                return undefined;
            if (e?.isCompactSummary || isIdleCompactNotice(e))
                return undefined;
            if (e?.type !== "assistant" || e.isSidechain)
                continue;
            const u = e.message?.usage;
            if (!u)
                continue;
            const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            if (tokens <= 0)
                continue;
            const lastReplyAt = Date.parse(e.timestamp);
            if (!Number.isFinite(lastReplyAt))
                return undefined;
            const idle = now - lastReplyAt;
            // The cache lives as long as the last write said (see writtenTtlMs);
            // with nothing recorded, the hour Claude Code used to write.
            let ttl = writtenTtlMs(u);
            for (let j = i + 1; ttl === undefined && j < lines.length; j++) {
                try {
                    const earlier = JSON.parse(lines[j]);
                    if (earlier?.type === "assistant" && !earlier.isSidechain)
                        ttl = writtenTtlMs(earlier.message?.usage);
                }
                catch { /* partial line at the tail's start */ }
            }
            const gate = idleMs ?? (ttl ?? HOUR_MS) + COLD_MARGIN_MS;
            if (idle < gate || tokens < minTokens)
                return undefined;
            const model = realModel(e.message?.model);
            const p = pricingFor(model);
            // The rebuild is written at the TTL this session writes at: Claude
            // Code's main thread has mostly written the 1-hour cache (2x input,
            // 97% of the author's main-thread writes), which a flat 1.25x
            // underpriced by 37%. Re-reads at the model's own read rate (Opus 5.5
            // reads at 5% of input, not 10%).
            return {
                idleMs: idle,
                tokens,
                model,
                lastReplyAt,
                resumeUsd: p ? (tokens * sessionWriteMultiplier(path) * p.inputPerM) / 1e6 : undefined,
                perMessageUsd: p ? (tokens * p.cacheReadPerM) / 1e6 : undefined,
            };
        }
    }
    catch {
        /* unreadable transcript: no advice */
    }
    return undefined;
}
/**
 * What this session pays to write a token to the cache, relative to input:
 * the 5-minute/1-hour mix of the main-thread writes in the transcript's
 * tail (subagents write 5 minutes and are not this context). The tail, not
 * the whole file, because it is the TTL the harness writes at now: on the
 * author's machine Claude Code 2.1.295 (desktop app) moved main-thread
 * writes from 1 hour to 5 minutes, and 7 of the 12 largest recent sessions
 * switched mid-file. 1.25x when the tail records no split or no writes.
 * Reads only the tail, so the every-prompt hook can afford it.
 */
export function sessionWriteMultiplier(path) {
    let writes5m = 0, writes1h = 0;
    try {
        const ids = new Set();
        for (const line of tailLines(path)) {
            if (!line.includes('"cache_creation_input_tokens"'))
                continue;
            let e;
            try {
                e = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (e?.type !== "assistant" || e.isSidechain || !e.message?.usage)
                continue;
            // One reply is several rows carrying the same usage.
            const id = e.message.id;
            if (typeof id === "string") {
                if (ids.has(id))
                    continue;
                ids.add(id);
            }
            const w = cacheWriteSplit(e.message.usage);
            writes5m += w.fiveMinute;
            writes1h += w.oneHour;
        }
    }
    catch {
        /* unreadable transcript: the API's default TTL */
    }
    return writeMultiplier(writes5m, writes1h);
}
function duration(ms) {
    const m = Math.round(ms / 60_000);
    if (m < 90)
        return `${m} minutes`;
    const h = ms / 3_600_000;
    return h < 48 ? `${h.toFixed(h < 10 ? 1 : 0)} hours` : `${Math.round(h / 24)} days`;
}
/**
 * The one line shown to the USER in the app (hook `systemMessage`). In the
 * first week the offer lived only inside the model's reply and was acted on
 * 1 time in 33; a notice of its own is harder to miss.
 */
export function renderColdResumeNotice(c) {
    const cheaper = Math.max(0, Math.round((1 - AFTER_COMPACT_TOKENS / c.tokens) * 100));
    const money = c.resumeUsd !== undefined ? ` (~${formatUsd(c.resumeUsd)} ${c.claudeCodePriced ? "by Claude Code's estimate" : "at list price"})` : "";
    return `context-doctor: idle ${duration(c.idleMs)}, so this message re-sent the whole ~${formatTokens(c.tokens)}-token context${money}. If you keep working here, /compact now makes each later message ~${cheaper}% cheaper.`;
}
/** The note the hook hands the model: the numbers, and one sentence to say. */
export function renderColdResume(c) {
    const cheaper = Math.max(0, Math.round((1 - AFTER_COMPACT_TOKENS / c.tokens) * 100));
    const money = c.resumeUsd !== undefined
        ? ` (~${formatUsd(c.resumeUsd)} ${c.claudeCodePriced ? "by Claude Code's estimate" : "at list price"}), and every later message re-reads it${c.perMessageUsd !== undefined ? ` (~${formatUsd(c.perMessageUsd)} each)` : ""}`
        : ", and every later message re-reads it";
    return [
        `This session was idle for ${duration(c.idleMs)}, longer than the prompt cache lasts, so this message re-sends the whole ~${formatTokens(c.tokens)}-token context at the full cache-write rate${money}.`,
        `If the user is going to keep working in this session, running /compact now restarts it from a short summary and makes each later message roughly ${cheaper}% cheaper; the cache is being rebuilt anyway, so now is when compaction costs least.`,
        "Begin your reply with one short sentence offering that (only the user can run /compact), then answer the request normally; if the conversation was compacted just before this message, say nothing about it. Do not raise it again this session unless it goes idle again.",
    ].join("\n");
}
/**
 * Replay a transcript's billed usage and price what compacting at each cold
 * resume would have saved. Each resume only counts the messages up to the
 * next one (no double counting), and the compaction request is a cost.
 *
 * Each request at its own model's prices: a session that moved from a $4 to
 * a $10 model was priced at the first throughout, and one that opened with
 * a "<synthetic>" row not at all. A re-write that never happened (a cold
 * read of what compaction would have removed, the fresh context after it)
 * at the session's own 5-minute/1-hour write mix, not 1.25x. `runRows` is
 * shared by every transcript of one report (see replyCounter): a forked
 * session's copy of its parent's history shapes the timeline, but a resume
 * in it was counted under the transcript that met it first.
 */
export function coldResumeEvents(path, idleMs, minTokens = COLD_MIN_TOKENS, runRows) {
    let ttl = HOUR_MS;
    const reqs = [];
    let model, writes5m = 0, writes1h = 0;
    const sighting = replyCounter(runRows);
    forEachLine(path, (line) => {
        let e;
        try {
            e = JSON.parse(line);
        }
        catch {
            return;
        }
        if (!e || e.isSidechain)
            return;
        if (e.type === "system" && e.subtype === "compact_boundary") {
            reqs.push("compact");
            return;
        }
        if (e.type !== "assistant" || !e.message)
            return;
        const seen = sighting(e);
        if (seen === "repeat")
            return;
        const u = e.message.usage ?? {};
        const total = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        const at = Date.parse(e.timestamp);
        if (!(total > 0) || !Number.isFinite(at))
            return;
        model = realModel(e.message.model) ?? model;
        const w = cacheWriteSplit(u);
        writes5m += w.fiveMinute;
        writes1h += w.oneHour;
        ttl = writtenTtlMs(u) ?? ttl;
        reqs.push({ at, total, price: pricingFor(model), copy: seen === "copy", ttl });
    });
    const mix = writeMultiplier(writes5m, writes1h);
    const real = reqs.filter((r) => r !== "compact");
    if (real.length < 2)
        return [];
    const events = [];
    for (let i = 1; i < reqs.length; i++) {
        const a = reqs[i - 1], b = reqs[i];
        if (a === "compact" || b === "compact")
            continue;
        // Cold once the gap outlives the cache the previous request left behind.
        const gate = (r) => idleMs ?? r.ttl + COLD_MARGIN_MS;
        if (b.at - a.at <= gate(a) || b.total < minTokens)
            continue;
        if (b.copy || !b.price)
            continue;
        const removed = Math.max(0, b.total - AFTER_COMPACT_TOKENS);
        let saved = 0, n = 0, prev = b;
        for (const c of reqs.slice(i + 1)) {
            if (c === "compact")
                break;
            if (c.at - prev.at > gate(prev) && c.total >= minTokens)
                break;
            const p = c.price ?? b.price;
            saved += removed * (c.at - prev.at > prev.ttl ? mix * p.inputPerM : p.cacheReadPerM);
            prev = c;
            n++;
        }
        // The compaction re-reads the context just rebuilt and writes a summary;
        // the next request writes the fresh context.
        const cost = b.total * b.price.cacheReadPerM + SUMMARY_OUTPUT_TOKENS * b.price.outputPerM + mix * AFTER_COMPACT_TOKENS * b.price.inputPerM;
        events.push({ at: b.at, tokens: b.total, messagesAfter: n, netUsd: (saved - cost) / 1e6 });
    }
    return events;
}
/** A /compact within this long of the offer counts as acting on it. */
const FOLLOW_MS = 60 * 60_000;
/**
 * How often the cold-resume offer was acted on: offers (ledger events) whose
 * session has a compaction within an hour after. `sessionPaths` maps the
 * ledger's 12-char session id to its transcript. Only lines that mention a
 * compact boundary are parsed, so even very large transcripts scan quickly.
 */
export function coldResumeFollowThrough(offers, sessionPaths) {
    const compactsBySid = new Map();
    let compacted = 0;
    for (const o of offers) {
        const path = o.sid ? sessionPaths.get(o.sid) : undefined;
        if (!path)
            continue;
        let times = compactsBySid.get(o.sid);
        if (!times) {
            const found = [];
            try {
                forEachLine(path, (line) => {
                    if (!line.includes("compact_boundary"))
                        return;
                    try {
                        const e = JSON.parse(line);
                        const at = Date.parse(e.timestamp);
                        if (e.subtype === "compact_boundary" && Number.isFinite(at))
                            found.push(at);
                    }
                    catch { /* not a full JSON row */ }
                });
            }
            catch { /* unreadable transcript: no compactions known */ }
            compactsBySid.set(o.sid, (times = found));
        }
        if (times.some((t) => t >= o.ts && t - o.ts <= FOLLOW_MS))
            compacted++;
    }
    return { offers: offers.length, compacted };
}
