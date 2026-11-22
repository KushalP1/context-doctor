/**
 * Past the plan's limit: which Claude Code requests were paid from usage
 * credits ("extra usage"), and about how much.
 *
 * With extra usage on, Claude Code keeps working when a weekly or 5-hour
 * limit runs out and the requests are paid from credits: real money that
 * the limits' % no longer shows. Two sources say when:
 *
 *  - The proxy records the API's `anthropic-ratelimit-unified-overage-*`
 *    headers into the limits ledger (limits.ts recordOverage). A request
 *    made while the newest of those readings (at most 16 minutes old) said
 *    `in-use: true` was paid from credits; `false` says it was not.
 *  - The plugin's mod and the status line hand over only the windows' %,
 *    nothing about credits. A request that still went through (it has
 *    usage in its transcript) after a window read 100% and before that
 *    window reset is past the limit, and with extra usage on most likely
 *    paid from credits: counted as inferred, and said to be. With extra
 *    usage off (`~/.claude.json`, claudedir.ts readExtraUsage) nothing is
 *    inferred.
 *
 * Dollars are each request at API list prices, as `spend` prices it.
 * Whether usage credits are billed at exactly those prices is not verified
 * here, so every figure is said to be an estimate. Read only by commands
 * the user runs (`limits`, `spend`, `doctor`, `budget`), and by the
 * budget's hook at a threshold it already speaks at: nothing is drawn or sent.
 */
import { readExtraUsage } from "./claudedir.js";
import { claudeUsage, cleanReadings, CLAUDE_WINDOWS, limitsLogPath, readClaudeReadings, readOverageReadings } from "./limits.js";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** A credits reading stands for this long: the proxy writes it again every 15 minutes while it holds. */
const HEADER_STALE_MS = 16 * MIN;
/** A reading written this long after a request's row still speaks for it (the row and the reading are written around the same reply). */
const HEADER_LAG_MS = MIN;
/** Two readings' resets this close name the same window period. */
const SAME_RESET_MS = 10 * MIN;
/** Credited requests with no window to tie them to start a new episode after this long apart. */
const EPISODE_GAP_MS = 5 * HOUR;
/**
 * The stretches in which a Claude window stood at 100% or more: from its
 * first such reading to the window's reset. Within a period the % never
 * falls, so once a window reads 100% it is spent until it resets.
 */
export function spentSpans(readings) {
    const out = [];
    for (const w of CLAUDE_WINDOWS) {
        const rs = cleanReadings(readings.filter((r) => r.app === "claude" && r.window === w));
        let open;
        const close = (next) => {
            if (!open)
                return;
            const end = Math.min(open.resetsAt ?? Infinity, next ?? Infinity);
            out.push({ window: w, from: open.from, to: Number.isFinite(end) ? end : open.last + HEADER_STALE_MS, ...(open.resetsAt !== undefined ? { resetsAt: open.resetsAt } : {}) });
            open = undefined;
        };
        for (const r of rs) {
            if (open) {
                const same = open.resetsAt !== undefined && r.resetsAt !== undefined ? Math.abs(open.resetsAt - r.resetsAt) <= SAME_RESET_MS : r.pct >= 100;
                if (same && !(open.resetsAt !== undefined && r.ts >= open.resetsAt)) {
                    open.last = r.ts;
                    continue;
                }
                close(r.ts);
            }
            if (r.pct >= 100)
                open = { window: w, from: r.ts, to: 0, last: r.ts, ...(r.resetsAt !== undefined ? { resetsAt: r.resetsAt } : {}) };
        }
        close();
    }
    return out.sort((a, b) => a.from - b.from);
}
/** The newest credits reading with an in-use word at or just after `ts`, if it still speaks for `ts`. */
function headerAt(overage, ts) {
    let lo = 0, hi = overage.length - 1, at = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (overage[mid].ts <= ts + HEADER_LAG_MS) {
            at = mid;
            lo = mid + 1;
        }
        else
            hi = mid - 1;
    }
    for (let i = at; i >= 0; i--) {
        const o = overage[i];
        if (ts - o.ts > HEADER_STALE_MS)
            return undefined;
        if (o.inUse !== undefined)
            return o;
    }
    return undefined;
}
/**
 * Sort requests (anything with a time and dollars: limits' usage points,
 * spend's items) into runs past the limit. A request counts when the
 * credits reading that speaks for it says in use, or, with no such
 * reading, when it falls in a spent window and extra usage is not off.
 */
