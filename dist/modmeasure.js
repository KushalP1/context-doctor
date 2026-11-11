/**
 * `context-doctor mod measure`: what the plugin's mod hands over after each
 * turn, kept the way the status line keeps it.
 *
 * The status line never runs in the Desktop app's Code tab or the VS Code
 * extension, so there the limit ledger stayed empty and Claude Code's own
 * cost was never compared with ours (ROADMAP K2). A mod runs there: after
 * each main-thread turn Claude Code raises `session.measure` with the
 * rate-limit windows (`kind`, `percentUsed`, `resetsAt` as ISO 8601) and the
 * session's cost (`cost.usd`, as /cost totals it). The mod has no file
 * access of its own worth trusting with our formats, so it runs this command
 * with that reading on stdin, and this:
 *
 *  - appends the windows to the limits ledger in the status line's own
 *    format and with its rules (recordLimits: changes only, at most once a
 *    minute, never a lower figure of the same window from a parallel
 *    session), so `context-doctor limits` reads Desktop's readings too;
 *  - appends Claude Code's cost beside our own price of the same session
 *    (sessionTotal: the transcript and its subagents, as the every-prompt
 *    hook prices it) to a small capped ledger, for `doctor`'s comparison;
 *  - prints what the band needs, as JSON: the cache clock read from the
 *    transcript's tail (coldresume.ts), the re-write's price, the price.
 *
 * Silent like the status line: anything unreadable prints `{}` and exits 0.
 * Off: CONTEXT_DOCTOR_NO_LIMITS_LOG=1 (the limits), CONTEXT_DOCTOR_NO_COST_LOG=1
 * (the cost ledger).
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { statePath } from "./ledger.js";
import { recordLimits } from "./limits.js";
import { claudeProjectDir } from "./session.js";
import { claudeDir } from "./claudedir.js";
import { saveIfWorthIt, sessionPriceThresholds, sessionTotal } from "./sessionprice.js";
import { AFTER_COMPACT_TOKENS, autoCompactsAt, COLD_MARGIN_MS, COLD_MIN_TOKENS, detectColdResume } from "./coldresume.js";
import { rateCard, ratesAt } from "./pricing.js";
/**
 * The mod's windows in the status line's shape, `{ five_hour: { used_percentage,
 * resets_at } }`, resets in epoch seconds: the one shape recordLimits reads.
 * A gateway's `spend_limit` has no place in the ledger and is left out.
 */
export function statusLineRateLimits(list) {
    if (!Array.isArray(list))
        return undefined;
    const out = {};
    for (const w of list) {
        if (!w || typeof w !== "object")
            continue;
        const { kind, percentUsed, resetsAt } = w;
        if ((kind !== "five_hour" && kind !== "seven_day") || typeof percentUsed !== "number" || !Number.isFinite(percentUsed))
            continue;
        const reset = typeof resetsAt === "string" ? Date.parse(resetsAt) : NaN;
        out[kind] = { used_percentage: percentUsed, ...(Number.isFinite(reset) && reset > 0 ? { resets_at: Math.round(reset / 1000) } : {}) };
    }
    return Object.keys(out).length ? out : undefined;
}
/** A Claude Code session's transcript: in its folder's project, else wherever a project holds the id (a session that moved folders). */
export function findTranscript(sessionId, cwd, home) {
    if (!sessionId || !/^[\w.-]{1,100}$/.test(sessionId))
        return undefined;
    const name = `${sessionId}.jsonl`;
    if (cwd) {
        const p = join(claudeProjectDir(cwd, home), name);
        if (existsSync(p))
            return p;
    }
    const root = join(claudeDir(home), "projects");
    let dirs = [];
    try {
        dirs = readdirSync(root);
    }
    catch {
        return undefined;
    }
    for (const d of dirs) {
        const p = join(root, d, name);
        if (existsSync(p))
            return p;
    }
    return undefined;
}
export function costLogPath() {
    return join(dirname(statePath()), ".context-doctor-session-cost.jsonl");
}
/** Past this size the ledger keeps its newest COST_KEEP_BYTES: one ~130-byte line a turn holds months of sessions. */
const COST_ROTATE_AT = 512 * 1024;
const COST_KEEP_BYTES = 384 * 1024;
/** A session's figure is written again only once it moved this much. */
const MIN_MOVE_USD = 0.005;
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
function parseCostLine(line) {
    let e;
    try {
        e = JSON.parse(line);
    }
    catch {
        return undefined;
    }
    if (!e || typeof e !== "object" || typeof e.ts !== "number" || !Number.isFinite(e.ts) || typeof e.sid !== "string")
        return undefined;
    const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
    return {
        ts: e.ts,
        sid: e.sid,
        ...(num(e.cc) !== undefined ? { cc: num(e.cc) } : {}),
        ...(num(e.cd) !== undefined ? { cd: num(e.cd) } : {}),
        ...(typeof e.model === "string" ? { model: e.model.slice(0, 100) } : {}),
        ...(num(e.unpriced) ? { unpriced: num(e.unpriced) } : {}),
        ...(num(e.est) ? { est: num(e.est) } : {}),
        ...(typeof e.ev === "string" ? { ev: e.ev.slice(0, 20) } : {}),
        ...(num(e.tokens) !== undefined ? { tokens: num(e.tokens) } : {}),
    };
}
function append(path, line) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && statSync(path).size > COST_ROTATE_AT) {
        const text = tail(path, COST_KEEP_BYTES);
        writeFileSync(path, text.slice(text.indexOf("\n") + 1));
    }
    appendFileSync(path, JSON.stringify(line) + "\n");
}
/**
 * Append a session's two figures, unless neither moved since its last line
 * (a second measure of the same turn, a parallel window of the same session).
 * Never throws. True when a line was written.
 */
