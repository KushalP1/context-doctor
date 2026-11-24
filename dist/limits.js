/**
 * `context-doctor limits`: your plan's usage limits, in their own unit.
 *
 * Subscriptions are billed in % of a weekly window and, on most plans, a
 * 5-hour one (Claude Pro, Max and Ultra; since 2026-10-30 Max 5x is called
 * Max and Max 20x Ultra, and Ultra has no 5-hour window), or in credits per
 * token (Codex since April 2026), and neither vendor shows where the
 * percentage went. Local sources say:
 *
 *  - Claude Code hands its status line command `rate_limits.five_hour` and
 *    `.seven_day`, each `{used_percentage, resets_at}` (documented at
 *    code.claude.com/docs/en/statusline; built in 2.1.308 as
 *    Math.round(utilization*1000)/10, so 0.1% steps; present only for
 *    subscribers, after the first reply; `five_hour` absent on Ultra), and
 *    the same windows to the plugin's mod (`session.measure`). The status
 *    line, the mod and the proxy (from the API's
 *    `anthropic-ratelimit-unified-5h-*` / `-7d-*` headers) append each new
 *    reading to a small local log (recordLimits).
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
import { codexDir } from "./codexdir.js";
import { statePath } from "./ledger.js";
import { forEachLine, listSessions, outputSettler, replyCounter, isClaudeSession } from "./session.js";
import { subagentFiles } from "./subagents.js";
import { pick, prescan, rowsOf, slimUsage } from "./scan.js";
import { costStateRecord, refusalRecord } from "./ccost.js";
import { addModifiers, extraIterations, isUnbilledModel, NO_MODIFIERS, openAIUsage, requestCost } from "./pricing.js";
import { realModel } from "./tokens.js";
import { isCompactionRow, newTrack, slimSummary, trackCompaction } from "./compactcost.js";
import { PROXY_VERSION } from "./proxy.js";
import { contentOutputTokens, unsettledVersion } from "./sidecost.js";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Claude Code's two windows, as its status line input names them. */
export const CLAUDE_WINDOWS = ["five_hour", "seven_day"];
const SOURCES = ["statusline", "mod", "proxy"];
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
    const src = e.src;
    return { ts, app: "claude", w, pct, reset: typeof reset === "number" && Number.isFinite(reset) && reset > 0 ? reset : undefined, ...(typeof src === "string" && SOURCES.includes(src) ? { src: src } : {}) };
}
/**
 * Append what changed in Claude Code's `rate_limits` to the log: a window
 * whose % or reset time moved since its last line, or that has not been
 * written for 15 minutes. Nothing when there are no limits (an API key,
 * Bedrock, Vertex). A window that is not there (Ultra's 5-hour one) is
 * simply not written. Never throws: the status line must stay silent.
 * Returns the lines written.
 */
export function recordLimits(rateLimits, now = Date.now(), path = limitsLogPath(), source) {
    if (!rateLimits || typeof rateLimits !== "object")
        return 0;
    const fresh = [];
    for (const w of CLAUDE_WINDOWS) {
        const r = rateLimits[w];
        const pct = r?.used_percentage;
        if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 1000)
            continue;
        const reset = typeof r.resets_at === "number" && Number.isFinite(r.resets_at) && r.resets_at > 0 ? Math.round(r.resets_at) : undefined;
        fresh.push({ ts: now, app: "claude", w, pct: Math.round(pct * 10) / 10, ...(reset ? { reset } : {}), ...(source ? { src: source } : {}) });
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
        appendLog(path, due);
        return due.length;
    }
    catch {
        return 0;
    }
}
/** Append lines to the log, keeping its newest LOG_KEEP_BYTES once it passes LOG_ROTATE_AT. Throws on a write error (callers catch). */
function appendLog(path, lines) {
    if (existsSync(path) && statSync(path).size > LOG_ROTATE_AT) {
        const text = tail(path, LOG_KEEP_BYTES);
        writeFileSync(path, text.slice(text.indexOf("\n") + 1));
    }
    appendFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
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
        out.push({ ts: l.ts, app: "claude", window: l.w, pct: l.pct, resetsAt: l.reset ? l.reset * 1000 : undefined, windowMs: l.w === "five_hour" ? 5 * HOUR : 7 * DAY, ...(l.src ? { source: l.src } : {}) });
    }
    return out.sort((a, b) => a.ts - b.ts);
}
/**
 * The windows an Anthropic response's `anthropic-ratelimit-unified-5h-*` and
 * `-7d-*` headers carry (a claude.ai sign-in, or a gateway), in the status
 * line's shape for recordLimits: utilization is a fraction, the reset epoch
 * seconds. Claude Code reads the same headers into its status line and its
 * mods (Math.round(utilization*1000)/10). Undefined when there are none; a
 * response with only the weekly pair (Ultra) gives only the weekly window.
 */
export function rateLimitsFromHeaders(get) {
    const out = {};
    for (const [h, w] of [["5h", "five_hour"], ["7d", "seven_day"]]) {
        const raw = get(`anthropic-ratelimit-unified-${h}-utilization`);
        if (raw === null || raw === undefined || raw === "")
            continue;
        const u = Number(raw);
        if (!Number.isFinite(u) || u < 0 || u > 10)
            continue;
        const reset = Number(get(`anthropic-ratelimit-unified-${h}-reset`));
        out[w] = { used_percentage: Math.round(u * 1000) / 10, ...(Number.isFinite(reset) && reset > 0 ? { resets_at: Math.round(reset) } : {}) };
    }
    return Object.keys(out).length ? out : undefined;
}
export function overageFromHeaders(get) {
    const h = (n) => {
        const v = get(`anthropic-ratelimit-unified-overage-${n}`);
        return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
    };
    const out = {};
    const status = h("status");
    if (status && /^[a-z_]{1,40}$/.test(status))
        out.status = status;
    const inUse = h("in-use");
    if (inUse === "true" || inUse === "false")
        out.inUse = inUse === "true";
    const u = Number(h("utilization"));
    if (h("utilization") !== undefined && Number.isFinite(u) && u >= 0 && u <= 10)
        out.pct = Math.round(u * 1000) / 10;
    const reset = Number(h("reset"));
    if (h("reset") !== undefined && Number.isFinite(reset) && reset > 0)
        out.reset = Math.round(reset);
    return Object.keys(out).length ? out : undefined;
}
function parseOverageLine(line) {
    let e;
    try {
        e = JSON.parse(line);
    }
    catch {
        return undefined;
    }
    if (!e || typeof e !== "object" || e.w !== "overage" || typeof e.ts !== "number" || !Number.isFinite(e.ts))
        return undefined;
    return {
        ts: e.ts, app: "claude", w: "overage",
        ...(typeof e.status === "string" && /^[a-z_]{1,40}$/.test(e.status) ? { status: e.status } : {}),
        ...(typeof e.inUse === "boolean" ? { inUse: e.inUse } : {}),
        ...(typeof e.pct === "number" && Number.isFinite(e.pct) && e.pct >= 0 && e.pct <= 1000 ? { pct: e.pct } : {}),
        ...(typeof e.reset === "number" && Number.isFinite(e.reset) && e.reset > 0 ? { reset: e.reset } : {}),
        ...(typeof e.src === "string" && SOURCES.includes(e.src) ? { src: e.src } : {}),
    };
}
/**
 * Append what the credits headers say to the same log as the windows, as a
 * line of its own (`"w": "overage"`, which older versions skip): at
 * once when the status, whether credits are in use, or the reset changed;
 * a moved utilization at most once a minute; an unchanged one every 15
 * minutes. Never throws. Returns the lines written (0 or 1).
 */
