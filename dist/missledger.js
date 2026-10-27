/**
 * Claude Code's own diagnosis of each prompt-cache miss, kept by the status line.
 *
 * Since 2.1.251 Claude Code passes the status line a `prompt_cache` object,
 * and since 2.1.260 it says why the last miss happened (`last_miss_cause`):
 * it compares the request with the one before, on the client, where it can see
 * the system prompt, the tool definitions, the betas and the TTL, none of
 * which reach the transcript. `cache-misses` reads transcripts, so most of its
 * misses are "nothing visible"; this log is what explains them.
 *
 * The status line appends one line per new miss (a `last_miss_at` this
 * session has not logged yet) to ~/.claude/.context-doctor-misses.jsonl:
 * when, the session, the causes, and the session's running miss count and
 * re-cached tokens, from which a report takes each miss's share. Misses are
 * rare (a few a day), so the file stays small; it is byte-capped anyway.
 * Never throws: the status line must stay silent.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { statePath } from "./ledger.js";
import { CACHE_WRITE_1H, CACHE_WRITE_5M, pricingFor } from "./pricing.js";
/** Beside the limits log: ~/.claude/.context-doctor-misses.jsonl. */
export function missLogPath() {
    return join(dirname(statePath()), ".context-doctor-misses.jsonl");
}
/** Past this size the log keeps its newest MISS_LOG_KEEP bytes (~5,000 misses). */
const MISS_LOG_ROTATE_AT = 1024 * 1024;
const MISS_LOG_KEEP = 768 * 1024;
/** Misses the status line never saw the cause of: the counter moved by more than one between runs. */
const UNSEEN_KEY = "unseen";
const UNSEEN = UNSEEN_KEY;
/**
 * Claude Code's cause names (2.1.308's closed set, `PROMPT_CACHE_MISS_CAUSES`)
 * with what each means and what to do about it. A name not here is shown as it
 * is, with no advice: Claude Code may add causes.
 */
export const MISS_CAUSES = {
    tools_changed: { label: "tool definitions changed", fix: "an MCP server connected late, reconnected or changed its tools mid-session; `overhead --mcp` flags servers whose tool list is unstable, `overhead prune` drops unused ones" },
    system_prompt_changed: { label: "system prompt changed", fix: "CLAUDE.md, memory, an output style or a skill changed mid-session; edit them between sessions" },
    model_changed: { label: "model changed", fix: "each model has its own cache; switch models at the start of a session (the PreModelSwitch hook prices it)" },
    messages_rewritten: { label: "earlier messages changed", fix: "something rewrote history (a proxy, a rewind, a hook): if it is autopilot, it acts only when the cache is cold" },
    ttl_expired_5m: { label: "idle past the 5m TTL", fix: "a pause over 5 minutes; the status line shows until when the cache is warm" },
    ttl_expired_1h: { label: "idle past the 1h TTL", fix: "a pause over an hour, or a loop waking just after it; keep wake-ups under 55 minutes" },
    likely_server_side: { label: "prompt unchanged, likely server-side", fix: "nothing changed on this machine: the provider dropped the cache; nothing to fix locally" },
    fast_mode_changed: { label: "fast mode toggled" },
    cache_scope_or_ttl_changed: { label: "cache scope or TTL changed" },
    betas_changed: { label: "beta headers changed" },
    effort_changed: { label: "effort changed", fix: "/effort mid-session re-writes the cache; set it at the start" },
    thinking_mode_changed: { label: "thinking toggled" },
    thinking_display_changed: { label: "thinking display changed" },
    auto_mode_changed: { label: "auto mode toggled" },
    overage_changed: { label: "usage-limit state changed" },
    extra_body_changed: { label: "extra request fields changed" },
    defer_loading_changed: { label: "deferred tool loading changed" },
    unknown: { label: "unknown" },
    [UNSEEN_KEY]: { label: "not seen: two misses between status line runs" },
};
const CAUSE_NAME = /^[a-z0-9_]{1,40}$/;
const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
function tail(path, bytes) {
    const size = statSync(path).size;
    const n = Math.min(size, bytes);
    const fd = openSync(path, "r");
    try {
        const buf = Buffer.alloc(n);
        readSync(fd, buf, 0, n, size - n);
        return buf.toString("utf8");
    }
    finally {
        closeSync(fd);
    }
}
function parseLine(line) {
    let e;
    try {
        e = JSON.parse(line);
    }
    catch {
        return undefined;
    }
    if (!e || typeof e !== "object" || typeof e.s !== "string" || num(e.at) === undefined || num(e.ts) === undefined)
        return undefined;
    if (!Array.isArray(e.causes))
        return undefined;
    return { ...e, causes: e.causes.filter((c) => typeof c === "string" && CAUSE_NAME.test(c)), n: num(e.n) ?? 0, tok: num(e.tok) ?? 0 };
}
/**
 * Append the session's newest miss when it is not in the log yet. `pc` is
 * Claude Code's `prompt_cache`. Each status line refresh re-sends the same
 * `last_miss_at` until the next miss, and parallel sessions write the same
 * file, so the identity is (session, last_miss_at), checked against the
 * log's tail. Returns 1 when a line was written.
 */