export function creditsOf(points, inp) {
    const overage = [...inp.overage].sort((a, b) => a.ts - b.ts);
    const spans = spentSpans(inp.readings);
    const infer = inp.extraUsage?.enabled !== false;
    const spanAt = (ts) => {
        let best;
        for (const s of spans)
            if (ts > s.from && ts <= s.to && (!best || s.to > best.to))
                best = s;
        return best;
    };
    const episodes = [];
    let key;
    for (const p of [...points].sort((a, b) => a.ts - b.ts)) {
        if (p.ts > inp.now)
            continue;
        const h = headerAt(overage, p.ts);
        let how;
        let span;
        if (h) {
            if (!h.inUse)
                continue;
            how = "headers";
            span = spanAt(p.ts);
        }
        else if (infer) {
            span = spanAt(p.ts);
            if (span)
                how = "inferred";
        }
        if (!how)
            continue;
        const k = span ? `${span.window}:${span.from}` : "headers";
        let e = episodes[episodes.length - 1];
        if (!e || k !== key || (!span && p.ts - e.last > EPISODE_GAP_MS)) {
            // An episode the API's replies alone mark ran out at the first reply that said so in this run.
            const firstInUse = !span && h ? overage.filter((o) => o.inUse && o.ts <= p.ts + HEADER_LAG_MS && p.ts - o.ts <= EPISODE_GAP_MS).reduce((m, o) => Math.min(m, o.ts), h.ts) : p.ts;
            e = {
                ...(span ? { window: span.window } : {}),
                ranOutAt: span ? span.from : firstInUse,
                ...(span?.resetsAt !== undefined ? { resetsAt: span.resetsAt } : {}),
                current: false, first: p.ts, last: p.ts, requests: 0, usd: 0, fromHeaders: 0, inferred: 0,
            };
            episodes.push(e);
            key = k;
        }
        e.last = p.ts;
        e.requests++;
        e.usd += p.usd;
        if (how === "headers")
            e.fromHeaders++;
        else
            e.inferred++;
    }
    // Still past it: the window has not reset, or the newest credits reading says in use and still stands.
    const newest = [...overage].reverse().find((o) => o.inUse !== undefined);
    for (const e of episodes) {
        const span = e.window ? spans.find((s) => s.window === e.window && s.from === e.ranOutAt) : undefined;
        e.current = span ? inp.now < span.to && (span.resetsAt !== undefined || inp.now - e.last <= HEADER_STALE_MS) : Boolean(newest?.inUse && inp.now - newest.ts <= HEADER_STALE_MS && newest.ts >= e.first - HEADER_LAG_MS);
    }
    return {
        episodes,
        requests: episodes.reduce((n, e) => n + e.requests, 0),
        usd: episodes.reduce((n, e) => n + e.usd, 0),
        fromHeaders: episodes.reduce((n, e) => n + e.fromHeaders, 0),
        inferred: episodes.reduce((n, e) => n + e.inferred, 0),
    };
}
/** The ledger's readings for a period starting at `since`, a week earlier too (a weekly window spent before it still counts in it). */
export function creditsInputs(since, opts = {}) {
    const now = opts.now ?? Date.now();
    const path = opts.logPath ?? limitsLogPath();
    const from = since - 7 * DAY;
    const readings = readClaudeReadings(from, path);
    const overage = readOverageReadings(from, path);
    const extraUsage = opts.extraUsage === null ? undefined : opts.extraUsage ?? (spentSpans(readings).length ? readExtraUsage(opts.home) : undefined);
    return { readings, overage, ...(extraUsage ? { extraUsage } : {}), now };
}
/** Nothing in the ledger could put a request past the limit: no spent window, no reply that said credits were in use. */
export function nothingPast(inp) {
    return !inp.overage.some((o) => o.inUse) && (inp.extraUsage?.enabled === false || !spentSpans(inp.readings).length);
}
/**
 * The last `days` days of Claude Code past the plan's limit, for `limits`:
 * the ledger, and the transcripts only when the ledger says something was.
 * Undefined when nothing was.
 */