export function recordOverage(o, now = Date.now(), path = limitsLogPath(), source = "proxy") {
    if (!o)
        return 0;
    const line = { ts: now, app: "claude", w: "overage", ...o, src: source };
    try {
        mkdirSync(dirname(path), { recursive: true });
        let last;
        if (existsSync(path)) {
            for (const l of tail(path, 16 * 1024).split("\n"))
                last = parseOverageLine(l) ?? last;
        }
        const sameReset = last && (last.reset !== undefined && line.reset !== undefined ? Math.abs(last.reset - line.reset) * 1000 <= SAME_RESET_MS : last.reset === line.reset);
        const due = !last || now < last.ts || last.status !== line.status || last.inUse !== line.inUse || !sameReset
            ? true
            : last.pct === line.pct ? now - last.ts >= KEEPALIVE_MS : now - last.ts >= THROTTLE_MS;
        if (!due)
            return 0;
        appendLog(path, [line]);
        return 1;
    }
    catch {
        return 0;
    }
}
/** Every credits reading in the log since `since`, oldest first. */
export function readOverageReadings(since = 0, path = limitsLogPath()) {
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
        if (!line.includes('"overage"'))
            continue;
        const l = parseOverageLine(line);
        if (!l || l.ts < since)
            continue;
        out.push({ ts: l.ts, ...(l.status ? { status: l.status } : {}), ...(l.inUse !== undefined ? { inUse: l.inUse } : {}), ...(l.pct !== undefined ? { pct: l.pct } : {}), ...(l.reset ? { resetsAt: l.reset * 1000 } : {}), ...(l.src ? { source: l.src } : {}) });
    }
    return out.sort((a, b) => a.ts - b.ts);
}
// ---------------------------------------------------------------------------
// Codex: readings and usage, both from its rollouts
// ---------------------------------------------------------------------------
export function codexSessionsRoot(home = homedir()) {
    return join(codexDir(home), "sessions");
}
/** Codex rollouts under `root` (YYYY/MM/DD folders, or flat) written since `since`. */
export function rolloutFiles(root, since) {
    const out = [];
    const walk = (dir, depth) => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            const p = join(dir, e.name);
            // A folder needs no stat of its own; a symlink is stat'ed to see what it is.
            let isDir = e.isDirectory();
            if (e.isSymbolicLink()) {
                try {
                    isDir = statSync(p).isDirectory();
                }
                catch {
                    continue;
                }
            }
            if (isDir) {
                if (depth < 3)
                    walk(p, depth + 1);
            }
            else if (e.name.endsWith(".jsonl")) {
                try {
                    if (statSync(p).mtimeMs >= since)
                        out.push(p);
                }
                catch { /* vanished */ }
            }
        }
    };
    walk(root, 0);
    return out;
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
/** The token counts a Codex event's identity is made of, in its running total and its last request. */
export const CODEX_USAGE_FIELDS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"];
/**
 * A Codex token_count event's identity: its running total and its last
 * request. A forked rollout (a subagent's, a fork of a thread) begins with a
 * copy of its parent's history, token_count events included, all stamped at
 * the moment of the fork: seen on this machine, a subagent's rollout repeated
 * 11 of its parent's 18 requests. The copy carries the same counts, so this
 * key counts each request once, however many rollouts hold it. "" when the
 * event has no running total (nothing to tell a copy by).
 */
export function codexEventKey(total, last) {
    if (!total || typeof total !== "object" || !last || typeof last !== "object")
        return "";
    const t = total, l = last;
    if (!num(t.total_tokens))
        return "";
    return `cx:${CODEX_USAGE_FIELDS.map((k) => num(t[k])).join(",")}/${CODEX_USAGE_FIELDS.map((k) => num(l[k])).join(",")}`;
}
/** "codex:300", "codex:10080"; a limit id other than "codex" is kept in the key. */
function codexWindow(limitId, minutes, plan) {
    // The plan is part of the key: two sign-ins (a team plan, a free one) are two accounts' limits.
    const p = typeof plan === "string" && /^[\w-]{1,20}$/.test(plan) ? `${plan}:` : "";
    return typeof limitId === "string" && limitId && limitId !== "codex" ? `codex:${p}${limitId.slice(0, 40)}:${minutes}` : `codex:${p}${minutes}`;
}
/**
 * Codex readings and usage since `since`. A token_count event repeats the
 * last request's usage when only the limits were refreshed, so a request is
 * counted when the running total moves. A forked rollout's copy of its
 * parent's events (codexEventKey) is counted once, at the earliest time met:
 * the copy is stamped at the fork, its limits readings stale by then.
 */
export function codexLimitData(since, root = codexSessionsRoot()) {
    const readings = [];
    const usage = [];
    if (!existsSync(root))
        return { readings, usage };
    const events = [];
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
                const ev = { ts, key: codexEventKey(p.info?.total_token_usage, last), file, readings: [] };
                // No running total recorded: every event is a request.
                if (last && num(last.input_tokens) > 0 && (runTotal === 0 || runTotal !== total)) {
                    total = runTotal;
                    const u = openAIUsage(last);
                    ev.point = { ts, app: "codex", model, input: num(u.input_tokens), read: num(u.cache_read_input_tokens), write: num(u.cache_creation_input_tokens), output: num(u.output_tokens), usd: requestCost(model, u, ts)?.totalUsd ?? 0 };
                }
                const rl = p.rate_limits;
                if (rl && typeof rl === "object") {
                    for (const slot of ["primary", "secondary"]) {
                        const w = rl[slot];
                        const pct = w?.used_percent;
                        const minutes = num(w?.window_minutes);
                        if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 1000 || !minutes)
                            continue;
                        const reset = num(w.resets_at);
                        ev.readings.push({ ts, app: "codex", window: codexWindow(rl.limit_id, minutes, rl.plan_type), pct, resetsAt: reset ? reset * 1000 : undefined, windowMs: minutes * MIN, plan: typeof rl.plan_type === "string" ? rl.plan_type.slice(0, 20) : undefined });
                    }
                }
                if (ev.point || ev.readings.length)
                    events.push(ev);
            });
        }
        catch {
            /* one unreadable rollout must not sink the report */
        }
    }
    // A key belongs to the rollout that has it first; within it, a refresh of the limits shares its request's key.
    const owner = new Map();
    for (const ev of events.sort((a, b) => a.ts - b.ts)) {
        if (ev.key) {
            const first = owner.get(ev.key) ?? (owner.set(ev.key, ev.file), ev.file);
            if (first !== ev.file)
                continue;
        }
        if (ev.point)
            usage.push(ev.point);
        readings.push(...ev.readings);
    }
    return { readings, usage };
}
// ---------------------------------------------------------------------------
// Claude usage: every request on this machine, subagents included
// ---------------------------------------------------------------------------
/**
 * What the usage fit takes from a Claude Code transcript (subagents' too):
 * every assistant row with usage, in order. A later row of a reply already
 * met keeps only its id, its output tokens and its billed iterations: it is
 * a repeat, read only for what a streamed reply settles on its last row.
 * `isSidechain` is kept for `spend`, which tells a subagent inlined in an
 * older transcript from the main thread. A request's `usage.iterations` is
 * kept only where some bill beyond its top-level usage (extraIterations).
 * Also Claude Code's own running cost: each `cost-state` row as
 * costStateRecord keeps it, with the Claude Code version of the replies
 * before it (ccost.ts compares it with ours). A reply row keeps its
 * `stop_reason` and `entrypoint` (a prompt suggestion follows a main-thread
 * turn's end, sidecost.ts) and, where it has no `stop_reason`, its content
 * as output tokens (`oc`: what a reply whose rows never settled cost,
 * sidecost.ts). Each `api-request` row (what Claude Code sent, 2.1.308+) as
 * its id, the request it repeats or extends and the time, a reply's
 * `requestRef` to it, and an `api_error` row's code: a request no reply
 * answers and Claude Code sent again a minute or more later is one that hung
 * (ccost.ts names them).
 */
