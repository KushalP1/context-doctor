/**
 * `context-doctor limits`: your plan's usage limits, in their own unit.
 *
 * Subscriptions are billed in % of a 5-hour and a weekly window (Claude
 * Pro/Max), or in credits per token (Codex since April 2026), and neither
 * vendor shows where the percentage went. Two local sources say:
 *
 *  - Claude Code hands its status line command `rate_limits.five_hour` and
 *    `.seven_day`, each `{used_percentage, resets_at}` (documented at
 *    code.claude.com/docs/en/statusline; built in 2.1.308 as
 *    Math.round(utilization*1000)/10, so 0.1% steps; present only for
 *    Pro/Max subscribers, after the first reply). `context-doctor statusline`
 *    appends each new reading to a small local log (recordLimits).
 *  - Codex records `rate_limits.primary` / `.secondary`
 *    `{used_percent, window_minutes, resets_at}` on every token_count event of
 *    its rollouts (~/.codex/sessions), next to that request's usage, in
 *    whole percent.
 *
 * From the readings: the current %, the pace, and when each window runs out
 * at that pace. And, by fitting each rise in % against the usage recorded on
 * this machine over the same interval, an estimate of what 1M tokens of each
 * kind cost in % of the limit, with the fit's error. Usage elsewhere (claude.ai
 * in a browser, another computer) moves the % without leaving a transcript
 * here; it shows up as error, and rises with no local usage at all are
 * counted apart. When the fit is too thin to trust, the report says so
 * instead of printing a number.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { statePath } from "./ledger.js";
import { forEachLine, listSessions, outputSettler, replyCounter, isClaudeSession } from "./session.js";
import { subagentDir } from "./subagents.js";
import { openAIUsage, pricingFor, usageCost } from "./pricing.js";
import { realModel } from "./tokens.js";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Claude Code's two windows, as its status line input names them. */
export const CLAUDE_WINDOWS = ["five_hour", "seven_day"];
// ---------------------------------------------------------------------------
// The Claude readings log, written by the status line
// ---------------------------------------------------------------------------
/** Beside the hook state and the ledger: ~/.claude/.context-doctor-limits.jsonl. */
export function limitsLogPath() {
    return join(dirname(statePath()), ".context-doctor-limits.jsonl");
}
/** An unchanged reading is written again after this long, so the log says the window was still there. */
const KEEPALIVE_MS = 15 * MIN;
/** A window that moved is written at most once a minute: plenty for stretches of half an hour. */
const THROTTLE_MS = MIN;
/**
 * Past this size the log keeps its newest LOG_KEEP_BYTES. At the throttle a
 * window writes at most one ~75-byte line a minute: a heavy user (both
 * windows moving 16 hours a day) writes ~140 KB a day, so 1.5 MB holds over
 * a week of the heaviest use.
 */
const LOG_ROTATE_AT = 2 * 1024 * 1024;
const LOG_KEEP_BYTES = 1536 * 1024;
/** Two reset times this close name the same window period (Claude Code rounds; Codex re-reports). */
const SAME_RESET_MS = 10 * MIN;
/** The last `bytes` of a file as text (the first line of it may be partial). */
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
function parseLogLine(line) {
    let e;
    try {
        e = JSON.parse(line);
    }
    catch {
        return undefined;
    }
    if (!e || typeof e !== "object")
        return undefined;
    const { ts, w, pct, reset } = e;
    if (typeof ts !== "number" || !Number.isFinite(ts) || typeof w !== "string" || !CLAUDE_WINDOWS.includes(w))
        return undefined;
    if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 1000)
        return undefined;
    return { ts, app: "claude", w, pct, reset: typeof reset === "number" && Number.isFinite(reset) && reset > 0 ? reset : undefined };
}
/**
 * Append what changed in Claude Code's `rate_limits` to the log: a window
 * whose % or reset time moved since its last line, or that has not been
 * written for 15 minutes. Nothing when there are no limits (an API key,
 * Bedrock, Vertex). Never throws: the status line must stay silent. Returns
 * the lines written.
 */