export function recordSessionCost(line, path = costLogPath()) {
    if (line.cc === undefined && line.cd === undefined)
        return false;
    try {
        if (existsSync(path)) {
            let last;
            for (const l of tail(path, 32 * 1024).split("\n")) {
                const p = parseCostLine(l);
                if (p && !p.ev && p.sid === line.sid)
                    last = p;
            }
            const same = (a, b) => (a === undefined && b === undefined) || (a !== undefined && b !== undefined && Math.abs(a - b) < MIN_MOVE_USD);
            if (last && same(last.cc, line.cc) && same(last.cd, line.cd))
                return false;
        }
        append(path, line);
        return true;
    }
    catch {
        return false;
    }
}
/** A press of one of the mod's buttons that changes nothing on disk (the Compact button), for the follow-through count. */
export function recordModEvent(sid, ev, tokens, now = Date.now(), path = costLogPath()) {
    if (!/^[\w.-]{1,100}$/.test(sid) || !/^[a-z-]{1,20}$/.test(ev))
        return false;
    try {
        append(path, { ts: now, sid, ev, ...(tokens !== undefined && Number.isFinite(tokens) ? { tokens } : {}) });
        return true;
    }
    catch {
        return false;
    }
}
/** Every line of the ledger since `since`. */
export function readCostLines(since = 0, path = costLogPath()) {
    let text;
    try {
        text = readFileSync(path, "utf8");
    }
    catch {
        return [];
    }
    return text.split("\n").map(parseCostLine).filter((l) => !!l && l.ts >= since);
}
/** Below this, Claude Code's figure is too small for a percentage to mean anything. */
const MIN_COMPARE_USD = 0.5;
/** The target: within this of Claude Code's figure wherever every model is priced (ROADMAP K2). */
export const COST_GAP_TARGET = 0.02;
/** Each session's last pair, where both figures are there and Claude Code's is worth comparing. */
export function costGaps(lines) {
    const last = new Map();
    for (const l of lines)
        if (!l.ev && l.cc !== undefined && l.cd !== undefined)
            last.set(l.sid, l);
    return [...last.values()]
        .filter((l) => l.cc >= MIN_COMPARE_USD)
        .map((l) => ({ sid: l.sid, ts: l.ts, cc: l.cc, cd: l.cd, gap: (l.cd - l.cc) / l.cc, ...(l.model ? { model: l.model } : {}), ...(l.unpriced ? { unpriced: l.unpriced } : {}) }));
}
const pct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(Math.abs(x) < 0.1 ? 1 : 0)}%`;
/**
 * `doctor`'s line: how close our session price is to Claude Code's own cost,
 * on the sessions the mod measured in the last `days`. Undefined when it
 * measured none (no mod, or no session above $0.50 yet).
 */
export function costCheck(days = 30, now = Date.now(), path = costLogPath()) {
    const gaps = costGaps(readCostLines(now - days * 86_400_000, path));
    if (!gaps.length)
        return undefined;
    const label = "Session price vs Claude Code";
    const within = gaps.filter((g) => Math.abs(g.gap) <= COST_GAP_TARGET).length;
    const worst = [...gaps].sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))[0];
    const n = gaps.length;
    const head = `${within} of ${n} session${n === 1 ? "" : "s"} the mod measured in the last ${days} days within ${COST_GAP_TARGET * 100}% of Claude Code's own cost`;
    if (within === n)
        return { label, status: "ok", detail: `${head} (largest gap ${pct(worst.gap)})` };
    const why = worst.unpriced ? `, ${worst.unpriced} request${worst.unpriced === 1 ? "" : "s"} with no list price` : "";
    return { label, status: "warn", detail: `${head}; the largest gap is ${pct(worst.gap)} ($${worst.cd.toFixed(2)} against $${worst.cc.toFixed(2)}${worst.model ? `, on ${worst.model}` : ""}${why}). A price missing from context-doctor's table, or contracted rates Claude Code applies (modelPricing), show up here` };
}
// -- The measure itself ---------------------------------------------------------------
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
/**
 * Keep what the mod measured and work out the band's inputs. Never throws;
 * what it cannot read is left out of the answer.
 */
