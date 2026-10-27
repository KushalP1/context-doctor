/**
 * `context-doctor statusline` — live context health in Claude Code's status bar.
 *
 * Claude Code's `statusLine` setting runs a command on every refresh and shows
 * its first line of stdout. That is "context health where the work happens"
 * without an editor extension: the number that matters, visible while typing.
 *
 * When Claude Code passes `prompt_cache` (2.1.251+), it also says until when
 * the cache is warm and what letting it go cold costs: the re-write of the
 * whole context at the TTL's write rate, instead of a read. The time is a
 * clock time, not a countdown, because the line is only re-run on events and
 * at `expires_at` (Claude Code does that itself), so a countdown would freeze.
 *
 * It also keeps two logs. Each new cache miss Claude Code diagnoses
 * (`prompt_cache.last_miss_cause`) goes to
 * ~/.claude/.context-doctor-misses.jsonl for `cache-misses`. And the limit
 * ledger: when Claude Code passes `rate_limits`
 * (Pro and Max), each new 5-hour and weekly reading is appended to
 * ~/.claude/.context-doctor-limits.jsonl for `context-doctor limits`.
 *
 * It has to be fast and silent. Fast: the status payload on stdin carries the
 * live context size in recent versions; when it does not, only the tail of the
 * transcript is read (last 256KB, ~1ms on a 20MB file). Silent: any failure
 * prints nothing at all, because a status line that shows an error is worse
 * than one that shows nothing.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { contextWindowFor, formatTokens } from "./tokens.js";
import { CACHE_WRITE_1H, CACHE_WRITE_5M, formatUsd, pricingFor } from "./pricing.js";
import { recordLimits } from "./limits.js";
import { recordMiss } from "./missledger.js";
/** Newest assistant usage from the END of a transcript, without reading the file. */
export function tailUsage(path, tailBytes = 256 * 1024) {
    try {
        const size = statSync(path).size;
        const n = Math.min(size, tailBytes);
        const fd = openSync(path, "r");
        const buf = Buffer.alloc(n);
        try {
            readSync(fd, buf, 0, n, size - n);
        }
        finally {
            closeSync(fd);
        }
        for (const line of buf.toString("utf8").split("\n").reverse()) {
            let entry;
            try {
                entry = JSON.parse(line);
            }
            catch {
                continue; // the first line of a tail is usually a partial one
            }
            // Compacted since the last reply: that reply's usage is the context
            // BEFORE the compaction, and the new size is unknown until the next one.
            if ((entry.type === "system" && entry.subtype === "compact_boundary") || entry.isCompactSummary)
                return undefined;
            // A subagent's usage describes its own context window, not this one.
            if (entry.isSidechain)
                continue;
            const usage = entry.type === "assistant" ? entry.message?.usage : undefined;
            if (!usage)
                continue;
            const read = usage.cache_read_input_tokens ?? 0;
            const tokens = (usage.input_tokens ?? 0) + read + (usage.cache_creation_input_tokens ?? 0);
            if (tokens > 0)
                return { tokens, cacheShare: read / tokens, model: entry.message?.model };
        }
    }
    catch {
        /* unreadable: the caller shows nothing */
    }
    return undefined;
}
/** Ten-cell bar; the visual half of the number. */
function bar(pct) {
    const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
    return "▮".repeat(filled) + "░".repeat(10 - filled);
}
/** "14:32": the local clock time a cache goes cold. */
function clock(epochSeconds) {
    const d = new Date(epochSeconds * 1000);
    if (!Number.isFinite(d.getTime()))
        return undefined;
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
/** No context re-caches more than this; a larger figure is not one to show. */
const MAX_RECACHE_TOKENS = 10_000_000;
/** A cache lives an hour at most; an expiry further out than this is not a real one. */
const MAX_EXPIRY_AHEAD_S = 2 * 3600;
/**
 * Until when the cache is warm, and what going cold costs: the next request
 * writes `recache_tokens_if_cold` at the TTL's rate (1.25x input at 5 minutes,
 * 2x at an hour) where a warm one would read them (0.1x). The extra is the
 * price; tokens alone when the model has no price. Undefined when Claude Code
 * does not say (no `prompt_cache`, caching off, or right after a compaction
 * while the cache is cold).
 */
export function cacheClock(pc, model, nowMs = Date.now()) {
    if (!pc || pc.caching_observed === false)
        return undefined;
    const r = pc.recache_tokens_if_cold;
    const tokens = typeof r === "number" && Number.isFinite(r) && r > 0 && r <= MAX_RECACHE_TOKENS ? r : undefined;
    const price = pricingFor(model);
    const oneHour = pc.ttl === "1h";
    const extra = tokens !== undefined && price ? (tokens * (price.inputPerM * (oneHour ? CACHE_WRITE_1H : CACHE_WRITE_5M) - price.cacheReadPerM)) / 1e6 : undefined;
    const cost = tokens === undefined ? undefined : extra !== undefined && extra > 0 ? `+${formatUsd(extra)}` : `${formatTokens(tokens)} re-write`;
    // Epoch seconds within two hours of now: milliseconds, 1e300 and the like
    // would print a nonsense time ("NaN:NaN"), so they count as no expiry.
    const e = pc.expires_at;
    const expires = typeof e === "number" && Number.isFinite(e) && e > 0 && e * 1000 <= nowMs + MAX_EXPIRY_AHEAD_S * 1000 ? e : undefined;
    // A payload from before the expiry, re-shown after it, is cold whatever `warm` said.
    const at = expires !== undefined ? clock(expires) : undefined;
    if (pc.warm === true && expires !== undefined && at && expires * 1000 > nowMs) {
        const ttl = pc.ttl === "5m" || oneHour ? ` (${pc.ttl})` : "";
        return `warm till ${at}${ttl}${cost ? `, then ${cost}` : ""}`;
    }
    if (pc.warm === false || (expires !== undefined && expires * 1000 <= nowMs)) {
        return cost ? `cold: next turn ${cost}` : undefined;
    }
    return undefined;
}
/** Build the status line, or null when there is nothing trustworthy to show. */
export function renderStatusLine(input, nowMs = Date.now()) {
    let live;
    const cw = input.context_window;
    // Only current_usage is the context. total_input_tokens is a running total
    // in some Claude Code versions and the last response's figure in others;
    // either way it outlives a /compact (current_usage is null until the next
    // reply), and it was shown as "ctx 187k/200k 94% ⚠" over an emptied window.
    // So it is never a fallback.
    const cu = cw?.current_usage;
    const fromPayload = cu ? (cu.input_tokens ?? 0) + (cu.cache_read_input_tokens ?? 0) + (cu.cache_creation_input_tokens ?? 0) : 0;
    if (cu && fromPayload > 0) {
        const read = cu.cache_read_input_tokens;
        live = { tokens: fromPayload, cacheShare: read !== undefined ? read / fromPayload : undefined, model: input.model?.id };
    }
    else if (input.transcript_path) {
        live = tailUsage(input.transcript_path);
    }
    const parts = [];
    if (live) {
        const window = cw?.context_window_size ?? contextWindowFor(live.model ?? input.model?.id);
        if (window) {
            const pct = (live.tokens / window) * 100;
            parts.push(`ctx ${formatTokens(live.tokens)}/${formatTokens(window)} ${bar(pct)} ${pct.toFixed(0)}%${pct >= 70 ? " ⚠" : ""}`);
        }
        else {
            parts.push(`ctx ${formatTokens(live.tokens)}`);
        }
        if (live.cacheShare !== undefined)
            parts.push(`cache ${Math.round(live.cacheShare * 100)}%`);
    }
    const warmth = cacheClock(input.prompt_cache, input.model?.id ?? live?.model, nowMs);
    if (warmth)
        parts.push(warmth);
    // The session's cost is true whatever the context is; show it on its own.
    if (input.cost?.total_cost_usd && input.cost.total_cost_usd > 0)
        parts.push(formatUsd(input.cost.total_cost_usd));
    return parts.length > 0 ? parts.join(" · ") : null;
}
async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}
export async function runStatusLine() {
    try {
        const input = JSON.parse(await readStdin());
        const line = renderStatusLine(input);
        if (line)
            console.log(line);
        // After the line is out: the limit readings `context-doctor limits` fits
        // (only when Claude Code sends them; a few bytes, only on a change).
        if (process.env.CONTEXT_DOCTOR_NO_LIMITS_LOG !== "1")
            recordLimits(input?.rate_limits);
        // And Claude Code's diagnosis of a new cache miss, for `cache-misses`
        // (2.1.260+; one short line per miss, nothing on other refreshes).
        if (process.env.CONTEXT_DOCTOR_NO_MISS_LOG !== "1")
            recordMiss(input?.prompt_cache, input?.session_id, input?.model?.id);
    }
    catch {
        /* silent by design */
    }
}