export function recordLimits(rateLimits, now = Date.now(), path = limitsLogPath()) {
    if (!rateLimits || typeof rateLimits !== "object")
        return 0;
    const fresh = [];
    for (const w of CLAUDE_WINDOWS) {
        const r = rateLimits[w];
        const pct = r?.used_percentage;
        if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 1000)
            continue;
        const reset = typeof r.resets_at === "number" && Number.isFinite(r.resets_at) && r.resets_at > 0 ? Math.round(r.resets_at) : undefined;
        fresh.push({ ts: now, app: "claude", w, pct: Math.round(pct * 10) / 10, ...(reset ? { reset } : {}) });
    }
    if (!fresh.length)
        return 0;
    try {
        mkdirSync(dirname(path), { recursive: true });
        const last = new Map();
        if (existsSync(path)) {
            for (const line of tail(path, 16 * 1024).split("\n")) {
                const l = parseLogLine(line);
                if (l)
                    last.set(l.w, l);
            }
        }
        const due = fresh.filter((l) => {
            const p = last.get(l.w);
            if (!p || now < p.ts)
                return true;
            const sameReset = p.reset !== undefined && l.reset !== undefined ? Math.abs(p.reset - l.reset) * 1000 <= SAME_RESET_MS : p.reset === l.reset;
            if (!sameReset)
                return true;
            // Lower than the last reading of the same window period: another Claude
            // Code session's status line still holding an older figure. Usage within
            // a period never goes down, so it is never logged.
            if (l.pct < p.pct)
                return false;
            if (l.pct === p.pct)
                return now - p.ts >= KEEPALIVE_MS;
            return now - p.ts >= THROTTLE_MS;
        });
        if (!due.length)
            return 0;
        if (existsSync(path) && statSync(path).size > LOG_ROTATE_AT) {
            const text = tail(path, LOG_KEEP_BYTES);
            writeFileSync(path, text.slice(text.indexOf("\n") + 1));
        }
        appendFileSync(path, due.map((l) => JSON.stringify(l)).join("\n") + "\n");
        return due.length;
    }
    catch {
        return 0;
    }
}
/** Every Claude reading in the log since `since`. */
export function readClaudeReadings(since = 0, path = limitsLogPath()) {
    if (!existsSync(path))
        return [];
    let text;
    try {
        text = readFileSync(path, "utf8");
    }
    catch {
        return [];
    }
    const out = [];
    for (const line of text.split("\n")) {
        const l = parseLogLine(line);
        if (!l || l.ts < since)
            continue;
        out.push({ ts: l.ts, app: "claude", window: l.w, pct: l.pct, resetsAt: l.reset ? l.reset * 1000 : undefined, windowMs: l.w === "five_hour" ? 5 * HOUR : 7 * DAY });
    }
    return out.sort((a, b) => a.ts - b.ts);
}
// ---------------------------------------------------------------------------
// Codex: readings and usage, both from its rollouts
// ---------------------------------------------------------------------------
export function codexSessionsRoot(home = homedir()) {
    return join(home, ".codex", "sessions");
}
function rolloutFiles(root, since) {
    const out = [];
    const walk = (dir, depth) => {
        let names;
        try {
            names = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const name of names) {
            const p = join(dir, name);
            let st;
            try {
                st = statSync(p);
            }
            catch {
                continue;
            }
            if (st.isDirectory()) {
                if (depth < 3)
                    walk(p, depth + 1);
            }
            else if (name.endsWith(".jsonl") && st.mtimeMs >= since) {
                out.push(p);
            }
        }
    };
    walk(root, 0);
    return out;
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
/** "codex:300", "codex:10080"; a limit id other than "codex" is kept in the key. */
function codexWindow(limitId, minutes, plan) {
    // The plan is part of the key: two sign-ins (a team plan, a free one) are two accounts' limits.
    const p = typeof plan === "string" && /^[\w-]{1,20}$/.test(plan) ? `${plan}:` : "";
    return typeof limitId === "string" && limitId && limitId !== "codex" ? `codex:${p}${limitId.slice(0, 40)}:${minutes}` : `codex:${p}${minutes}`;
}
/**
 * Codex readings and usage since `since`. A token_count event repeats the
 * last request's usage when only the limits were refreshed, so a request is
 * counted when the running total moves.
 */
export function codexLimitData(since, root = codexSessionsRoot()) {
    const readings = [];
    const usage = [];
    if (!existsSync(root))
        return { readings, usage };
    for (const file of rolloutFiles(root, since)) {
        let model;
        let total = -1;
        try {
            forEachLine(file, (line) => {
                if (!line.includes('"token_count"') && !line.includes('"turn_context"'))
                    return;
                let e;
                try {
                    e = JSON.parse(line);
                }
                catch {
                    return;
                }
                const p = e?.payload;
                if (!p || typeof p !== "object")
                    return;
                if (e.type === "turn_context") {
                    if (typeof p.model === "string")
                        model = p.model;
                    return;
                }
                if (e.type !== "event_msg" || p.type !== "token_count")
                    return;
                const ts = Date.parse(String(e.timestamp ?? ""));
                if (!Number.isFinite(ts) || ts < since)
                    return;
                const runTotal = num(p.info?.total_token_usage?.total_tokens);
                const last = p.info?.last_token_usage;
                // No running total recorded: every event is a request.
                if (last && num(last.input_tokens) > 0 && (runTotal === 0 || runTotal !== total)) {
                    total = runTotal;
                    const u = openAIUsage(last);
                    const price = pricingFor(model);
                    usage.push({ ts, app: "codex", model, input: num(u.input_tokens), read: num(u.cache_read_input_tokens), write: num(u.cache_creation_input_tokens), output: num(u.output_tokens), usd: price ? usageCost(u, price).totalUsd : 0 });
                }
                const rl = p.rate_limits;
                if (!rl || typeof rl !== "object")
                    return;
                for (const slot of ["primary", "secondary"]) {
                    const w = rl[slot];
                    const pct = w?.used_percent;
                    const minutes = num(w?.window_minutes);
                    if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 1000 || !minutes)
                        continue;
                    const reset = num(w.resets_at);
                    readings.push({ ts, app: "codex", window: codexWindow(rl.limit_id, minutes, rl.plan_type), pct, resetsAt: reset ? reset * 1000 : undefined, windowMs: minutes * MIN, plan: typeof rl.plan_type === "string" ? rl.plan_type.slice(0, 20) : undefined });
                }
            });
        }
        catch {
            /* one unreadable rollout must not sink the report */
        }
    }
    readings.sort((a, b) => a.ts - b.ts);
    usage.sort((a, b) => a.ts - b.ts);
    return { readings, usage };
}
// ---------------------------------------------------------------------------
// Claude usage: every request on this machine, subagents included
// ---------------------------------------------------------------------------
/**
 * Every Claude Code request between `since` and `until`, main threads and
 * subagents alike (both draw on the same limits), each reply once.
 */