export const USAGE_ROWS = {
    id: "usage.6",
    init: () => ({ ids: {} }),
    line(line, row, out, st) {
        const compaction = isCompactionRow(line);
        const cost = !compaction && line.startsWith('{"type":"cost-state"');
        const refusal = !compaction && !cost && line.includes('"model_refusal_fallback"');
        const sent = !compaction && !cost && line.startsWith('{"type":"api-request",');
        const failed = !compaction && !cost && !sent && line.includes('"subtype":"api_error"');
        if (!compaction && !cost && !refusal && !sent && !failed && !line.includes('"usage"'))
            return;
        let e;
        try {
            e = row();
        }
        catch {
            return;
        }
        if (sent) {
            if (e?.type === "api-request" && typeof e.id === "string")
                out.push({ type: "api-request", id: e.id, ...(typeof e.base === "string" ? { base: e.base } : {}), t: Array.isArray(e.tail) ? e.tail.length : 0, timestamp: e.timestamp });
            return;
        }
        if (failed) {
            if (e?.type === "system" && e.subtype === "api_error")
                out.push({ type: "system", subtype: "api_error", timestamp: e.timestamp, code: String(e.error?.connection?.code ?? e.error?.status ?? "").slice(0, 40) });
            return;
        }
        if (cost || refusal) {
            const r = cost ? costStateRecord(e, st.v) : refusalRecord(e);
            if (r)
                out.push(r);
            if (cost || r)
                return;
        }
        // A compaction's boundary (the context it read) and its summary (the output): what its own request is estimated from (compactcost.ts).
        if (compaction && e?.type === "system" && e.subtype === "compact_boundary") {
            out.push(pick({ ...e, isSidechain: e.isSidechain === true || undefined, compactMetadata: pick(e.compactMetadata ?? {}, ["preTokens"]) }, ["type", "subtype", "uuid", "sessionId", "timestamp", "isSidechain", "compactMetadata"]));
            return;
        }
        if (compaction && e?.type === "user" && e.isCompactSummary === true) {
            out.push(slimSummary(e));
            return;
        }
        const m = e?.message;
        if (e?.type !== "assistant" || !m?.usage)
            return;
        if (typeof e.version === "string")
            st.v = e.version.slice(0, 40);
        if (typeof m.id === "string") {
            if (st.ids[m.id]) {
                // Its billed iterations too: a streamed reply may settle those on a later row as well.
                const its = slimUsage(m.usage, { iterations: true });
                out.push({ type: "assistant", message: { id: m.id, usage: { ...pick(m.usage, ["output_tokens"]), ...(its?.iterations ? { iterations: its.iterations } : {}) }, ...settling(m, e.version) } });
                return;
            }
            st.ids[m.id] = 1;
        }
        out.push(pick({ ...e, isSidechain: e.isSidechain === true || undefined, message: { ...pick({ ...m, usage: slimUsage(m.usage, { iterations: true }) }, ["id", "model", "usage"]), ...settling(m, e.version) } }, ["type", "uuid", "timestamp", "isSidechain", "entrypoint", "requestRef", "message"]));
    },
};
/** A reply row's `stop_reason`, or (none, from a Claude Code that left replies unsettled: unsettledVersion) its content as output tokens. */
function settling(m, version) {
    if (typeof m.stop_reason === "string" && m.stop_reason)
        return { stop_reason: m.stop_reason.slice(0, 40) };
    if (!unsettledVersion(version))
        return {};
    const oc = contentOutputTokens(m.content);
    return oc > 0 ? { oc } : {};
}
/** A compaction's estimated request as a request point (no message id: its key is the boundary's uuid). */
export function compactionPoint(c) {
    const u = c.usage;
    return {
        ts: c.ts, app: "claude", model: c.model, input: num(u.input_tokens), read: num(u.cache_read_input_tokens), write: num(u.cache_creation_input_tokens), output: num(u.output_tokens),
        usd: c.cost.totalUsd, promptUsd: c.cost.promptUsd, rates: c.cost.rates, modifiers: c.cost.modifiers, compaction: true,
        ...(c.uuid ? { uuid: c.uuid } : {}), ...(c.sidechain ? { sidechain: true } : {}), ...(c.cost.estimated ? { estimated: true } : {}), ...(c.cost.changedOn ? { changedOn: c.cost.changedOn } : {}),
    };
}
/** A request's iterations billed beyond its top-level usage, each priced at its own model (the request's when it names none) at `ts`. */
export function iterationPoints(model, u, ts) {
    return extraIterations(u).map((x) => {
        const m = realModel(x.model ?? model);
        const c = requestCost(m, x.usage, ts);
        return {
            type: x.type, ...(m ? { model: m } : {}),
            input: num(x.usage.input_tokens), read: num(x.usage.cache_read_input_tokens), write: num(x.usage.cache_creation_input_tokens), output: num(x.usage.output_tokens),
            usd: c?.totalUsd ?? 0, promptUsd: c?.promptUsd ?? 0, priced: Boolean(c), modifiers: c ? c.modifiers : { ...NO_MODIFIERS },
            ...(c?.estimated ? { estimated: true } : {}), ...(c?.changedOn ? { changedOn: c.changedOn } : {}),
        };
    });
}
/** `p`'s extra iterations set to `extra`, its dollars and modifiers moved by what changed. */
function setExtra(p, extra) {
    for (const x of p.extra ?? []) {
        p.usd -= x.usd;
        p.promptUsd -= x.promptUsd;
        addModifiers(p.modifiers, negated(x.modifiers));
    }
    if (extra.length)
        p.extra = extra;
    else
        delete p.extra;
    for (const x of extra) {
        p.usd += x.usd;
        p.promptUsd += x.promptUsd;
        addModifiers(p.modifiers, x.modifiers);
    }
}
const negated = (m) => ({ fastUsd: -m.fastUsd, geoUsd: -m.geoUsd, longUsd: -m.longUsd, webSearchUsd: -m.webSearchUsd, webSearches: -m.webSearches });
/**
 * The requests of one Claude Code transcript between `since` and `until`,
 * each reply once, its output settled on its last row (billed at the
 * reply's own rates, requestCost's). `runRows` is shared by every file of
 * one report, so a fork's copy of its parent's replies is counted once, in
 * the file met first (replyCounter). Replies on `<synthetic>`
 * (isUnbilledModel) are left out. Throws when the transcript cannot be read.
 */
export function claudeFileUsage(file, since, until = Infinity, runRows) {
    const out = [];
    const sighting = replyCounter(runRows);
    const settle = outputSettler();
    const byId = new Map();
    // Per reply: whether a row of it settled (has a stop_reason), and what its rows' content took to write (sidecost.ts).
    const settled = new Map();
    const track = newTrack();
    rowsOf(file, USAGE_ROWS).forEach((e) => {
        const done = trackCompaction(track, e);
        if (done && done.ts >= since && done.ts <= until)
            out.push(compactionPoint(done));
        const m = e?.message;
        if (e?.type !== "assistant" || !m?.usage)
            return;
        if (typeof m.id === "string") {
            const s = settled.get(m.id) ?? settled.set(m.id, { stop: false, oc: 0 }).get(m.id);
            if (m.stop_reason)
                s.stop = true;
            s.oc += typeof m.oc === "number" ? m.oc : 0;
        }
        const seen = sighting(e);
        if (seen === "repeat") {
            const known = typeof m.id === "string" ? byId.get(m.id) : undefined;
            const more = settle(e, false);
            if (known && more) {
                const p = known.point;
                p.output += more;
                if (p.rates) {
                    p.usd += (more * p.rates.outputPerM) / 1e6;
                    // What the modifiers added grows with the output: priced again whole (the iterations' added back).
                    if (p.modifiers.fastUsd || p.modifiers.geoUsd || p.modifiers.longUsd) {
                        p.modifiers = { ...requestCost(p.model, { ...known.u, output_tokens: p.output }, p.ts).modifiers };
                        for (const x of p.extra ?? [])
                            addModifiers(p.modifiers, x.modifiers);
                    }
                }
            }
            // Iterations a later row settles on (an advisor's call, once it ran): priced again, replacing the earlier ones.
            if (known && m.usage.iterations) {
                const extra = iterationPoints(known.point.model, { ...known.u, iterations: m.usage.iterations }, known.point.ts);
                if (JSON.stringify(extra) !== JSON.stringify(known.point.extra ?? []))
                    setExtra(known.point, extra);
            }
            return;
        }
        if (seen !== "new")
            return;
        settle(e, true);
        // A reply Claude Code made itself (an error, an interruption) never reached the API: no request, priced or not.
        if (isUnbilledModel(m.model))
            return;
        const ts = Date.parse(String(e.timestamp ?? ""));
        if (!Number.isFinite(ts) || ts < since || ts > until)
            return;
        const u = m.usage;
        const point = { ts, app: "claude", model: realModel(m.model), input: num(u.input_tokens), read: num(u.cache_read_input_tokens), write: num(u.cache_creation_input_tokens), output: num(u.output_tokens), usd: 0, promptUsd: 0, modifiers: { ...NO_MODIFIERS } };
        if (point.input + point.read + point.write === 0)
            return;
        if (typeof e.uuid === "string")
            point.uuid = e.uuid;
        if (typeof m.id === "string")
            point.id = m.id;
        if (e.isSidechain === true)
            point.sidechain = true;
        const c = requestCost(point.model, u, ts);
        if (c) {
            point.usd = c.totalUsd;
            point.promptUsd = c.promptUsd;
            point.rates = c.rates;
            point.modifiers = c.modifiers;
            if (c.estimated)
                point.estimated = true;
            if (c.changedOn)
                point.changedOn = c.changedOn;
        }
        // The iterations its top-level usage leaves out, each at its own model (counted even when the request's own model has no price).
        const extra = iterationPoints(point.model, u, ts);
        if (extra.length)
            setExtra(point, extra);
        out.push(point);
        if (typeof m.id === "string")
            byId.set(m.id, { point, u });
    });
    // A reply none of whose rows settled (Claude Code 2.1.284-2.1.299's subagents): its output from its content, where that is more.
    for (const [id, s] of settled) {
        const known = byId.get(id);
        if (s.stop || !known || s.oc <= known.point.output)
            continue;
        const p = known.point, more = s.oc - p.output;
        p.output += more;
        p.unsettled = more;
        if (p.rates) {
            p.usd += (more * p.rates.outputPerM) / 1e6;
            if (p.modifiers.fastUsd || p.modifiers.geoUsd || p.modifiers.longUsd) {
                p.modifiers = { ...requestCost(p.model, { ...known.u, output_tokens: p.output }, p.ts).modifiers };
                for (const x of p.extra ?? [])
                    addModifiers(p.modifiers, x.modifiers);
            }
        }
    }
    return out;
}
/**
 * The Claude Code transcripts written since `since`: each session's main
 * transcript (`tops`, or every one under the projects folder, newest
 * first), each followed by its subagents'.
 */