export function recordMiss(pc, sessionId, model, now = Date.now(), path = missLogPath()) {
    if (!pc || typeof pc !== "object" || typeof sessionId !== "string" || !sessionId)
        return 0;
    const p = pc;
    const at = num(p.last_miss_at);
    const n = num(p.misses);
    if (at === undefined || at <= 0 || n === undefined || n < 1)
        return 0;
    const s = sessionId.slice(0, 64);
    const cause = p.last_miss_cause && typeof p.last_miss_cause === "object" ? p.last_miss_cause : undefined;
    // null: Claude Code could not tell. That is a finding too.
    const causes = Array.isArray(cause?.causes) ? cause.causes.filter((c) => typeof c === "string" && CAUSE_NAME.test(c)).slice(0, 8) : [];
    const line = {
        ts: now,
        s,
        at: Math.round(at),
        causes: causes.length ? causes : ["unknown"],
        n: Math.round(n),
        tok: Math.max(0, Math.round(num(p.miss_recache_tokens) ?? 0)),
        ...(typeof model === "string" && model ? { m: model.slice(0, 60) } : {}),
        ...(p.ttl === "5m" || p.ttl === "1h" ? { ttl: p.ttl } : {}),
        ...(num(cause?.tools_added) ? { added: num(cause.tools_added) } : {}),
        ...(num(cause?.tools_removed) ? { removed: num(cause.tools_removed) } : {}),
        ...(num(cause?.system_char_delta) ? { delta: num(cause.system_char_delta) } : {}),
    };
    try {
        if (existsSync(path)) {
            for (const l of tail(path, 64 * 1024).split("\n")) {
                const e = parseLine(l);
                if (e && e.s === s && e.at === line.at)
                    return 0;
            }
            if (statSync(path).size > MISS_LOG_ROTATE_AT) {
                const text = tail(path, MISS_LOG_KEEP);
                writeFileSync(path, text.slice(text.indexOf("\n") + 1));
            }
        }
        else {
            mkdirSync(dirname(path), { recursive: true });
        }
        appendFileSync(path, JSON.stringify(line) + "\n");
        return 1;
    }
    catch {
        return 0;
    }
}
/**
 * The log since `since`, grouped by cause. A miss's tokens are the growth of
 * its session's running total since the session's previous line (the first
 * line of a session counts its whole total: the log may start mid-session).
 */
export function diagnosedMisses(since = 0, path = missLogPath()) {
    const empty = { misses: 0, sessions: 0, tokens: 0, extraUsd: 0, byCause: [] };
    if (!existsSync(path))
        return empty;
    let text;
    try {
        text = readFileSync(path, "utf8");
    }
    catch {
        return empty;
    }
    const lines = text.split("\n").map(parseLine).filter((l) => !!l).sort((a, b) => a.at - b.at || a.ts - b.ts);
    const last = new Map();
    const seen = new Set();
    const causes = new Map();
    const sessions = new Set();
    let misses = 0, tokens = 0, extraUsd = 0, from;
    for (const l of lines) {
        const id = `${l.s}\u0000${l.at}`;
        if (seen.has(id))
            continue; // two parallel status lines raced
        seen.add(id);
        const prev = last.get(l.s);
        last.set(l.s, l);
        if (l.at * 1000 < since)
            continue;
        const tok = prev && l.tok >= prev.tok ? l.tok - prev.tok : l.tok;
        // Misses by the session's running count: when two happened between two
        // status line runs, the line names the cause of the last one only, so
        // its share of the tokens goes to that cause and the rest to "unseen".
        const k = Math.max(1, prev && l.n >= prev.n ? l.n - prev.n : l.n);
        const price = pricingFor(l.m);
        // No ttl recorded: Claude Code's default, 5 minutes (as the status line prices it).
        const perToken = price ? (price.inputPerM * (l.ttl === "1h" ? CACHE_WRITE_1H : CACHE_WRITE_5M) - price.cacheReadPerM) / 1e6 : 0;
        misses += k;
        tokens += tok;
        extraUsd += tok * perToken;
        sessions.add(l.s);
        from = from === undefined ? l.at * 1000 : Math.min(from, l.at * 1000);
        const add = (c, n, t) => {
            const known = MISS_CAUSES[c];
            const g = causes.get(c) ?? causes.set(c, { cause: c, label: known?.label ?? c.replace(/_/g, " "), fix: known?.fix, misses: 0, tokens: 0, extraUsd: 0 }).get(c);
            g.misses += n;
            g.tokens += t;
            g.extraUsd += t * perToken;
        };
        for (const c of l.causes)
            add(c, 1, tok / k);
        if (k > 1)
            add(UNSEEN, k - 1, (tok * (k - 1)) / k);
    }
    return { misses, sessions: sessions.size, tokens, extraUsd, from, byCause: [...causes.values()].sort((a, b) => b.tokens - a.tokens || b.misses - a.misses) };
}