export function claudeUsage(since, until = Infinity, paths) {
    const tops = paths ?? listSessions(10_000).filter((s) => isClaudeSession(s) && s.modifiedAt.getTime() >= since).map((s) => s.path);
    const files = [];
    for (const t of tops) {
        files.push(t);
        const dir = subagentDir(t);
        try {
            for (const f of readdirSync(dir))
                if (f.endsWith(".jsonl") && statSync(join(dir, f)).mtimeMs >= since)
                    files.push(join(dir, f));
        }
        catch {
            /* no subagents */
        }
    }
    const out = [];
    const runRows = new Set();
    for (const file of files) {
        const sighting = replyCounter(runRows);
        const settle = outputSettler();
        const byId = new Map();
        try {
            forEachLine(file, (line) => {
                if (!line.includes('"usage"'))
                    return;
                let e;
                try {
                    e = JSON.parse(line);
                }
                catch {
                    return;
                }
                const m = e?.message;
                if (e?.type !== "assistant" || !m?.usage)
                    return;
                const seen = sighting(e);
                if (seen === "repeat") {
                    const known = typeof m.id === "string" ? byId.get(m.id) : undefined;
                    const more = settle(e, false);
                    if (known && more) {
                        known.point.output += more;
                        if (known.price)
                            known.point.usd += (more * known.price.outputPerM) / 1e6;
                    }
                    return;
                }
                if (seen !== "new")
                    return;
                settle(e, true);
                const ts = Date.parse(String(e.timestamp ?? ""));
                if (!Number.isFinite(ts) || ts < since || ts > until)
                    return;
                const u = m.usage;
                const point = { ts, app: "claude", model: realModel(m.model), input: num(u.input_tokens), read: num(u.cache_read_input_tokens), write: num(u.cache_creation_input_tokens), output: num(u.output_tokens), usd: 0 };
                if (point.input + point.read + point.write === 0)
                    return;
                const price = pricingFor(point.model);
                if (price)
                    point.usd = usageCost(u, price).totalUsd;
                out.push(point);
                if (typeof m.id === "string")
                    byId.set(m.id, { point, price });
            });
        }
        catch {
            /* skip an unreadable transcript */
        }
    }
    return out.sort((a, b) => a.ts - b.ts);
}
export function windowLabel(window, windowMs) {
    if (window === "five_hour")
        return "Claude 5-hour";
    if (window === "seven_day")
        return "Claude weekly";
    const parts = window.split(":").slice(1);
    const minutes = windowMs ? Math.round(windowMs / MIN) : Number(parts[parts.length - 1]);
    const span = minutes === 300 ? "5-hour" : minutes === 10_080 ? "weekly" : minutes >= 43_000 && minutes <= 44_700 ? "monthly" : minutes % 1440 === 0 ? `${minutes / 1440}-day` : `${minutes}-minute`;
    const tags = parts.slice(0, -1);
    return `Codex ${span}${tags.length ? ` (${tags.join(", ")})` : ""}`;
}
/** Two readings of one window belong to the same period: the reset did not move (or, with no reset known, the % did not fall), and the first's reset had not passed. */
function samePeriod(a, b, resolution) {
    if (a.resetsAt !== undefined && b.resetsAt !== undefined) {
        if (Math.abs(a.resetsAt - b.resetsAt) > SAME_RESET_MS)
            return false;
    }
    else if (b.pct < a.pct - resolution)
        return false;
    if (a.resetsAt !== undefined && b.ts > a.resetsAt)
        return false;
    if (a.windowMs && b.ts - a.ts > a.windowMs)
        return false;
    return true;
}
/**
 * One window's readings, in time order, without the stale ones: a reading
 * lower than an earlier one of the same period comes from another session
 * (two Claude Code windows, two Codex sessions) still holding an older
 * figure. Within a period usage only grows, so it is dropped, never read as
 * a new period or a fall in the pace. Logs written before 0.38 hold them.
 */