export function claudeUsageFiles(since, tops) {
    // A session last written before `since` can still have subagents (a workflow run, a background
    // agent) writing after it: those of the sessions written in the SUBAGENT_LOOKBACK_MS before count.
    const listed = tops ? undefined : listSessions(10_000).filter((s) => isClaudeSession(s) && s.modifiedAt.getTime() >= since - SUBAGENT_LOOKBACK_MS);
    const mains = tops ?? listed.map((s) => s.path);
    const files = [];
    for (const [i, t] of mains.entries()) {
        if (!listed || listed[i].modifiedAt.getTime() >= since)
            files.push({ file: t, top: t, subagent: false });
        for (const f of subagentFiles(t, since))
            files.push({ file: f.file, top: t, subagent: true, ...(f.run ? { run: f.run } : {}) });
    }
    return files;
}
/** How long before a period a session may have been last written and still have subagents running into it. */
export const SUBAGENT_LOOKBACK_MS = 2 * 86_400_000;
/** A Claude Code entrypoint or version as a report may show it: a short token, never free text. */
const ENTRYPOINT = /^[a-z][\w.-]{0,39}$/i;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+][\w.]{1,20})?$/;
/**
 * Which Claude Code wrote a transcript, and when that changed: every row
 * carries `entrypoint` ("cli", "claude-desktop", "sdk-cli" for `claude -p`,
 * "claude-vscode"...) and `version`; a record is kept only where either
 * changes (a session resumed after an update), so a file has one or two.
 */
export const HOST_ROWS = {
    id: "host.1",
    init: () => ({}),
    line(line, row, out, st) {
        if (!line.includes('"entrypoint"') && !line.includes('"version"'))
            return;
        let e;
        try {
            e = row();
        }
        catch {
            return;
        }
        const ep = typeof e?.entrypoint === "string" && ENTRYPOINT.test(e.entrypoint) ? e.entrypoint : undefined;
        const v = typeof e?.version === "string" && VERSION.test(e.version) ? e.version : undefined;
        if ((!ep || ep === st.ep) && (!v || v === st.v))
            return;
        if (ep)
            st.ep = ep;
        if (v)
            st.v = v;
        const ts = Date.parse(String(e.timestamp ?? ""));
        out.push({ ts: Number.isFinite(ts) ? ts : 0, ...(st.ep ? { ep: st.ep } : {}), ...(st.v ? { v: st.v } : {}) });
    },
};
/** Each request's entrypoint and version: the transcript's own as of the request, else (a subagent's file with none) its session's. */
function stampHost(points, hosts, fallback) {
    let h = 0;
    for (const p of points) {
        while (h + 1 < hosts.length && hosts[h + 1].ts <= p.ts)
            h++;
        const at = hosts[h] ?? fallback;
        if (!at)
            continue;
        if (at.ep)
            p.entrypoint = at.ep;
        if (at.v)
            p.version = at.v;
    }
}
/**
 * Every Claude Code request between `since` and `until`, main threads and
 * subagents alike (both draw on the same limits), each reply once, with
 * the entrypoint and Claude Code version it was made from.
 */
