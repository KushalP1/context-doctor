/**
 * `context-doctor mod usage`: the figures behind the mod's usage pane
 * (ROADMAP F5), printed as JSON for the mod to draw.
 *
 * Claude Code's Desktop app dropped its usage view (anthropics/claude-code
 * #102264, #102098, #102130; #102094 the context ring) and 2.1.323 removed
 * `subagentStatusLine` (#109446). The pane puts them back from what is on
 * this machine:
 *
 *  - tokens and list-price dollars by model for today, 7 and 30 days, from
 *    the requests `spend` reads (claudeSpend, through the shared scan
 *    cache), kept in a small file for HISTORY_TTL_MS so a pane left open
 *    does not scan every refresh (warm, the scan is ~150 ms on the author's
 *    22,000 requests; cold, ~2.7 s);
 *  - the limit windows from the limits ledger (the 5-hour one only when the
 *    plan has it: Ultra has none), each with its pace and, when a fit of the
 *    readings is good enough to quote, the list-price dollars per 1%;
 *  - each running subagent the mod names (from `$.agent.list()`): its
 *    model and context from its transcript's tail, its cost so far from the
 *    session's price entries, which the every-prompt hook and `mod measure`
 *    keep (sessionTotal: only what was appended since is read).
 *
 * The context ring itself is Claude Code's own figure (`session.measure`),
 * drawn by the mod with no run of this command.
 *
 * Silent like the status line: anything unreadable is left out, and the
 * command prints `{}` at worst and exits 0.
 */
import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeSpend, localDay } from "./spend.js";
import { cleanReadings, limitsReport, readClaudeReadings, windowStatus } from "./limits.js";
import { scanCacheDir } from "./scan.js";
import { findTranscript } from "./modmeasure.js";
import { saveIfWorthIt, sessionTotal } from "./sessionprice.js";
import { subagentDir } from "./subagents.js";
import { contextWindowFor, realModel } from "./tokens.js";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** The history part is measured again at most this often, whoever asks (two sessions' panes share it). */
export const HISTORY_TTL_MS = 5 * MIN;
/** The cache file's format; a file of another is measured again. */
const HISTORY_VERSION = 1;
/** Models listed per period; the rest are summed as "other". */
const TOP_MODELS = 6;
/** A subagent transcript's tail read for its model and context. */
const TAIL_BYTES = 128 * 1024;
/** Subagents read per call: more than this many running at once are named, not read. */
const MAX_AGENTS = 24;
// -- Tokens and dollars by model ------------------------------------------------------
const tokensOf = (it) => it.input + it.read + it.write + it.output;
/** Local midnight of `now`'s day. */
function startOfDay(now) {
    const d = new Date(now);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
/** Sum the requests into today, the last 7 and the last 30 days, each by model, the most dollars first. */
export function summarizeHistory(items, now) {
    const spans = [
        { key: "today", label: "Today", since: startOfDay(now) },
        { key: "7d", label: "7 days", since: now - 7 * DAY },
        { key: "30d", label: "30 days", since: now - 30 * DAY },
    ];
    let unpriced = 0;
    const periods = spans.map((s) => {
        const by = new Map();
        const p = { key: s.key, label: s.label, usd: 0, tokens: 0, requests: 0, models: [] };
        for (const it of items) {
            if (it.ts < s.since || it.ts > now)
                continue;
            const m = realModel(it.model) ?? it.model ?? "unknown";
            const row = by.get(m) ?? by.set(m, { model: m, usd: 0, tokens: 0, requests: 0 }).get(m);
            const t = tokensOf(it);
            row.usd += it.usd;
            row.tokens += t;
            row.requests++;
            p.usd += it.usd;
            p.tokens += t;
            p.requests++;
            if (s.key === "30d" && !it.priced)
                unpriced++;
        }
        const sorted = [...by.values()].sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
        const top = sorted.slice(0, TOP_MODELS);
        const rest = sorted.slice(TOP_MODELS);
        if (rest.length)
            top.push(rest.reduce((o, r) => ({ ...o, usd: o.usd + r.usd, tokens: o.tokens + r.tokens, requests: o.requests + r.requests }), { model: `${rest.length} other model${rest.length === 1 ? "" : "s"}`, usd: 0, tokens: 0, requests: 0 }));
        p.models = top.map((r) => ({ ...r, usd: round(r.usd) }));
        p.usd = round(p.usd);
        return p;
    });
    return { at: now, periods, ...(unpriced ? { unpriced } : {}) };
}
/** List-price dollars per 1% of each Claude window, from fits good enough to quote; none otherwise. */
export function usdPerPctOf(fits) {
    const out = {};
    for (const f of fits)
        if (f.app === "claude" && f.usable && f.pctPerUsd && f.pctPerUsd > 0)
            out[f.window] = round(1 / f.pctPerUsd);
    return Object.keys(out).length ? out : undefined;
}
function historyFile() {
    return join(scanCacheDir(), "usage-pane.json");
}
function readHistory(now) {
    try {
        const j = JSON.parse(readFileSync(historyFile(), "utf8"));
        if (j?.v !== HISTORY_VERSION || typeof j.h?.at !== "number" || !Array.isArray(j.h.periods))
            return undefined;
        // A cache from another day has the wrong "today"; one from the future is a clock that moved.
        if (now - j.h.at >= HISTORY_TTL_MS || j.h.at > now || localDay(j.h.at) !== localDay(now))
            return undefined;
        return j.h;
    }
    catch {
        return undefined;
    }
}
function writeHistory(h) {
    const file = historyFile();
    try {
        mkdirSync(scanCacheDir(), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ v: HISTORY_VERSION, h }));
        renameSync(tmp, file);
    }
    catch { /* measured again next time */ }
}
/** The history part: from the cache while it is fresh, else measured (spend's scan, then the limit fits over the same requests). */
export function historyUse(now, fresh = false) {
    const t0 = Date.now();
    const cached = fresh ? undefined : readHistory(now);
    if (cached)
        return { h: cached, from: "cache", ms: Date.now() - t0 };
    const h = summarizeHistory(claudeSpend(now - 30 * DAY, now), now);
    try {
        const per = usdPerPctOf(limitsReport(30, { now, claudeOnly: true }).fits);
        if (per)
            h.usdPerPct = per;
    }
    catch { /* no fit: the windows show without it */ }
    writeHistory(h);
    return { h, from: "measured", ms: Date.now() - t0 };
}
// -- The limit windows ----------------------------------------------------------------
/**
 * Each Claude window in the ledger, newest reading first, with its pace.
 * A window with no reading in the last 8 days is not shown: a plan with no
 * 5-hour window (Ultra) has only the weekly one.
 */