export function cleanReadings(readings) {
    const sorted = [...readings].sort((a, b) => a.ts - b.ts);
    const out = [];
    let top;
    for (const r of sorted) {
        if (top && r.resetsAt !== undefined && top.resetsAt !== undefined && Math.abs(r.resetsAt - top.resetsAt) <= SAME_RESET_MS && !(top.resetsAt !== undefined && r.ts > top.resetsAt) && r.pct < top.pct)
            continue;
        out.push(r);
        top = !top || !samePeriod(top, r, 0.1) || r.pct >= top.pct ? r : top;
    }
    return out;
}
/** 0.1 when any reading has a fraction (Claude), else 1 (Codex's whole percents). */
export function resolutionOf(readings) {
    return readings.some((r) => Math.abs(r.pct - Math.round(r.pct)) > 1e-9) ? 0.1 : 1;
}
export function windowStatus(readings, now = Date.now()) {
    if (!readings.length)
        return undefined;
    const last = readings[readings.length - 1];
    const res = resolutionOf(readings);
    const status = {
        window: last.window,
        label: windowLabel(last.window, last.windowMs),
        app: last.app,
        pct: last.pct,
        at: last.ts,
        resetsAt: last.resetsAt,
        resetSince: last.resetsAt !== undefined && last.resetsAt <= now,
        readings: readings.length,
        plan: last.plan,
    };
    if (status.resetSince)
        return status;
    // The current period: back from the newest reading while the period holds.
    let first = readings.length - 1;
    while (first > 0 && samePeriod(readings[first - 1], readings[first], res))
        first--;
    const period = readings.slice(first);
    const lookback = last.windowMs && last.windowMs <= 5 * HOUR ? HOUR : DAY;
    const recent = period.filter((r) => r.ts >= last.ts - lookback);
    const from = recent[0];
    if (from && last.ts - from.ts >= 10 * MIN) {
        status.recentPerHour = Math.max(0, ((last.pct - from.pct) / (last.ts - from.ts)) * HOUR);
    }
    if (last.windowMs && last.resetsAt) {
        const start = last.resetsAt - last.windowMs;
        if (last.ts - start >= 10 * MIN)
            status.averagePerHour = Math.max(0, (last.pct / (last.ts - start)) * HOUR);
    }
    if (status.recentPerHour && status.recentPerHour > 0 && last.pct < 100) {
        status.runsOutAt = last.ts + ((100 - last.pct) / status.recentPerHour) * HOUR;
        status.beforeReset = last.resetsAt === undefined || status.runsOutAt < last.resetsAt;
    }
    return status;
}
export const TOKEN_TYPES = ["input", "cache read", "cache write", "output"];
/**
 * Cut each period into stretches of at least `stretchMs` (half an hour on
 * Claude's 0.1% steps, three hours on Codex's whole percents) and sum the
 * usage that falls inside each. Cut by time, not by rise: stretches then
 * differ in how much was used, which is what the fit learns from, and a
 * quiet stretch says as much as a busy one. A rise with no local usage at
 * all is usage elsewhere: counted, kept out of the fit; a quiet stretch with
 * no rise is left out.
 */
export function segmentsOf(readings, usage, stretchMs) {
    readings = cleanReadings(readings);
    const res = resolutionOf(readings);
    const cut = stretchMs ?? (res < 1 ? 30 * MIN : 3 * HOUR);
    const segments = [];
    let elsewhere = 0, elsewherePct = 0;
    let u = 0;
    const usageIn = (from, to) => {
        while (u < usage.length && usage[u].ts <= from)
            u++;
        const x = [0, 0, 0, 0];
        let usd = 0, requests = 0;
        let j = u;
        for (; j < usage.length && usage[j].ts <= to; j++) {
            const p = usage[j];
            x[0] += p.input / 1e6;
            x[1] += p.read / 1e6;
            x[2] += p.write / 1e6;
            x[3] += p.output / 1e6;
            usd += p.usd;
            requests++;
        }
        u = j;
        return { x, usd, requests };
    };
    let start;
    const close = (end) => {
        if (!start || end.ts <= start.ts)
            return;
        const dpct = Math.max(0, end.pct - start.pct);
        const got = usageIn(start.ts, end.ts);
        if (got.requests === 0) {
            if (dpct > res / 2) {
                elsewhere++;
                elsewherePct += dpct;
            }
        }
        else {
            segments.push({ from: start.ts, to: end.ts, dpct, ...got });
        }
        start = end;
    };
    for (let i = 0; i < readings.length; i++) {
        const r = readings[i];
        if (!start) {
            start = r;
            continue;
        }
        const prev = readings[i - 1];
        if (!samePeriod(prev, r, res)) {
            close(prev);
            start = r;
            continue;
        }
        if (r.ts - start.ts >= cut)
            close(r);
    }
    if (start && readings.length && readings[readings.length - 1] !== start)
        close(readings[readings.length - 1]);
    return { segments, elsewhere, elsewherePct };
}
/** Least squares through the origin on the chosen columns; undefined when singular. */
function ols(rows, y, cols) {
    const k = cols.length;
    if (k === 0)
        return [];
    const a = Array.from({ length: k }, () => new Array(k + 1).fill(0));
    for (let i = 0; i < rows.length; i++) {
        for (let p = 0; p < k; p++) {
            for (let q = 0; q < k; q++)
                a[p][q] += rows[i][cols[p]] * rows[i][cols[q]];
            a[p][k] += rows[i][cols[p]] * y[i];
        }
    }
    // Gauss-Jordan with partial pivoting.
    for (let c = 0; c < k; c++) {
        let piv = c;
        for (let r = c + 1; r < k; r++)
            if (Math.abs(a[r][c]) > Math.abs(a[piv][c]))
                piv = r;
        const scale = Math.max(1e-300, ...a.map((row) => Math.abs(row[c])));
        if (Math.abs(a[piv][c]) < 1e-12 * scale)
            return undefined;
        [a[c], a[piv]] = [a[piv], a[c]];
        for (let r = 0; r < k; r++) {
            if (r === c)
                continue;
            const f = a[r][c] / a[c][c];
            for (let q = c; q <= k; q++)
                a[r][q] -= f * a[c][q];
        }
    }
    return cols.map((_, p) => a[p][k] / a[p][p]);
}
/**
 * Non-negative least squares through the origin, exactly, by trying every
 * subset of columns (four token types: sixteen subsets) and keeping the best
 * fit whose coefficients are all non-negative. Columns with almost no data
 * are left out and reported as such.
 */