export function claudeUsage(since, until = Infinity, paths) {
    const out = [];
    const runRows = new Set();
    const files = claudeUsageFiles(since, paths);
    // One read of each transcript for both extractors.
    prescan([{ paths: files.map((f) => f.file), extractors: [USAGE_ROWS, HOST_ROWS] }]);
    const topHost = new Map();
    for (const { file, top, subagent } of files) {
        try {
            const points = claudeFileUsage(file, since, until, runRows);
            let hosts = [];
            try {
                hosts = rowsOf(file, HOST_ROWS);
            }
            catch { /* no host: the points go unstamped */ }
            if (!subagent && hosts.length)
                topHost.set(top, hosts[0]);
            // A subagent's file with no host of its own takes its session's (read here when the session itself is outside the period).
            if (subagent && !hosts.length && !topHost.has(top)) {
                try {
                    topHost.set(top, rowsOf(top, HOST_ROWS)[0]);
                }
                catch {
                    topHost.set(top, undefined);
                }
            }
            stampHost(points, hosts, topHost.get(top));
            out.push(...points);
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
    // A window that began within the lookback was at 0% when it began: the
    // pace counts from there. From the period's first reading alone, a weekly
    // window read for the first time hours after its reset (nothing used
    // since) took ten minutes' burst for the day's pace and said a 2% week
    // ran out in 8 hours.
    const start = last.windowMs && last.resetsAt ? last.resetsAt - last.windowMs : undefined;
    const from = start !== undefined && recent[0] && start >= last.ts - lookback && start < recent[0].ts
        ? { ts: start, pct: 0 }
        : recent[0];
    if (from && last.ts - from.ts >= 10 * MIN) {
        status.recentPerHour = Math.max(0, ((last.pct - from.pct) / (last.ts - from.ts)) * HOUR);
    }
    if (last.windowMs && last.resetsAt) {
        const start = last.resetsAt - last.windowMs;
        if (last.ts - start >= 10 * MIN)
            status.averagePerHour = Math.max(0, (last.pct / (last.ts - start)) * HOUR);
    }
    // A reading older than the pace's own stretch says nothing about now: no run-out time from it (it could already be past).
    if (now - last.ts > lookback)
        status.stale = true;
    if (!status.stale && status.recentPerHour && status.recentPerHour > 0 && last.pct < 100) {
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
/** A window's figure is quoted from this many stretches and this many points matched by usage here. */
const MIN_RESET_STRETCHES = 3;
const MIN_RESET_PCT = 1;
/** Above this relative error the figure is too loose to compare. */
const MAX_RESET_REL_SE = 0.25;
/** A move is reported from 1.5x either way, and only beyond this many standard errors (more inside a window, where the split is searched for). */
const MIN_FACTOR = 1.5;
const RESET_SIGMA = 3;
const WITHIN_SIGMA = 4;
/** Each side of a split inside a window holds at least this many stretches. */
const MIN_SIDE = 4;
/** A key with under this share of a window's dollars is pooled into "other". */
const MIN_KEY_SHARE = 0.05;
/** A key's own figure is quoted under this relative error. */
const MAX_KEY_REL_SE = 0.3;
/** Windows this long or longer are fitted per reset (Claude's weekly; Codex's weekly and monthly). */
const PER_RESET_MIN_MS = 7 * DAY - HOUR;
/** A mix that moved less than this (half the summed share changes) held. */
const MIX_HELD = 0.1;
/** The mix's prediction must cover this share of each side's dollars with per-model rates. */
const MIX_COVER = 0.9;
/** A mix prediction within this factor of 1 is no mix move worth naming beside a limit move. */
const MIX_NAMED = 1.2;
/** Ratio of sums, sum(u) / sum(d), and its relative standard error (the ratio estimator's, across stretches). */
function ratio(u, d) {
    const n = u.length;
    const su = u.reduce((a, v) => a + v, 0), sd = d.reduce((a, v) => a + v, 0);
    if (!(sd > 0) || !(su > 0))
        return undefined;
    const r = su / sd;
    if (n < 2)
        return { r, relSe: Infinity };
    const dbar = sd / n;
    const s2 = u.reduce((a, v, i) => a + (v - r * d[i]) ** 2, 0) / (n - 1);
    return { r, relSe: Math.sqrt(s2 / n) / dbar / r };
}
/** Least squares through the origin with each coefficient's standard error; undefined when singular or with too few rows. */
function olsSe(rows, y) {
    const n = rows.length, k = rows[0]?.length ?? 0;
    if (!k || n <= k + 1)
        return undefined;
    // [XᵀX | I], inverted in place by Gauss-Jordan.
    const a = Array.from({ length: k }, (_, p) => [...Array.from({ length: k }, (_, q) => rows.reduce((s, r) => s + r[p] * r[q], 0)), ...Array.from({ length: k }, (_, q) => (p === q ? 1 : 0))]);
    for (let c = 0; c < k; c++) {
        let piv = c;
        for (let r = c + 1; r < k; r++)
            if (Math.abs(a[r][c]) > Math.abs(a[piv][c]))
                piv = r;
        if (Math.abs(a[piv][c]) < 1e-12 * Math.max(1e-300, ...a.map((row) => Math.abs(row[c]))))
            return undefined;
        [a[c], a[piv]] = [a[piv], a[c]];
        const d = a[c][c];
        for (let q = 0; q < 2 * k; q++)
            a[c][q] /= d;
        for (let r = 0; r < k; r++) {
            if (r === c)
                continue;
            const f = a[r][c];
            for (let q = 0; q < 2 * k; q++)
                a[r][q] -= f * a[c][q];
        }
    }
    const inv = a.map((row) => row.slice(k));
    const xty = Array.from({ length: k }, (_, p) => rows.reduce((s, r, i) => s + r[p] * y[i], 0));
    const coef = inv.map((row) => row.reduce((s, v, q) => s + v * xty[q], 0));
    const sse = rows.reduce((s, r, i) => s + (y[i] - r.reduce((t, v, j) => t + v * coef[j], 0)) ** 2, 0);
    const s2 = sse / (n - k);
    return { coef, se: inv.map((row, j) => Math.sqrt(Math.max(0, s2 * row[j]))) };
}
const tokensOf = (p) => p.input + p.read + p.write + p.output;
/**
 * Shares by `keyOf` over the stretches, and, with two keys or more and
 * enough stretches, each key's own dollars per 1%: the rise in each stretch
 * fitted on each key's dollars in it. A key's figure is kept only when it is
 * known to ±30%; a single key's figure is the window's own.
 */
function splitBy(segments, inSeg, keyOf, whole) {
    const totals = new Map();
    let all = 0;
    for (const pts of inSeg)
        for (const p of pts) {
            const k = keyOf(p);
            const t = totals.get(k) ?? totals.set(k, { key: k, usd: 0, tokens: 0, requests: 0, share: 0 }).get(k);
            t.usd += p.usd;
            t.tokens += tokensOf(p);
            t.requests++;
            all += p.usd;
        }
    let list = [...totals.values()].sort((a, b) => b.usd - a.usd);
    // Small keys pooled, so the fit has a column only for what can be told apart.
    const small = list.filter((t) => all > 0 && t.usd / all < MIN_KEY_SHARE);
    if (small.length > 1) {
        const other = { key: "other", usd: 0, tokens: 0, requests: 0, share: 0 };
        for (const t of small) {
            other.usd += t.usd;
            other.tokens += t.tokens;
            other.requests += t.requests;
        }
        list = [...list.filter((t) => !small.includes(t)), other];
    }
    for (const t of list)
        t.share = all > 0 ? t.usd / all : 0;
    if (list.length === 1 && whole) {
        list[0].usdPerPct = whole.r;
        list[0].relSe = whole.relSe;
    }
    else if (list.length > 1 && segments.length >= MIN_SEGMENTS) {
        const col = new Map(list.map((t, i) => [t.key, i]));
        const otherCol = col.get("other");
        const rows = inSeg.map((pts) => {
            const r = new Array(list.length).fill(0);
            for (const p of pts)
                r[col.get(keyOf(p)) ?? otherCol ?? 0] += p.usd;
            return r;
        });
        const fit = olsSe(rows, segments.map((s) => s.dpct));
        if (fit)
            list.forEach((t, j) => {
                const k = fit.coef[j], se = fit.se[j];
                if (k > 0 && se / k <= MAX_KEY_REL_SE) {
                    t.usdPerPct = 1 / k;
                    t.relSe = se / k;
                }
            });
    }
    return list;
}
/** The requests of each stretch: both lists are in time order. */
function usageBySegment(segments, usage) {
    const inSeg = segments.map(() => []);
    let g = 0;
    for (const p of usage) {
        while (g < segments.length && segments[g].to < p.ts)
            g++;
        if (g >= segments.length)
            break;
        if (p.ts > segments[g].from)
            inSeg[g].push(p);
    }
    return inSeg;
}
/** One window's readings cut at each reset: the periods, oldest first. */
function periodsOf(readings) {
    const clean = cleanReadings(readings);
    const res = resolutionOf(clean);
    const out = [];
    for (const r of clean) {
        const cur = out[out.length - 1];
        if (cur && samePeriod(cur[cur.length - 1], r, res))
            cur.push(r);
        else
            out.push([r]);
    }
    return out;
}
/**
 * Each reset window of one weekly window's readings: % used, dollars and
 * tokens per 1% (over the stretches with usage here; rises with none are
 * counted apart), the split by entrypoint and by model, and the Claude Code
 * versions. `usage` in time order.
 */
export function resetWindowsOf(readings, usage, opts = {}) {
    const now = opts.now ?? Date.now();
    const out = [];
    for (const period of periodsOf(readings)) {
        const first = period[0], last = period[period.length - 1];
        const windowMs = last.windowMs ?? 7 * DAY;
        const resetsAt = last.resetsAt ?? first.ts + windowMs;
        const { segments, elsewherePct } = segmentsOf(period, usage, opts.stretchMs);
        const inSeg = usageBySegment(segments, usage);
        const usd = segments.reduce((a, s) => a + s.usd, 0);
        const tokens = inSeg.reduce((a, pts) => a + pts.reduce((b, p) => b + tokensOf(p), 0), 0);
        const pctMatched = segments.reduce((a, s) => a + s.dpct, 0);
        const w = {
            window: last.window,
            label: windowLabel(last.window, last.windowMs),
            app: last.app,
            start: resetsAt - windowMs,
            resetsAt,
            current: resetsAt > now,
            readings: period.length,
            firstReading: first.ts,
            lastReading: last.ts,
            pctUsed: Math.max(...period.map((r) => r.pct)),
            pctMatched,
            pctElsewhere: elsewherePct,
            stretches: segments.length,
            requests: segments.reduce((a, s) => a + s.requests, 0),
            usd,
            tokens,
            byEntrypoint: [],
            byModel: [],
            versions: [],
        };
        const fit = ratio(segments.map((s) => s.usd), segments.map((s) => s.dpct));
        if (segments.length < MIN_RESET_STRETCHES)
            w.why = `${segments.length} stretch${segments.length === 1 ? "" : "es"} of readings with usage here; ${MIN_RESET_STRETCHES} make a figure`;
        else if (pctMatched < MIN_RESET_PCT)
            w.why = `the limit rose ${pts(pctMatched)} points beside usage here; ${MIN_RESET_PCT} make a figure`;
        else if (!fit || !(usd > 0))
            w.why = "no priced usage beside the rises";
        else {
            w.usdPerPct = fit.r;
            w.tokensPerPct = tokens / pctMatched;
            w.relSe = fit.relSe;
            if (!(fit.relSe <= MAX_RESET_REL_SE))
                w.why = `known only to ±${Number.isFinite(fit.relSe) ? Math.round(fit.relSe * 100) : "∞"}%: the rises follow the usage here loosely`;
        }
        const quoted = w.usdPerPct !== undefined && !w.why ? fit : undefined;
        w.byEntrypoint = splitBy(segments, inSeg, (p) => p.entrypoint ?? (p.app === "codex" ? "codex" : "unknown"), quoted);
        w.byModel = splitBy(segments, inSeg, (p) => reportModel(p.model), quoted);
        w.versions = [...new Set(inSeg.flat().map((p) => p.version).filter((v) => !!v))].sort(compareVersions);
        out.push(w);
    }
    return out;
}
/** "2.1.9" before "2.1.10". */
function compareVersions(a, b) {
    const pa = a.split(/[.-]/).map(Number), pb = b.split(/[.-]/).map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d)
            return d;
    }
    return a.localeCompare(b);
}
/**
 * A model id as a report may carry it: a model's name, never a cloud
 * resource (a Bedrock ARN holds an account number) or anything path-shaped.
 */
export function reportModel(model) {
    if (!model)
        return "unknown";
    if (!/^[a-z][\w.:@[\]-]{0,59}$/i.test(model) || /^arn:/i.test(model) || /\d{8,}/.test(model))
        return "custom model id";
    return model;
}
/** The two sides of a move, each a ratio with its error: how many standard errors apart (log scale). */
function sigmaOf(a, b, factor) {
    const se = Math.sqrt(a.relSe ** 2 + b.relSe ** 2);
    return se > 0 ? Math.abs(Math.log(factor)) / se : Infinity;
}
function mixRows(segs, usage, after) {
    const inSeg = usageBySegment(segs, usage);
    return segs.map((s, i) => {
        const byModel = new Map();
        for (const p of inSeg[i]) {
            const k = reportModel(p.model);
            byModel.set(k, (byModel.get(k) ?? 0) + p.usd);
        }
        return { dpct: s.dpct, byModel, after };
    });
}
function sharesOf(rows) {
    const t = new Map();
    let all = 0;
    for (const r of rows)
        for (const [k, v] of r.byModel) {
            t.set(k, (t.get(k) ?? 0) + v);
            all += v;
        }
    return all > 0 ? Object.fromEntries([...t].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v / all])) : {};
}
/**
 * Per-model % of the limit per dollar, fitted on both sides' stretches at
 * once with one factor f for the after side (dpct = Σ β_m·usd_m, times f
 * after the move): f searched for, the rates least squares at each. β is
 * each model's rate before the move, and a move of the limit itself goes to
 * f instead of bending the rates. Fitting the rates over both sides with no
 * f would credit a model used mostly after a real move with that move. Undefined when the stretches cannot tell the
 * models apart (a rate at or below zero, or known worse than ±30%).
 */