export function creditsReport(days = 30, opts = {}) {
    const now = opts.now ?? Date.now();
    return creditsSince(now - days * DAY, { ...opts, now });
}
/** The same from `since` to now (`budget`'s day or week). Undefined when nothing was past the limit. */
export function creditsSince(since, opts = {}) {
    const now = opts.now ?? Date.now();
    const inp = creditsInputs(since, { ...opts, now });
    if (nothingPast(inp))
        return undefined;
    const starts = [...spentSpans(inp.readings).map((s) => s.from), ...inp.overage.filter((o) => o.inUse).map((o) => o.ts - HEADER_STALE_MS)];
    const usage = claudeUsage(Math.max(since, Math.min(...starts)), now, opts.claudePaths).filter((p) => p.ts >= since);
    const s = creditsOf(usage, inp);
    return s.requests ? { ...s, ...(inp.extraUsage ? { extraUsage: inp.extraUsage } : {}) } : undefined;
}
// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------
/** "$41.20", "$4.02", "$130". */
const dollars = (v) => (v >= 100 ? `$${Math.round(v).toLocaleString("en-US")}` : v > 0 && v < 0.005 ? "<$0.01" : `$${v.toFixed(2)}`);
/** "at 14:05" within the day, else "on Tue, Nov 17 at 14:05": local time. */
export function whenText(ms, now) {
    const d = new Date(ms);
    const t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return Math.abs(ms - now) < 20 * HOUR ? `at ${t}` : `on ${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} at ${t}`;
}
const WINDOW_NAME = { seven_day: "weekly limit", five_hour: "5-hour limit" };
/** The dollars, in the words every report uses: list prices, an estimate. */
export const AT_LIST_PRICES = "at API list prices (an estimate)";
/**
 * One episode in plain words: "Your weekly limit ran out on Tue, Nov 17 at
 * 14:05; 37 requests after that were paid from usage credits, about $41.20
 * at API list prices (an estimate)." Inferred ones say so.
 */
export function episodeLine(e, now) {
    const head = e.window ? `Your ${WINDOW_NAME[e.window]} ran out ${whenText(e.ranOutAt, now)}` : `Past your plan's limit from ${whenText(e.ranOutAt, now).replace(/^(at|on) /, "")}`;
    const n = `${e.requests.toLocaleString("en-US")} ${e.requests === 1 ? "request" : "requests"}`;
    const after = e.window ? " after that" : "";
    const paid = !e.inferred
        ? `${n}${after} ${e.requests === 1 ? "was" : "were"} paid from usage credits`
        : !e.fromHeaders
            ? `${n}${after} still went through, so most likely on usage credits (inferred)`
            : `${n}${after} ${e.requests === 1 ? "was" : "were"} paid from usage credits (${e.fromHeaders.toLocaleString("en-US")} as the API's replies said, ${e.inferred.toLocaleString("en-US")} inferred)`;
    const still = e.current ? (e.resetsAt !== undefined ? ` Still past it; it resets ${whenText(e.resetsAt, now)}.` : " Still past it.") : "";
    return `${head}; ${paid}, about ${dollars(e.usd)} ${AT_LIST_PRICES}.${still}`;
}
/** Lines for `limits`: one per episode, newest last, and what "inferred" and the dollars mean when it applies. */
export function creditsLines(r, now) {
    if (!r.requests)
        return [];
    const out = r.episodes.map((e) => episodeLine(e, now));
    if (r.inferred)
        out.push("Inferred: Claude Code's readings stop at 100% and say nothing about credits; a request that still went through past it was most likely paid from them (the proxy, `context-doctor autopilot on`, reads the API's own word).");
    out.push("Whether usage credits bill at exactly API list prices is not confirmed: the dollars are an estimate; your Claude account's usage page has the bill.");
    return out;
}
const REASON_WORDS = {
    out_of_credits: "out of credits",
    overage_not_provisioned: "not set up for this account",
    org_level_disabled: "turned off for the organization",
    org_level_disabled_until: "the spend cap is reached until it resets",
    seat_tier_level_disabled: "off for this seat type",
    member_level_disabled: "turned off for your seat",
    seat_tier_zero_credit_limit: "a credit limit of zero for this seat type",
    group_zero_credit_limit: "a credit limit of zero for your group",
    member_zero_credit_limit: "a credit limit of zero for your seat",
    org_service_level_disabled: "off for the organization's service",
    no_limits_configured: "no credit limit configured",
};
/**
 * `doctor`'s line on extra usage, from `~/.claude.json`: on, on but held
 * back (and why), or off. Undefined when the file says nothing (an API key,
 * never signed in).
 */
export function extraUsageText(x) {
    if (!x || x.enabled === undefined)
        return undefined;
    if (!x.enabled)
        return { on: false, text: "off: when a plan limit runs out, Claude Code stops until it resets; nothing is paid from usage credits" };
    const held = typeof x.disabledReason === "string" && x.disabledReason !== "fetch_error" && x.disabledReason !== "unknown"
        ? `, but the last reply said credits are not paying now (${REASON_WORDS[x.disabledReason] ?? x.disabledReason.replace(/_/g, " ")})`
        : "";
    return { on: true, text: `on${held}: when a plan limit runs out, Claude Code keeps working and the requests are paid from usage credits, real money. \`context-doctor limits\` and \`spend\` say how much` };
}