export function nnls(rows, y, usable) {
    const width = rows[0]?.length ?? 0;
    let best = { sse: y.reduce((s, v) => s + v * v, 0), coef: new Array(width).fill(0) };
    const n = usable.length;
    for (let mask = 1; mask < 1 << n; mask++) {
        const cols = usable.filter((_, i) => mask & (1 << i));
        const b = ols(rows, y, cols);
        if (!b || b.some((v) => v < 0))
            continue;
        const coef = new Array(width).fill(0);
        cols.forEach((c, i) => (coef[c] = b[i]));
        let sse = 0;
        for (let i = 0; i < rows.length; i++) {
            const r = y[i] - rows[i].reduce((s, v, j) => s + v * coef[j], 0);
            sse += r * r;
        }
        if (sse < best.sse - 1e-15)
            best = { sse, coef };
    }
    return best.coef;
}
function quality(y, predictHeldOut, predictAll) {
    const n = y.length;
    const mean = y.reduce((s, v) => s + v, 0) / n;
    let sst = 0, sse = 0, cv = 0;
    for (let i = 0; i < n; i++) {
        sst += (y[i] - mean) ** 2;
        sse += (y[i] - predictAll(i)) ** 2;
        cv += (y[i] - predictHeldOut(i)) ** 2;
    }
    const looRmse = Math.sqrt(cv / n);
    return { r2: sst > 0 ? 1 - sse / sst : 0, looRmse, relError: mean > 0 ? looRmse / mean : Infinity };
}
/**
 * When a figure is worth quoting. The gate is on how sure the coefficient
 * itself is (its standard error, which only shrinks as readings accrue, so
 * the savings lines do not come and go from one run to the next), not on R²:
 * stretches of similar size explain little variation even when the
 * coefficient is exact. Predictions per stretch may miss by up to a typical
 * rise (the readings' rounding alone is a large part of a small rise).
 */