function jointRates(rows, keys) {
    if (keys.length < 2 || rows.length <= keys.length + 2)
        return undefined;
    const y = rows.map((r) => r.dpct);
    // For a given after-side factor the rates are plain least squares: search
    // the factor (on the log scale, 1/10x to 10x) for the least squared error.
    const at = (logF) => {
        const f = Math.exp(logF);
        const fit = olsSe(rows.map((r) => keys.map((k) => (r.byModel.get(k) ?? 0) * (r.after ? f : 1))), y);
        const sse = fit ? rows.reduce((a, r, i) => a + (y[i] - keys.reduce((b, k, j) => b + fit.coef[j] * (r.byModel.get(k) ?? 0) * (r.after ? f : 1), 0)) ** 2, 0) : Infinity;
        return { fit, sse };
    };
    let lo = -Math.log(10), hi = Math.log(10);
    const g = (Math.sqrt(5) - 1) / 2;
    let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo);
    let f1 = at(x1).sse, f2 = at(x2).sse;
    for (let it = 0; it < 60 && hi - lo > 1e-5; it++) {
        if (f1 <= f2) {
            hi = x2;
            x2 = x1;
            f2 = f1;
            x1 = hi - g * (hi - lo);
            f1 = at(x1).sse;
        }
        else {
            lo = x1;
            x1 = x2;
            f1 = f2;
            x2 = lo + g * (hi - lo);
            f2 = at(x2).sse;
        }
    }
    const { fit } = at((lo + hi) / 2);
    if (!fit || fit.coef.some((b, j) => !(b > 0) || fit.se[j] / b > MAX_KEY_REL_SE))
        return undefined;
    return new Map(keys.map((k, j) => [k, fit.coef[j]]));
}
/** A window's own per-model rates (splitBy's), as % per dollar: none for the pooled "other". */
function windowRates(w) {
    return new Map(w.byModel.filter((t) => t.usdPerPct !== undefined && t.usdPerPct > 0 && t.key !== "other").map((t) => [t.key, 1 / t.usdPerPct]));
}
/** Dollars per 1% a mix gives at per-model rates, over the dollars those rates cover; undefined under MIX_COVER. */
function predicted(shares, rates) {
    let cover = 0, pctPerUsd = 0;
    for (const [k, s] of Object.entries(shares)) {
        const b = rates.get(k);
        if (b === undefined)
            continue;
        cover += s;
        pctPerUsd += s * b;
    }
    return cover >= MIX_COVER && pctPerUsd > 0 ? cover / pctPerUsd : undefined;
}
/**
 * The mix on each side of a move and what it alone predicts: rates from the
 * joint fit on the two sides' stretches, else the first of `fallback` (the
 * windows' own per-model figures, nearest first) that covers both sides.
 */
function mixOf(before, after, fallback) {
    const sb = sharesOf(before), sa = sharesOf(after);
    const keys = [...new Set([...Object.keys(sb), ...Object.keys(sa)])];
    if (!keys.length || keys.every((k) => k === "unknown"))
        return undefined;
    const delta = keys.map((k) => [k, (sa[k] ?? 0) - (sb[k] ?? 0)]).sort((a, b) => b[1] - a[1]);
    const mix = {
        before: sb, after: sa, grew: delta[0][0],
        ...(delta.length > 1 && delta[delta.length - 1][1] < 0 ? { shrank: delta[delta.length - 1][0] } : {}),
        moved: delta.reduce((a, [, d]) => a + Math.abs(d), 0) / 2,
    };
    const named = keys.filter((k) => k !== "unknown" && k !== "other" && Math.max(sb[k] ?? 0, sa[k] ?? 0) >= MIN_KEY_SHARE);
    // The joint fit tells a model's own rate from a move only for a model used on both sides: one used on one side alone carries the move in its rate.
    const both = named.every((k) => (sb[k] ?? 0) >= MIN_KEY_SHARE && (sa[k] ?? 0) >= MIN_KEY_SHARE);
    const tries = [both ? jointRates([...before, ...after], named) : undefined, ...fallback].filter((r) => !!r && r.size > 0);
    for (const rates of tries) {
        const pb = predicted(sb, rates), pa = predicted(sa, rates);
        if (pb === undefined || pa === undefined)
            continue;
        mix.pctPerUsd = Object.fromEntries([...rates].filter(([k]) => k in sb || k in sa));
        mix.predictedBefore = pb;
        mix.predictedAfter = pa;
        return { mix, mixFactor: pa / pb };
    }
    return { mix };
}
/** Set a move's mix fields and its cause (SlopeChange.cause). `minSigma`: the bar the move itself had to clear. */
function explainMove(c, before, after, fallback, se, minSigma) {
    const got = mixOf(before, after, fallback);
    if (!got)
        return;
    c.mix = got.mix;
    // A mix that held explains nothing, whatever the rates say.
    const mixFactor = got.mix.moved < MIX_HELD ? 1 : got.mixFactor;
    if (mixFactor === undefined) {
        c.cause = "unclear";
        return;
    }
    c.mixFactor = mixFactor;
    c.residual = c.factor / mixFactor;
    c.residualSigma = sigmaOf({ relSe: se.before }, { relSe: se.after }, c.residual);
    const limitMoved = Math.max(c.residual, 1 / c.residual) >= MIN_FACTOR && c.residualSigma >= minSigma;
    c.cause = !limitMoved ? "mix" : Math.max(mixFactor, 1 / mixFactor) >= MIX_NAMED ? "both" : "limit";
}
/**
 * Where what 1% costs moved: between consecutive windows that each have a
 * figure (dated at the reset), and inside a window at the one split of its
 * stretches that separates two rates best (dated at that stretch). Reported
 * from a 1.5x move either way, beyond 3 standard errors between windows and
 * 4 inside one (the split is searched for). Each move is checked against
 * the model mix on its two sides (explainMove; needs `readings` to find the
 * stretches): `cause` says whether the limit moved or the mix did.
 */
export function slopeChanges(windows, usage = [], readings = [], stretchMs) {
    const out = [];
    const periods = readings.length ? periodsOf(readings) : [];
    const periodOf = (w) => periods.find((p) => p[0].ts === w.firstReading && p[p.length - 1].ts === w.lastReading);
    /**
     * The mix's fallback rates: `first`'s own per-model figures, then the other
     * windows', nearest to `around` first, never `skip`'s (a window that holds
     * a move inside it fits its rates across that move: a model used mostly
     * after it would carry the move as its own rate).
     */
    const ratesNear = (around, first, skip) => [...first, ...windows.filter((x) => !first.includes(x) && x !== skip && x.window === around.window).sort((x, y) => Math.abs(x.start - around.start) - Math.abs(y.start - around.start))].map(windowRates);
    const quoted = windows.filter((w) => w.usdPerPct !== undefined && w.relSe !== undefined && Number.isFinite(w.relSe) && !w.why);
    for (let i = 1; i < quoted.length; i++) {
        const a = quoted[i - 1], b = quoted[i];
        if (a.window !== b.window)
            continue;
        const factor = b.usdPerPct / a.usdPerPct;
        const sigma = sigmaOf({ relSe: a.relSe }, { relSe: b.relSe }, factor);
        if (Math.max(factor, 1 / factor) < MIN_FACTOR || sigma < RESET_SIGMA)
            continue;
        const c = {
            window: b.window, label: b.label, kind: "reset", at: b.start, prevEnd: a.resetsAt,
            usdPerPctBefore: a.usdPerPct, usdPerPctAfter: b.usdPerPct, tokensPerPctBefore: a.tokensPerPct, tokensPerPctAfter: b.tokensPerPct,
            factor, sigma, versionsBefore: a.versions, versionsAfter: b.versions,
        };
        const pa = periodOf(a), pb = periodOf(b);
        if (pa && pb)
            explainMove(c, mixRows(segmentsOf(pa, usage, stretchMs).segments, usage, false), mixRows(segmentsOf(pb, usage, stretchMs).segments, usage, true), ratesNear(a, [a, b]), { before: a.relSe, after: b.relSe }, RESET_SIGMA);
        out.push(c);
    }
    // Inside a window: its own stretches again, split once where two rates fit best.
    // Every window with a figure, loose ones too: a move inside a window is what makes its figure loose.
    for (const w of windows.filter((x) => x.usdPerPct !== undefined)) {
        const period = periodOf(w);
        if (!period)
            continue;
        const segs = segmentsOf(period, usage, stretchMs).segments;
        if (segs.length < 2 * MIN_SIDE)
            continue;
        const u = segs.map((s) => s.usd), d = segs.map((s) => s.dpct);
        const sse = (from, to) => {
            const r = ratio(u.slice(from, to), d.slice(from, to));
            return r ? u.slice(from, to).reduce((a, v, i) => a + (v - r.r * d[from + i]) ** 2, 0) : Infinity;
        };
        let best;
        for (let s = MIN_SIDE; s <= segs.length - MIN_SIDE; s++) {
            const cost = sse(0, s) + sse(s, segs.length);
            if (!best || cost < best.cost)
                best = { at: s, cost };
        }
        if (!best)
            continue;
        const before = ratio(u.slice(0, best.at), d.slice(0, best.at)), after = ratio(u.slice(best.at), d.slice(best.at));
        if (!before || !after)
            continue;
        const factor = after.r / before.r;
        const sigma = sigmaOf(before, after, factor);
        if (Math.max(factor, 1 / factor) < MIN_FACTOR || sigma < WITHIN_SIGMA)
            continue;
        const tok = (from, to) => {
            const t = usage.filter((p) => p.ts > segs[from].from && p.ts <= segs[to - 1].to).reduce((a, p) => a + tokensOf(p), 0);
            const pct = d.slice(from, to).reduce((a, v) => a + v, 0);
            return pct > 0 ? t / pct : undefined;
        };
        const vers = (from, to) => [...new Set(usage.filter((p) => p.ts > segs[from].from && p.ts <= segs[to - 1].to).map((p) => p.version).filter((v) => !!v))].sort(compareVersions);
        const c = {
            window: w.window, label: w.label, kind: "within", at: segs[best.at].from,
            usdPerPctBefore: before.r, usdPerPctAfter: after.r, tokensPerPctBefore: tok(0, best.at), tokensPerPctAfter: tok(best.at, segs.length),
            factor, sigma, versionsBefore: vers(0, best.at), versionsAfter: vers(best.at, segs.length),
        };
        explainMove(c, mixRows(segs.slice(0, best.at), usage, false), mixRows(segs.slice(best.at), usage, true), ratesNear(w, [], w), { before: before.relSe, after: after.relSe }, WITHIN_SIGMA);
        out.push(c);
    }
    return out.sort((a, b) => a.at - b.at);
}
/** Every weekly window's resets and the moves between them, for one app's readings and usage. */
function perReset(readings, usage, now) {
    const resets = [];
    const changes = [];
    for (const [, rs] of byWindow(readings)) {
        const ms = rs[rs.length - 1]?.windowMs ?? 0;
        if (ms < PER_RESET_MIN_MS)
            continue;
        const ws = resetWindowsOf(rs, usage, { now });
        resets.push(...ws);
        changes.push(...slopeChanges(ws, usage, rs));
    }
    return { resets, changes };
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
    const claudeReset = perReset(claude, claudeUse, now);
    const codexReset = perReset(codex.readings, codex.usage, now);
    const claudeSources = {};
    for (const r of claude)
        claudeSources[r.source ?? "earlier"] = (claudeSources[r.source ?? "earlier"] ?? 0) + 1;
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
    return {
        days, now, claudeLog: logPath, claudeReadings: claude.length, codexReadings: codex.readings.length, windows, fits,
        resets: [...claudeReset.resets, ...codexReset.resets],
        changes: [...claudeReset.changes, ...codexReset.changes],
        claudeWindows: CLAUDE_WINDOWS.filter((w) => claude.some((r) => r.window === w)),
        claudeSources,
    };
}
/**
 * The per-reset view of the limits, for a pane or a script: every window's
 * current state, every weekly window with its dollars and tokens per 1%
 * (by entrypoint and model where the readings allow) and every move in that
 * figure, dated. Reads the limits ledger, Codex's rollouts and the
 * transcripts over the readings' span; never writes.
 */