export function limitWindows(now, usdPerPct, readings) {
    const all = readings ?? readClaudeReadings(now - 8 * DAY);
    const by = new Map();
    for (const r of all)
        (by.get(r.window) ?? by.set(r.window, []).get(r.window)).push(r);
    const out = [];
    for (const w of ["five_hour", "seven_day"]) {
        const rs = by.get(w);
        if (!rs?.length)
            continue;
        const s = windowStatus(cleanReadings(rs), now);
        if (!s)
            continue;
        out.push({
            window: w, label: w === "five_hour" ? "5-hour" : "Weekly", pct: s.pct, at: s.at, resetSince: s.resetSince,
            ...(s.resetsAt !== undefined ? { resetsAt: s.resetsAt } : {}),
            ...(s.recentPerHour !== undefined ? { perHour: round(s.recentPerHour) } : {}),
            ...(s.runsOutAt !== undefined ? { runsOutAt: Math.round(s.runsOutAt), beforeReset: s.beforeReset } : {}),
            ...(usdPerPct?.[w] !== undefined ? { usdPerPct: usdPerPct[w] } : {}),
        });
    }
    return out;
}
// -- Running subagents ----------------------------------------------------------------
/** A subagent's model and context, from the last request in its transcript's tail. */
export function agentTail(file) {
    let text;
    try {
        const size = statSync(file).size;
        const n = Math.min(size, TAIL_BYTES);
        const buf = Buffer.alloc(n);
        const fd = openSync(file, "r");
        try {
            readSync(fd, buf, 0, n, size - n);
        }
        finally {
            closeSync(fd);
        }
        text = buf.toString("utf8");
    }
    catch {
        return {};
    }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.includes('"usage"'))
            continue;
        try {
            const e = JSON.parse(line);
            const u = e?.message?.usage;
            if (e?.type !== "assistant" || !u)
                continue;
            const n = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
            const model = realModel(e.message.model);
            return { ...(model ? { model } : {}), contextTokens: n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens) };
        }
        catch { /* a partial line at the tail's start */ }
    }
    return {};
}
/** Agent ids as `$.agent.list()` gives them: letters, digits, `_` and `-` (never a path). */
function agentIds(list) {
    if (!Array.isArray(list))
        return [];
    const ids = list.map((a) => (typeof a === "string" ? a : a && typeof a === "object" ? a.id : undefined)).filter((id) => typeof id === "string" && /^[\w-]{1,80}$/.test(id));
    return [...new Set(ids)].slice(0, MAX_AGENTS);
}
/** Each running subagent's model, context and cost so far. */
export function agentUse(sessionId, cwd, list, now) {
    const ids = agentIds(list);
    if (!ids.length)
        return [];
    const transcript = findTranscript(sessionId, cwd);
    if (!transcript || !sessionId)
        return ids.map((id) => ({ id }));
    let byFile = {};
    try {
        const t = sessionTotal({ sessionId, transcript }, now);
        saveIfWorthIt(t);
        byFile = t.byFile;
    }
    catch { /* the cost is left out */ }
    const dir = subagentDir(transcript);
    return ids.map((id) => {
        const file = join(dir, `agent-${id}.jsonl`);
        const tail = agentTail(file);
        const cost = byFile[file];
        const window = contextWindowFor(tail.model);
        return {
            id,
            ...tail,
            ...(window ? { window } : {}),
            ...(cost ? { usd: round(cost.usd), requests: cost.requests } : {}),
        };
    });
}
// -- The command ----------------------------------------------------------------------
const round = (n) => Math.round(n * 10_000) / 10_000;
/** Everything the pane draws but the context ring. Never throws. */
export function usagePane(input, now = Date.now()) {
    const out = { at: now, limits: [], agents: [] };
    if (input?.history !== false) {
        try {
            const { h, from, ms } = historyUse(now, input?.fresh === true);
            out.history = h;
            out.historyFrom = from;
            out.historyMs = ms;
        }
        catch { /* the pane shows the rest */ }
    }
    try {
        out.limits = limitWindows(now, out.history?.usdPerPct ?? readHistory(now)?.usdPerPct);
    }
    catch { /* no ledger */ }
    try {
        out.agents = agentUse(typeof input?.sessionId === "string" ? input.sessionId : undefined, typeof input?.cwd === "string" ? input.cwd : undefined, input?.agents, now);
    }
    catch { /* none read */ }
    return out;
}