const MIN_SEGMENTS = 8;
const MAX_REL_SE = 0.15;
/** The slope with an intercept at least ~3 standard errors above zero. */
const MAX_SLOPE_REL_SE = 0.3;
const MAX_REL_ERROR = 1;
/** Above this share of the rises with no local usage to match, the limit is visibly shared with other use. */
const MAX_ELSEWHERE = 0.1;
/** Folds for cross-validating the per-type fit: leave-one-out is quadratic in the stretches. */
const FOLDS = 10;
export function fitWindow(readings, usage, stretchMs) {
    if (!readings.length)
        return undefined;
    const last = readings[readings.length - 1];
    const res = resolutionOf(readings);
    const { segments, elsewhere, elsewherePct } = segmentsOf(readings, usage, stretchMs);
    const fit = {
        window: last.window,
        label: windowLabel(last.window, last.windowMs),
        app: last.app,
        segments: segments.length,
        totalPct: segments.reduce((s, g) => s + g.dpct, 0),
        elsewhere,
        elsewherePct,
        resolution: res,
        requests: segments.reduce((s, g) => s + g.requests, 0),
        usd: segments.reduce((s, g) => s + g.usd, 0),
        usable: false,
    };
    // Dollars per model inside the stretches: both lists are in time order, one pass.
    const byModel = new Map();
    let g = 0;
    for (const p of usage) {
        while (g < segments.length && segments[g].to < p.ts)
            g++;
        if (g >= segments.length)
            break;
        if (p.model && p.ts > segments[g].from)
            byModel.set(p.model, (byModel.get(p.model) ?? 0) + p.usd);
    }
    fit.mainModel = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (segments.length < 3) {
        fit.why = `${segments.length} stretch${segments.length === 1 ? "" : "es"} of readings with usage beside ${segments.length === 1 ? "it" : "them"}; a fit needs ${MIN_SEGMENTS}`;
        return fit;
    }
    const y = segments.map((s) => s.dpct);
    const rows = segments.map((s) => s.x);
    // A token type with under 50k tokens across the segments is not estimated:
    // its coefficient would be noise. (Output is a small share of the tokens
    // and can still carry much of the limit, so a share rule would drop it.)
    const totals = [0, 1, 2, 3].map((j) => rows.reduce((a, r) => a + r[j], 0));
    const usable = [0, 1, 2, 3].filter((j) => totals[j] >= 0.05);
    if (usable.length) {
        const coef = nnls(rows, y, usable);
        const predict = (c, i) => rows[i].reduce((a, v, j) => a + v * c[j], 0);
        const folds = Math.min(FOLDS, rows.length);
        const foldCoef = Array.from({ length: folds }, (_, f) => nnls(rows.filter((_, i) => i % folds !== f), y.filter((_, i) => i % folds !== f), usable));
        fit.byType = quality(y, (i) => predict(foldCoef[i % folds], i), (i) => predict(coef, i));
        fit.perMillion = {};
        usable.forEach((j) => (fit.perMillion[TOKEN_TYPES[j]] = coef[j]));
    }
    let usd = segments.map((s) => s.usd);
    let sxy = usd.reduce((a, x, i) => a + x * y[i], 0);
    let sxx = usd.reduce((a, x) => a + x * x, 0);
    // A stretch that rose far more than its usage explains carries usage from
    // elsewhere (the web app, another computer, in the same half hour): one
    // robust pass drops those (residual over 3x the median absolute residual,
    // upwards only) and refits, so a burst elsewhere does not inflate the rate.
    if (sxx > 0 && usd.length >= MIN_SEGMENTS) {
        const k0 = Math.max(0, sxy / sxx);
        const resid = y.map((v, i) => v - k0 * usd[i]);
        const scale = 1.4826 * [...resid].map(Math.abs).sort((a, b) => a - b)[Math.floor(resid.length / 2)];
        const keep = resid.map((r) => !(scale > 0 && r > 3 * scale));
        const dropped = keep.filter((x) => !x).length;
        if (dropped > 0 && dropped <= resid.length / 4) {
            fit.outliers = dropped;
            fit.outlierPct = y.reduce((a, v, i) => a + (keep[i] ? 0 : v - k0 * usd[i]), 0);
            const yk = y.filter((_, i) => keep[i]);
            usd = usd.filter((_, i) => keep[i]);
            y.splice(0, y.length, ...yk);
            sxy = usd.reduce((a, x, i) => a + x * y[i], 0);
            sxx = usd.reduce((a, x) => a + x * x, 0);
        }
    }
    if (sxx > 0) {
        const k = Math.max(0, sxy / sxx);
        fit.pctPerUsd = k;
        // Leave-one-out in closed form: the fit without stretch i.
        const held = (i) => {
            const den = sxx - usd[i] * usd[i];
            return den > 0 ? Math.max(0, (sxy - usd[i] * y[i]) / den) * usd[i] : k * usd[i];
        };
        fit.byPrice = quality(y, held, (i) => k * usd[i]);
        const sse = y.reduce((a, v, i) => a + (v - k * usd[i]) ** 2, 0);
        const se = Math.sqrt(sse / Math.max(1, y.length - 1) / sxx);
        fit.byPrice.relSe = k > 0 ? se / k : Infinity;
        // Does usage drive the rises at all? Through the origin, any positive
        // rises against any positive usage give a rate. With an intercept, the
        // slope is clearly above zero only when busier stretches rise more.
        const n = y.length;
        const mx = usd.reduce((a, v) => a + v, 0) / n, my = y.reduce((a, v) => a + v, 0) / n;
        const cxx = usd.reduce((a, v) => a + (v - mx) ** 2, 0);
        const b = cxx > 0 ? usd.reduce((a, v, i) => a + (v - mx) * (y[i] - my), 0) / cxx : 0;
        const sseC = y.reduce((a, v, i) => a + (v - (my + b * (usd[i] - mx))) ** 2, 0);
        const seB = cxx > 0 && n > 2 ? Math.sqrt(sseC / (n - 2) / cxx) : Infinity;
        fit.slopeRelSe = b > 0 ? seB / b : Infinity;
    }
    if (segments.length < MIN_SEGMENTS)
        fit.why = `${segments.length} stretches of readings with usage beside them; ${MIN_SEGMENTS} make a fit worth quoting`;
    else if (!fit.byPrice || !(fit.pctPerUsd > 0))
        fit.why = "no priced usage beside the rises";
    else if (!(fit.slopeRelSe <= MAX_SLOPE_REL_SE))
        fit.why = "busier stretches do not rise clearly more than quiet ones: the rises do not follow the usage recorded here";
    else if (fit.byPrice.relSe > MAX_REL_SE)
        fit.why = `% per dollar is known only to ±${Math.round(fit.byPrice.relSe * 100)}% so far (under ±${Math.round(MAX_REL_SE * 100)}% is quoted): more readings narrow it`;
    else if (fit.totalPct > 0 && (fit.elsewherePct + (fit.outlierPct ?? 0)) / (fit.totalPct + fit.elsewherePct) > MAX_ELSEWHERE)
        fit.why = `${Math.round(((fit.elsewherePct + (fit.outlierPct ?? 0)) / (fit.totalPct + fit.elsewherePct)) * 100)}% of the rises came with no usage here to match: this limit is used elsewhere too, so dollars saved here would be overstated in it`;
    else if (fit.byPrice.relError > MAX_REL_ERROR)
        fit.why = `predictions miss by ${Math.round(fit.byPrice.relError * 100)}% of a typical rise: much of this limit moves with something other than the usage recorded here`;
    else
        fit.usable = true;
    return fit;
}
function byWindow(readings) {
    const m = new Map();
    for (const r of readings) {
        const list = m.get(r.window);
        if (list)
            list.push(r);
        else
            m.set(r.window, [r]);
    }
    // Stale readings from a parallel session out, once, for the status and the fit alike.
    for (const [k, list] of m)
        m.set(k, cleanReadings(list));
    return m;
}
export function limitsReport(days = 30, opts = {}) {
    const now = opts.now ?? Date.now();
    const since = now - days * DAY;
    const logPath = opts.logPath ?? limitsLogPath();
    const claude = readClaudeReadings(since, logPath);
    const codex = opts.claudeOnly ? { readings: [], usage: [] } : codexLimitData(since, opts.codexRoot);
    const windows = [];
    const fits = [];
    // Claude usage is read only when there are readings to fit it against, and only over their span.
    const claudeUse = claude.length >= 2 ? claudeUsage(claude[0].ts - HOUR, claude[claude.length - 1].ts, opts.claudePaths) : [];
    for (const [, rs] of byWindow(claude)) {
        const s = windowStatus(rs, now);
        if (s)
            windows.push(s);
        const f = fitWindow(rs, claudeUse);
        if (f)
            fits.push(f);
    }
    for (const [, rs] of byWindow(codex.readings)) {
        const s = windowStatus(rs, now);
        if (s)
            windows.push(s);
        const f = fitWindow(rs, codex.usage);
        if (f)
            fits.push(f);
    }
    return { days, now, claudeLog: logPath, claudeReadings: claude.length, codexReadings: codex.readings.length, windows, fits };
}
/** The Claude fit to quote savings in: the weekly window first (savings are weekly), then the 5-hour one. */
export function claudeLimitFit(r) {
    return ["seven_day", "five_hour"].map((w) => r.fits.find((f) => f.window === w && f.usable)).find(Boolean);
}
/**
 * A dollar saving over `days`, in the limit's own unit: for the weekly
 * limit, points of it a week ("≈ 4.1% of your weekly limit a week (±0.4)");
 * for the 5-hour window, how many whole windows the saving amounts to. The
 * ± is the rate's own standard error: a saving sums many stretches, so the
 * per-stretch miss averages out and the rate's error is what remains.
 */