export function limitsByReset(days = 30, opts = {}) {
    const r = limitsReport(days, opts);
    return { now: r.now, windows: r.windows, resets: r.resets, changes: r.changes, noFiveHour: r.claudeWindows.length === 1 && r.claudeWindows[0] === "seven_day", readings: r.claudeReadings + r.codexReadings };
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
/**
 * The one line that says how to start recording Claude readings: the
 * plugin's mod (after each turn, in the Desktop app, the terminal and VS
 * Code), or the autopilot proxy (from the API's rate-limit headers).
 */
export const HOW_TO_RECORD = "To record them: `context-doctor install` (the plugin's mod writes them after each turn, Claude Code 2.1.286+; `install --statusline` on older ones), or `context-doctor autopilot on` (its proxy reads them from the API's replies).";
/** "2026-11-03" and "2026-11-03 14:00 UTC": the same date for whoever reads a pasted report. */
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const utcMinute = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
/** "$25.10", "$4.02", "$130". */
const dollars = (v) => (v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`);
/** "21.0M", "450k". */
const tokenCount = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(Math.round(v)));
const plusMinus = (relSe) => (relSe !== undefined && Number.isFinite(relSe) ? ` ±${Math.max(1, Math.round(relSe * 100))}%` : "");
/** "2.1.321", "2.1.321 to 2.1.325 (3)". */
const versionSpan = (vs) => (!vs.length ? "unknown" : vs.length === 1 ? vs[0] : `${vs[0]} to ${vs[vs.length - 1]}${vs.length > 2 ? ` (${vs.length})` : ""}`);
/** "claude-desktop 88%, cli 12%". */
const sharesLine = (list) => list.map((t) => `${t.key} ${Math.round(t.share * 100)}%`).join(", ");
/** Two windows of the same kind with a figure each: something to compare. */
const comparable = (ws) => {
    const seen = new Map();
    for (const w of ws)
        if (w.usdPerPct !== undefined && !w.why)
            seen.set(w.window, (seen.get(w.window) ?? 0) + 1);
    return [...seen.values()].some((n) => n > 1);
};
/** Two keys or more with a real share of the dollars: a split worth a line. */
const mixed = (list) => list.filter((t) => t.share >= MIN_KEY_SHARE).length >= 2;
/** A move in words: when, from what to what, how many times, and the Claude Code versions either side. */
function changeLine(c) {
    const when = c.kind === "reset"
        ? c.prevEnd !== undefined && Math.abs(c.prevEnd - c.at) > SAME_RESET_MS
            ? `between the reset of ${utcMinute(c.prevEnd)} and the window from ${utcMinute(c.at)}`
            : `at the reset of ${utcMinute(c.at)}`
        : `within the window, around ${utcMinute(c.at)}`;
    const move = (f) => (f < 1 ? `${(1 / f).toFixed(1)}x less use per 1%` : `${f.toFixed(1)}x more use per 1%`);
    const drains = (f) => (f < 1 ? "the limit drains faster" : "the limit drains slower");
    const tok = c.tokensPerPctBefore !== undefined && c.tokensPerPctAfter !== undefined ? `; tokens per 1% ${tokenCount(c.tokensPerPctBefore)} to ${tokenCount(c.tokensPerPctAfter)}` : "";
    const ver = versionSpan(c.versionsBefore) !== versionSpan(c.versionsAfter) ? `; Claude Code ${versionSpan(c.versionsBefore)} before, ${versionSpan(c.versionsAfter)} after` : "";
    const head = `${c.label}, ${when}: 1% went from ${dollars(c.usdPerPctBefore)} to ${dollars(c.usdPerPctAfter)} of API-equivalent use`;
    if (!c.cause || c.cause === "limit" || !c.mix)
        return `${head} (${move(c.factor)}: ${drains(c.factor)})${tok}${ver}.`;
    const m = c.mix;
    const pct = (v) => `${Math.round((v ?? 0) * 100)}%`;
    const used = `you used ${modelLabel(m.grew)} for ${pct(m.after[m.grew])} of your dollars after it (${pct(m.before[m.grew])} before)`;
    const rate = m.pctPerUsd?.[m.grew], other = m.shrank ? m.pctPerUsd?.[m.shrank] : undefined;
    const ratio = rate !== undefined && other !== undefined && other > 0 ? rate / other : undefined;
    const per = ratio === undefined || (ratio < 1.1 && ratio > 1 / 1.1) ? ""
        : ratio > 1 ? `, which uses your limit ${ratio.toFixed(1)}x faster per dollar than ${modelLabel(m.shrank)}`
            : `, which uses your limit ${(1 / ratio).toFixed(1)}x slower per dollar than ${modelLabel(m.shrank)}`;
    const predicted = m.predictedBefore !== undefined && m.predictedAfter !== undefined ? `; the mix alone predicts ${dollars(m.predictedBefore)} to ${dollars(m.predictedAfter)}` : "";
    if (c.cause === "unclear") {
        return `${head} (${move(c.factor)}), and your model mix changed too: ${used}. Per-model figures are too thin yet to say how much of the move that explains${tok}${ver}.`;
    }
    const r = c.residual;
    if (c.cause === "mix") {
        const left = Math.max(r, 1 / r) < 1.15 ? "per model, 1% buys about the same" : `per model, 1% buys ${move(r).replace(" per 1%", "")}, under the 1.5x this report calls a move`;
        return `${head} (${move(c.factor)}). This comes from your model mix, not the limit: ${used}${per}${predicted}; ${left}${tok}${ver}.`;
    }
    return `${head} (${move(c.factor)}). Part of it is your model mix: ${used}${per}${predicted}. Beyond the mix, per model, 1% buys ${move(r).replace(" per 1%", "")}: ${drains(r)}${tok}${ver}.`;
}
/** "claude-fable-5-2" as "Fable 5.2"; any other id as it is. */
function modelLabel(key) {
    const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(key ?? "");
    return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : key ?? "another model";
}
/** Each key's own dollars per 1%, where the fit told them apart: "sdk-cli $13.90 ±9%, cli $25.00 ±7% (sdk-cli drains 1.8x per dollar)". */
function splitLine(list) {
    const known = list.filter((t) => t.usdPerPct !== undefined);
    if (known.length < 2)
        return undefined;
    const sorted = [...known].sort((a, b) => a.usdPerPct - b.usdPerPct);
    const fast = sorted[0], slow = sorted[sorted.length - 1];
    const ratio = slow.usdPerPct / fast.usdPerPct;
    return `${sorted.map((t) => `${t.key} ${dollars(t.usdPerPct)}${plusMinus(t.relSe)}`).join(", ")} per 1%${ratio >= 1.1 ? ` (${fast.key} drains ${ratio.toFixed(1)}x per dollar against ${slow.key})` : ""}`;
}
/**
 * The full `limits` report. `pastLimit`: lines on requests paid from usage
 * credits past a limit (credits.ts creditsLines), placed under the windows;
 * none when nothing went past one.
 */
export function renderLimits(r, pastLimit = []) {
    const out = ["USAGE LIMITS", "═".repeat(60)];
    if (!r.windows.length && !r.resets.length) {
        out.push(`No limit readings yet. ${HOW_TO_RECORD}`, "", `Claude readings are kept in ${r.claudeLog.replace(homedir(), "~")}; Codex's are read from ~/.codex/sessions (none in the period).`);
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
        if (s.stale)
            out.push(`  The newest reading is ${hm(age)} old: no pace or run-out time from it until a new one comes in.`);
        else if (s.recentPerHour === undefined)
            out.push("  Pace: not enough recent readings.");
        else if (s.recentPerHour === 0)
            out.push("  Pace: no rise over the recent readings.");
        else {
            const avg = s.averagePerHour !== undefined ? `; ${pts(s.averagePerHour)}% an hour on average this window` : "";
            out.push(`  Pace: ${pts(s.recentPerHour)}% of the limit an hour lately${avg}.`);
            if (s.runsOutAt !== undefined) {
                out.push(s.beforeReset
                    ? `  At that pace it runs out ${clock(s.runsOutAt, r.now)} (in ${hm(s.runsOutAt - r.now)}), before the reset.`
                    : "  At that pace it lasts until the reset.");
            }
        }
    }
    if (r.claudeWindows.length === 1 && r.claudeWindows[0] === "seven_day") {
        out.push("", "No 5-hour window in Claude's readings: a plan without one (Ultra), so the weekly window is the limit.");
    }
    if (pastLimit.length) {
        out.push("", "Past your plan's limit: usage credits", "─".repeat(60), ...pastLimit);
    }
    if (r.resets.length) {
        out.push("", "Each weekly (or longer) window, reset to reset: API-equivalent use per 1% (UTC dates)");
        out.push("─".repeat(60));
        for (const w of r.resets) {
            const head = `${w.label}, ${utcDay(w.start)} to ${utcDay(w.resetsAt)}${w.current ? " (now)" : ""}: ${pts(w.pctUsed)}% used`;
            if (w.usdPerPct !== undefined && !w.why)
                out.push(`${head}; ${dollars(w.usdPerPct)} per 1%${plusMinus(w.relSe)}, ${tokenCount(w.tokensPerPct ?? 0)} tokens per 1%`);
            else
                out.push(`${head}; no figure: ${w.why}`);
            if (w.pctElsewhere > 0)
                out.push(`  ${pts(w.pctElsewhere)} points rose with no usage here (used elsewhere), left out.`);
            if (w.byEntrypoint.length)
                out.push(`  By entrypoint (share of dollars): ${sharesLine(w.byEntrypoint)}`);
            const ep = splitLine(w.byEntrypoint);
            if (ep)
                out.push(`    ${ep}`);
            if (mixed(w.byModel))
                out.push(`  By model: ${sharesLine(w.byModel)}`);
            const md = splitLine(w.byModel);
            if (md)
                out.push(`    ${md}`);
            if (w.versions.length)
                out.push(`  Claude Code ${versionSpan(w.versions)}`);
        }
        if (r.changes.length) {
            out.push("", "What 1% buys moved:");
            for (const c of r.changes)
                out.push(`  ${changeLine(c)}`);
        }
        else if (comparable(r.resets)) {
            out.push("", "What 1% buys held steady across these windows (no move of 1.5x or more beyond the error).");
        }
        out.push("`context-doctor limits --report` prints this as a block to paste into a bug report.");
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
        if (r.changes.some((c) => c.window === f.window))
            out.push("  This fit spans the move in what 1% buys (above): read the per-window figures.");
    }
    out.push("", "Readings: Claude Code's (Pro, Max and Ultra; 0.1% steps) from the plugin's mod,", "the status line or the proxy, and Codex's rollouts (whole percents). Usage", "elsewhere (the web app, another computer) moves the limit without a transcript", "here, so it widens the error.");
    return out.join("\n");
}
/**
 * `limits --report`: a block to paste into a GitHub issue. Per weekly
 * window: % used, dollars and tokens per 1%, the split by entrypoint and
 * model, Claude Code's versions, and every move in what 1% buys, dated. It
 * carries figures, dates, model and entrypoint names and version numbers
 * only: no prompt, no path, no session or account id (reportModel masks a
 * model id that is a cloud resource).
 */