export function modMeasure(input, now = Date.now(), env = process.env) {
    const out = { at: now, coldMinTokens: COLD_MIN_TOKENS, thresholds: sessionPriceThresholds(env) };
    try {
        if (env.CONTEXT_DOCTOR_NO_LIMITS_LOG !== "1")
            recordLimits(statusLineRateLimits(input?.rateLimits), now);
    }
    catch { /* the rest still runs */ }
    const ccUsd = num(input?.cost?.usd);
    if (ccUsd !== undefined)
        out.ccUsd = ccUsd;
    const sid = typeof input?.sessionId === "string" ? input.sessionId : undefined;
    const transcript = findTranscript(sid, typeof input?.cwd === "string" ? input.cwd : undefined);
    if (!sid || !transcript)
        return out;
    try {
        const t = sessionTotal({ sessionId: sid, transcript }, now);
        saveIfWorthIt(t);
        out.usd = t.usd;
        if (env.CONTEXT_DOCTOR_NO_COST_LOG !== "1") {
            recordSessionCost({ ts: now, sid, ...(ccUsd !== undefined ? { cc: round(ccUsd) } : {}), cd: round(t.usd), ...(typeof input.model === "string" ? { model: input.model.slice(0, 100) } : {}), ...(t.unpriced ? { unpriced: t.unpriced } : {}), ...(t.estimatedUsd >= 0.005 ? { est: round(t.estimatedUsd) } : {}) });
        }
    }
    catch { /* no price: the band does without it */ }
    try {
        // Every return counts here (no idle or size gate): the band decides when it shows.
        const c = detectColdResume(transcript, now, 0, 0);
        if (c) {
            out.tokens = c.tokens;
            if (c.model)
                out.model = c.model;
            out.lastReplyAt = c.lastReplyAt;
            if (c.ttlMs !== undefined)
                out.ttlMs = c.ttlMs;
            out.coldMarginMs = COLD_MARGIN_MS;
            if (c.resumeUsd !== undefined)
                out.rewriteUsd = c.resumeUsd;
            if (c.perMessageUsd !== undefined)
                out.perMessageUsd = c.perMessageUsd;
            const card = rateCard(c.model, undefined, now);
            if (card)
                out.afterCompactPerMessageUsd = (Math.min(c.tokens, AFTER_COMPACT_TOKENS) * ratesAt(card, AFTER_COMPACT_TOKENS).cacheReadPerM) / 1e6;
            const auto = autoCompactsAt(c.model);
            if (auto !== undefined)
                out.autoCompactAt = auto;
        }
    }
    catch { /* no clock: the band shows the price alone */ }
    return out;
}
const round = (n) => Math.round(n * 10_000) / 10_000;
async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}
/**
 * The CLI side: `mod measure` keeps the reading and prints the band's
 * figures; `mod event` records a press (`{ sessionId, ev, tokens }`). Both
 * print JSON and exit 0 whatever happens, as the status line does.
 */
export async function runMod(sub) {
    let out = {};
    try {
        const input = JSON.parse((await readStdin()) || "{}");
        if (sub === "measure")
            out = modMeasure(input);
        else
            out = { ok: recordModEvent(String(input?.sessionId ?? ""), String(input?.ev ?? ""), num(input?.tokens)) };
    }
    catch {
        /* silent by design: the mod shows what it had */
    }
    process.stdout.write(JSON.stringify(out) + "\n");
}