export function inLimit(fit, usd, days) {
    if (!fit.usable || fit.pctPerUsd === undefined || !fit.byPrice || !(usd > 0) || !(days > 0))
        return undefined;
    const round = (v) => (v >= 10 ? Math.round(v).toString() : v.toFixed(1));
    const total = fit.pctPerUsd * usd;
    if (fit.window === "seven_day") {
        const pct = (total * 7) / days;
        return `≈ ${round(pct)}% of your weekly limit a week (±${round(pct * (fit.byPrice.relSe ?? 0))})`;
    }
    const windows = total / 100;
    return `≈ ${round(windows)} full 5-hour window${windows >= 0.95 && windows < 1.05 ? "" : "s"} in ${days} days (±${round(windows * (fit.byPrice.relSe ?? 0))})`;
}
/**
 * Lines for the Claude Code reports: each lever's saving in the limit, when
 * a fit is good enough; nothing otherwise (never a number the fit cannot
 * carry). Kept within 60 columns, as `savings` is.
 */
export function limitSavingsLines(fit, items, days) {
    if (!fit)
        return [];
    const rows = items.map(([label, usd]) => [label, inLimit(fit, usd, days)]).filter((r) => Boolean(r[1]));
    if (!rows.length)
        return [];
    const err = fit.byPrice?.relSe !== undefined ? Math.round(fit.byPrice.relSe * 100) : 0;
    return [
        `In your plan's ${fit.window === "seven_day" ? "weekly limit" : "5-hour window"} (fitted on ${fit.segments} stretches of your`,
        `readings: % per list-price dollar known to ±${err}%):`,
        ...rows.map(([label, text]) => `  ${label}: ${text}`),
    ];
}
const hm = (ms) => {
    const mins = Math.max(0, Math.round(ms / MIN));
    if (mins < 60)
        return `${mins} min`;
    if (mins < 48 * 60)
        return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
    return `${Math.round(mins / 1440)} days`;
};
/** Local clock time, with the weekday when it is not within the next day. */
function clock(ms, now) {
    const d = new Date(ms);
    const t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return Math.abs(ms - now) < 20 * HOUR ? t : `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} ${t}`;
}
const pts = (v) => (v >= 10 ? Math.round(v).toString() : v >= 1 ? v.toFixed(1) : v.toFixed(2));
export function renderLimits(r) {
    const out = ["USAGE LIMITS", "═".repeat(60)];
    if (!r.windows.length) {
        out.push("No limit readings yet.", "", "Claude (Pro and Max): `context-doctor statusline` records the 5-hour and weekly", "windows as Claude Code reports them. Set it up with", "  context-doctor install --statusline", `(or keep your own status line and pipe its input to it too). Readings: ${r.claudeLog.replace(homedir(), "~")}`, "Codex: read from ~/.codex/sessions; none found in the period.");
        return out.join("\n");
    }
    for (const s of r.windows) {
        const age = r.now - s.at;
        out.push("", `${s.label}: ${pts(s.pct)}% used, read ${hm(age)} ago`);
        if (s.resetSince) {
            out.push(`  It has reset since (at ${clock(s.resetsAt, r.now)}); the next reading starts the new window.`);
            continue;
        }
        if (s.resetsAt)
            out.push(`  Resets ${clock(s.resetsAt, r.now)} (in ${hm(s.resetsAt - r.now)}).`);
        if (s.recentPerHour === undefined)
            out.push("  Pace: not enough recent readings.");
        else if (s.recentPerHour === 0)
            out.push("  Pace: no rise over the recent readings.");
        else {
            const avg = s.averagePerHour !== undefined ? `; ${pts(s.averagePerHour)} a hour on average this window` : "";
            out.push(`  Pace: ${pts(s.recentPerHour)} points an hour lately${avg}.`);
            if (s.runsOutAt !== undefined) {
                out.push(s.beforeReset
                    ? `  At that pace it runs out ${clock(s.runsOutAt, r.now)} (in ${hm(s.runsOutAt - r.now)}), before the reset.`
                    : "  At that pace it lasts until the reset.");
            }
        }
    }
    out.push("", "What 1M tokens cost in each limit (fitted on your own readings)");
    out.push("─".repeat(60));
    for (const f of r.fits) {
        out.push(`${f.label}: ${f.segments} stretch${f.segments === 1 ? "" : "es"}, ${pts(f.totalPct)} points, ${f.requests.toLocaleString("en-US")} requests on this machine`);
        if (f.elsewhere)
            out.push(`  ${f.elsewhere} rise${f.elsewhere === 1 ? "" : "s"} (${pts(f.elsewherePct)} points) with no usage here: used elsewhere, left out.`);
        if (f.perMillion && f.byType && (f.usable || f.segments >= MIN_SEGMENTS)) {
            const parts = TOKEN_TYPES.map((t) => (f.perMillion[t] !== undefined ? `${t} ${pts(f.perMillion[t])}%` : `${t} n/a`));
            out.push(`  By token type: ${parts.join(", ")}`);
            out.push(`    explains ${Math.round(Math.max(0, f.byType.r2) * 100)}% of the rises; predicts each within ±${pts(f.byType.looRmse)} points (${Math.round(f.byType.relError * 100)}%)`);
        }
        if (f.pctPerUsd !== undefined && f.byPrice && (f.usable || f.segments >= MIN_SEGMENTS)) {
            out.push(`  By list price: ${pts(f.pctPerUsd * 10)}% per $10${f.mainModel ? ` (mostly ${f.mainModel})` : ""}`);
            out.push(`    rate known to ±${Math.round((f.byPrice.relSe ?? 0) * 100)}%; explains ${Math.round(Math.max(0, f.byPrice.r2) * 100)}% of the rises; predicts each within ±${pts(f.byPrice.looRmse)} points (${Math.round(f.byPrice.relError * 100)}%)`);
        }
        out.push(f.usable ? "  Good enough to show savings in this limit (savings, cache-misses, compact-window)." : `  Too thin to quote: ${f.why}.`);
    }
    out.push("", "Readings: Claude Code's status line input (Pro/Max, 0.1% steps) and Codex's", "rollouts (whole percents). Usage elsewhere (the web app, another computer)", "moves the limit without a transcript here, so it widens the error.");
    return out.join("\n");
}