export function renderLimitsReport(r) {
    if (!r.windows.length && !r.resets.length)
        return `No limit readings yet. ${HOW_TO_RECORD}`;
    const out = ["### Usage limits, measured on my machine", ""];
    const versions = [...new Set(r.resets.filter((w) => w.app === "claude").flatMap((w) => w.versions))].sort(compareVersions);
    const claude = r.claudeWindows.length
        ? r.claudeWindows.includes("five_hour") ? "weekly and 5-hour" : "weekly only (no 5-hour window in the readings)"
        : "none";
    const srcNames = { mod: "the plugin's mod", statusline: "the status line", proxy: "the proxy", earlier: "an earlier recorder" };
    const sources = Object.entries(r.claudeSources).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} from ${srcNames[k] ?? k}`).join(", ");
    out.push(`- Measured with context-doctor ${PROXY_VERSION} (\`context-doctor limits --report\`), ${r.days} days to ${utcMinute(r.now)}`, `- Claude windows read: ${claude}${r.claudeReadings ? `; ${r.claudeReadings} readings (${sources})` : ""}${r.codexReadings ? `; Codex: ${r.codexReadings} readings` : ""}`, ...(r.claudeReadings ? [`- Claude Code version${versions.length === 1 ? "" : "s"}: ${versions.length ? versions.join(", ") : "unknown"}`] : []), "- Dollars are API-equivalent: this machine's requests priced at API list rates, not a bill. % matched: the rise in stretches with usage here; the rest came with no transcript here (claude.ai, another computer).", "");
    if (r.resets.length) {
        out.push("| Window, reset to reset (UTC) | % used | % matched | $ per 1% | Tokens per 1% | By entrypoint ($ share) | Claude Code |", "|---|---|---|---|---|---|---|");
        for (const w of r.resets) {
            const fig = w.usdPerPct !== undefined && !w.why;
            out.push(`| ${w.label.replace(/ weekly$/, "")} ${utcDay(w.start)} to ${utcDay(w.resetsAt)}${w.current ? " (now)" : ""} | ${pts(w.pctUsed)} | ${pts(w.pctMatched)} | ${fig ? `${dollars(w.usdPerPct)}${plusMinus(w.relSe)}` : "n/a"} | ${fig ? tokenCount(w.tokensPerPct ?? 0) : "n/a"} | ${sharesLine(w.byEntrypoint) || "none"} | ${w.app === "claude" ? versionSpan(w.versions) : "n/a"} |`);
        }
        out.push("");
        out.push(r.changes.length ? "**What 1% buys moved:**" : comparable(r.resets) ? "**What 1% buys:** no move of 1.5x or more beyond the error between these windows." : "**What 1% buys:** fewer than two windows with a figure, nothing to compare yet.");
        for (const c of r.changes)
            out.push(`- ${changeLine(c)}`);
        const splits = r.resets.flatMap((w) => {
            const lines = [];
            const ep = splitLine(w.byEntrypoint), md = splitLine(w.byModel);
            if (ep)
                lines.push(`- ${utcDay(w.start)} to ${utcDay(w.resetsAt)}, by entrypoint: ${ep}`);
            if (md)
                lines.push(`- ${utcDay(w.start)} to ${utcDay(w.resetsAt)}, by model: ${md}`);
            if (!md && mixed(w.byModel))
                lines.push(`- ${utcDay(w.start)} to ${utcDay(w.resetsAt)}, models ($ share): ${sharesLine(w.byModel)}`);
            return lines;
        });
        if (splits.length)
            out.push("", "**Per entrypoint and model** (each one's own $ per 1%, where the stretches tell them apart):", ...splits);
        const thin = r.resets.filter((w) => w.why);
        if (thin.length)
            out.push("", ...thin.map((w) => `- No figure for ${utcDay(w.start)} to ${utcDay(w.resetsAt)}: ${w.why}.`));
    }
    else {
        out.push("No weekly window with readings in the period yet.");
    }
    const now5h = r.windows.find((w) => w.window === "five_hour");
    const nowWeek = r.windows.find((w) => w.window === "seven_day");
    if (nowWeek || now5h)
        out.push("", `Now: ${[nowWeek ? `weekly ${pts(nowWeek.pct)}%` : "", now5h ? `5-hour ${pts(now5h.pct)}%` : ""].filter(Boolean).join(", ")}.`);
    out.push("", "No prompts, file paths, session or account ids are included.");
    return out.join("\n");
}
