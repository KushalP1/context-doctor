/**
 * What the context-doctor mod shows and runs, as plain functions.
 *
 * The mod (register.ts) runs inside Claude Code's mods runtime, which has no
 * Node: no fs, no child_process, no imports of the rest of context-doctor.
 * So everything it decides is here, with no imports at all, and the measuring
 * and the writing are done by the CLI it runs (`context-doctor mod measure`,
 * `fix --apply`, `fix undo`), the same code as in a terminal. The node test
 * suite exercises these functions directly.
 */
/** The band shows within this long of the cache going cold... */
export const WARN_BEFORE_MS = 5 * 60_000;
const MIN = 60_000;
/**
 * ...or within this share of the cache's life, when that is shorter: the last
 * minute of a 5-minute cache (WARN_BEFORE_MS would be all of it, the band
 * after every turn), the last five of the 1-hour cache.
 */
export const WARN_SHARE = 1 / 5;
/** How long before the cache goes cold the band warns, for a cache that lives `ttlMs`. */
export function warnBeforeMs(ttlMs) {
    return Math.min(WARN_BEFORE_MS, ttlMs * WARN_SHARE);
}
/** The session price thresholds when the CLI cannot say them (no Node): the defaults, the environment's own, or none. */
export const DEFAULT_THRESHOLDS = [25, 100, 500];
/** CONTEXT_DOCTOR_SESSION_PRICE and CONTEXT_DOCTOR_NO_SESSION_PRICE read as sessionprice.ts reads them. */
export function thresholdsFrom(raw, off) {
    if (off === "1")
        return [];
    const text = raw?.trim();
    if (!text)
        return DEFAULT_THRESHOLDS;
    const set = text.split(/[\s,]+/).map((v) => Number(v.replace(/^\$/, ""))).filter((v) => Number.isFinite(v) && v > 0);
    return set.length ? [...new Set(set)].sort((a, b) => a - b) : DEFAULT_THRESHOLDS;
}
/** "$0.42", "$3.10", "$112", "$1,240". */
export function money(n) {
    if (!Number.isFinite(n))
        return "$0.00";
    if (n >= 100)
        return `$${Math.round(n).toLocaleString("en-US")}`;
    if (n >= 0.01 || n === 0)
        return `$${n.toFixed(2)}`;
    return "<$0.01";
}
/** "820", "45k", "520k", "1.2M". */
export function tokens(n) {
    if (!Number.isFinite(n) || n < 0)
        return "0";
    if (n < 1000)
        return String(Math.round(n));
    if (n < 999_500)
        return `${Math.round(n / 1000)}k`;
    return `${(n / 1e6).toFixed(1)}M`;
}
/** "3 min", "1h 20m", "2 days". */
export function duration(ms) {
    const m = Math.max(1, Math.round(ms / MIN));
    if (m < 60)
        return `${m} min`;
    if (m < 48 * 60)
        return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
    return `${Math.round(m / 1440)} days`;
}
/** The highest session price threshold `usd` has passed, or undefined. */
export function passedThreshold(usd, thresholds) {
    if (usd === undefined || !Number.isFinite(usd))
        return undefined;
    const passed = thresholds.filter((t) => usd >= t);
    return passed[passed.length - 1];
}
/** The session's price as the band says it, with Claude Code's own figure beside ours when both are known. */
export function priceText(d) {
    if (d.usd !== undefined && d.ccUsd !== undefined)
        return `session ${money(d.usd)} (Claude Code: ${money(d.ccUsd)})`;
    if (d.usd !== undefined)
        return `session ${money(d.usd)}`;
    if (d.ccUsd !== undefined)
        return `session ${money(d.ccUsd)} (Claude Code's figure)`;
    return undefined;
}
/**
 * The band above the prompt at `now`. Quiet unless it pays (the cache about
 * to go cold, or gone cold, on a context worth caring about; the session
 * past a price threshold), except with `always`. The terminal has the
 * status line for the clock and the price, so there the band shows only the
 * cold return, the one thing with a button. Nothing on mobile.
 */
export function band(d, now, surface, opts = {}) {
    if (!d || surface === "mobile")
        return { kind: "none" };
    const hidden = opts.hidden ?? new Set();
    const show = (b) => (hidden.has(b.key) ? { kind: "none" } : b);
    const terminal = surface === "terminal";
    const price = priceText(d);
    const big = d.tokens !== undefined && d.tokens >= d.coldMinTokens;
    const known = d.tokens !== undefined && d.lastReplyAt !== undefined && d.ttlMs !== undefined;
    if (known) {
        const expiresAt = d.lastReplyAt + d.ttlMs;
        const coldAt = expiresAt + (d.coldMarginMs ?? 0);
        const rewrite = `${tokens(d.tokens)} tokens${d.rewriteUsd !== undefined ? ` (~${money(d.rewriteUsd)})` : ""}`;
        const tail = price && !terminal ? ` · ${price}` : "";
        // The return the cold-resume offer is about: past the cache's life by the margin, big enough, and not about to be compacted by Claude Code anyway.
        if (now >= coldAt && big && d.tokens < (d.autoCompactAt ?? Infinity)) {
            const each = d.perMessageUsd !== undefined && d.afterCompactPerMessageUsd !== undefined
                ? `each later message re-reads ~${money(d.perMessageUsd)} of context now, ~${money(d.afterCompactPerMessageUsd)} after`
                : `each later message re-reads ${tokens(d.tokens)} tokens now, far fewer after`;
            return show({
                kind: "cold",
                key: `cold:${d.lastReplyAt}`,
                text: `context-doctor: idle ${duration(now - d.lastReplyAt)}, the cache expired: your next message re-writes ${rewrite}${tail}`,
                compact: `Compact first: ${each}`,
            });
        }
        if (terminal)
            return { kind: "none" };
        if (now >= expiresAt && (big || opts.always)) {
            return show({ kind: "expired", key: `expired:${d.lastReplyAt}`, text: `context-doctor: the cache expired, so your next message re-writes ${rewrite}${tail}` });
        }
        if (now < expiresAt && (opts.always || (big && expiresAt - now <= warnBeforeMs(d.ttlMs)))) {
            return show({ kind: "warm", key: `warm:${d.lastReplyAt}`, text: `context-doctor: cache warm for ${duration(expiresAt - now)}, then your next message re-writes ${rewrite}${tail}` });
        }
    }
    if (terminal)
        return { kind: "none" };
    const usd = d.usd ?? d.ccUsd;
    const t = passedThreshold(usd, d.thresholds);
    if (price && (t !== undefined || opts.always)) {
        return show({ kind: "price", key: `price:${t ?? 0}`, text: `context-doctor: ${price}` });
    }
    return { kind: "none" };
}
/** The lever that changes which model runs: never applied by `--apply all`, and marked as such here. */
export const MODEL_CHANGE = "subagent-model";
/** Parse `fix --json`'s output; undefined when it is not a plan. */
export function parsePlan(stdout) {
    try {
        const j = JSON.parse(stdout);
        if (!j || typeof j !== "object" || !Array.isArray(j.fixes))
            return undefined;
        return j;
    }
    catch {
        return undefined;
    }
}
/**
 * The pane's rows: every lever the plan names, available ones first (the
 * plan's own order), each with Apply when it is available and Undo when
 * `fix` applied it (it is in the record, which is what `fix undo` reverts).
 */
export function paneRows(plan) {
    const applied = new Set((plan.since ?? []).map((s) => s.id));
    const rows = [];
    for (const f of plan.fixes) {
        const modelChange = f.id === MODEL_CHANGE;
        const saved = f.savedUsd !== undefined ? `${money(f.savedUsd)}${f.savedShare !== undefined ? ` (${Math.round(f.savedShare * 100)}%${f.shareOf ? ` ${f.shareOf}` : ""})` : ""}` : "not priced";
        const lines = [];
        if (f.state === "available") {
            if (modelChange)
                lines.push("Model change: subagents run on another model. Its quality cost is not measured here.");
            if (f.quality)
                lines.push(`quality: ${f.quality}`);
            if (f.change)
                lines.push(`changes: ${f.change}`);
            if (f.overriddenBy?.length)
                lines.push(`would not take effect: ${f.overriddenBy.join("; ")}`);
            if (f.tooOld)
                lines.push(f.tooOld);
        }
        else if (f.note) {
            lines.push(f.note);
        }
        const s = plan.since?.find((x) => x.id === f.id);
        if (s?.savedUsd !== undefined)
            lines.push(`${s.savedUsd >= 0 ? "saved" : "cost"} ${money(Math.abs(s.savedUsd))} since it was applied`);
        rows.push({
            id: f.id,
            head: f.state === "available" ? `${f.title} · ${saved} in ${plan.days} days` : `${f.title}${f.state === "applied" ? " · applied" : " · not here"}`,
            lines,
            modelChange,
            ...(f.state === "available" ? { apply: modelChange ? "Apply (model change)" : "Apply" } : {}),
            ...(applied.has(f.id) ? { undo: "Undo" } : {}),
        });
    }
    // A fix applied by `fix` that the plan no longer lists (its setting changed since): still undoable.
    for (const s of plan.since ?? []) {
        if (rows.some((r) => r.id === s.id))
            continue;
        rows.push({ id: s.id, head: `${s.id} · applied`, lines: s.detail ? [s.detail] : [], modelChange: s.id === MODEL_CHANGE, undo: "Undo" });
    }
    return rows;
}
/**
 * The rows after presses made since the plan was measured: an applied lever
 * offers Undo, an undone one nothing until the plan is measured again (its
 * figures are the old plan's). Measuring takes a while, so a press does not
 * re-measure by itself; the pane offers Refresh.
 */
export function withPresses(rows, presses) {
    return rows.map((r) => {
        const p = presses.get(r.id);
        if (p === "applied")
            return { ...r, head: r.head.replace(/ · [^·]* in \d+ days$/, "") + " · applied just now", apply: undefined, undo: "Undo" };
        if (p === "undone")
            return { ...r, head: r.head.replace(/ · applied$/, "") + " · undone just now", lines: ["Refresh to measure it again."], apply: undefined, undo: undefined };
        return r;
    });
}
/** A lever id the CLI accepts: letters, digits and hyphens (never an option, never a path). */
export function isFixId(id) {
    return /^[a-z][a-z0-9-]{0,40}$/.test(id);
}
/** The command a button runs: the CLI's own, so the files it writes are the CLI's. */
export function fixArgv(node, cli, op, id) {
    if (op === "plan")
        return [node, cli, "fix", "--json"];
    if (!id || !isFixId(id))
        throw new Error(`not a fix id: ${id}`);
    // `--json` only changes what is printed (the lines of what it did, without the plan): the same applyFix writes the same files.
    return op === "apply" ? [node, cli, "fix", "--apply", id, "--json"] : [node, cli, "fix", "undo", id];
}
/** What `fix --apply <id> --json` did, from its `applied` list; the text form's lines otherwise. */
export function applyOutcome(stdout, stderr, exitCode) {
    try {
        const j = JSON.parse(stdout);
        const a = Array.isArray(j?.applied) ? j.applied : [];
        if (a.length) {
            const lines = a.flatMap((x) => (Array.isArray(x?.lines) ? x.lines.filter((l) => typeof l === "string") : [])).map((l) => l.trim()).filter(Boolean);
            return { ok: exitCode === 0 && a.every((x) => x?.ok === true), lines: lines.slice(0, 8) };
        }
    }
    catch { /* not JSON: read it as text */ }
    return outcome(stdout, stderr, exitCode);
}
/** The CLI's lines, without the plan it prints first: what the press did. */
export function outcome(stdout, stderr, exitCode) {
    const text = stdout.replace(/\r\n/g, "\n");
    // `fix --apply` prints the plan, a blank line, then what it did; `fix undo` only what it did.
    const marks = text.split("\n").filter((l) => /^\s*(✓|✗|–|⚠|New |Nothing |[a-z-]+: )/.test(l));
    const lines = (marks.length ? marks : text.split("\n").filter((l) => l.trim()).slice(-3)).map((l) => l.trim());
    const err = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
    return { ok: exitCode === 0, lines: [...lines, ...(exitCode === 0 ? [] : err.slice(-3))].slice(0, 8) };
}
// -- Keeping the cache warm while away -------------------------------------------------
/**
 * `/context-doctor-keep-warm <hours> [$cap]`: while the person is away, a
 * cache read of the session's whole context every 55 minutes (4.5 on a
 * 5-minute cache), through Claude Code's `$.model.fork`: the main thread's
 * last request again with one short message after it, the reply kept out of
 * the transcript, so the return reads the context instead of writing it
 * again. Only on that command (the yes), capped in hours and dollars, never
 * armed by itself or again after it stops.
 *
 * On the author's 30 days (2026-11-15) a 2-hour cap would have sent 918
 * pings ($87) and kept 56 of 183 cold returns warm ($275 of re-writes): $188
 * net. `cache-misses` prices it on your own history.
 */
export const KEEP_WARM_COMMAND = "context-doctor-keep-warm";
export const KEEP_WARM_MAX_HOURS = 8;
export const KEEP_WARM_DEFAULT_CAP_USD = 2;
export const KEEP_WARM_MAX_CAP_USD = 20;
/** A ping every this long keeps a 1-hour cache warm, and a 5-minute one (coldreturns.ts prices the same). */
export const PING_EVERY_1H_MS = 55 * MIN;
export const PING_EVERY_5M_MS = 270_000;
/** The band's clock ticks this often: a ping goes out within one tick before its time, never after it. */
export const KEEP_WARM_TICK_MS = 30_000;
/** Asks for haste in the prompt, not with `effort`: a level other than the session's could write the whole context again. */
export const PING_PROMPT = "context-doctor keep-warm: an automated cache refresh while the person is away, not a request. Reply with the single word ok, straight away, with no tools and without thinking it over.";
/** The command's arguments: `2h`, `90m`, `2h $5`, `off`. None is a question, not a yes. */
export function parseKeepWarm(args) {
    const words = (args ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length)
        return { kind: "status" };
    if (words.length === 1 && /^(off|stop)$/.test(words[0]))
        return { kind: "off" };
    let hours, capUsd;
    for (const w of words) {
        const h = /^(\d+(?:\.\d+)?)h$/.exec(w), m = /^(\d+)(?:m|min)$/.exec(w), usd = /^\$(\d+(?:\.\d+)?)$/.exec(w);
        if (h && hours === undefined)
            hours = Number(h[1]);
        else if (m && hours === undefined)
            hours = Number(m[1]) / 60;
        else if (usd && capUsd === undefined)
            capUsd = Number(usd[1]);
        else
            return { kind: "error", text: `"${w}" is not a duration (2h, 90m) or a dollar limit ($5).` };
    }
    if (hours === undefined)
        return { kind: "error", text: `Say for how long: 2h, 90m (at most ${KEEP_WARM_MAX_HOURS}h).` };
    if (!(hours > 0) || hours > KEEP_WARM_MAX_HOURS)
        return { kind: "error", text: `At most ${KEEP_WARM_MAX_HOURS}h: past that, a cold return costs less than the pings.` };
    capUsd ??= KEEP_WARM_DEFAULT_CAP_USD;
    if (!(capUsd > 0) || capUsd > KEEP_WARM_MAX_CAP_USD)
        return { kind: "error", text: `A dollar limit from $0.01 to $${KEEP_WARM_MAX_CAP_USD}.` };
    return { kind: "arm", hours, capUsd };
}
export const pingEvery = (ttlMs) => (ttlMs >= 60 * MIN ? PING_EVERY_1H_MS : PING_EVERY_5M_MS);
const everyText = (ttlMs) => (pingEvery(ttlMs) >= 60 * MIN - 5 * MIN ? "55 minutes" : "4.5 minutes");
/** What a ping should cost: one read of the context (the band's per-message figure), and a little more for the prompt and reply. */
export function pingEstimateUsd(d) {
    return d.perMessageUsd !== undefined ? d.perMessageUsd * 1.05 : undefined;
}
/** Why keeping warm cannot start now, or undefined when it can. */
export function keepWarmRefusal(d, now) {
    if (!d || d.tokens === undefined || d.lastReplyAt === undefined || d.ttlMs === undefined)
        return "nothing measured in this session yet: send a message first, then run it as you leave.";
    if (now - d.lastReplyAt >= d.ttlMs)
        return `the cache already expired (idle ${duration(now - d.lastReplyAt)}): a ping now would write the whole context again. Run it before you step away.`;
    if (pingEstimateUsd(d) === undefined)
        return "this session's model has no known price, so the dollar limit could not be kept.";
    return undefined;
}
/**
 * What the timer does at `now`: wait, ping, or stop for good. A ping is due
 * a tick before its interval is up after the last request or ping, so it
 * lands inside the cache's life; a cache that lapsed anyway (Claude Code
 * closed, the machine asleep) is not pinged, since that ping would write the
 * whole context.
 */
export function keepWarmStep(kw, d, now) {
    if (!kw || kw.stopped)
        return { do: "wait" };
    if (now >= kw.until)
        return { do: "stop", why: `its ${duration(kw.until - kw.armedAt)} are up` };
    if (!d || d.lastReplyAt === undefined || d.ttlMs === undefined)
        return { do: "wait" };
    const last = Math.max(d.lastReplyAt, kw.lastPingAt ?? 0);
    if (now - last >= d.ttlMs)
        return { do: "stop", why: "the cache expired before a ping could go out (Claude Code closed, or the machine asleep)" };
    if (now - last < pingEvery(d.ttlMs) - KEEP_WARM_TICK_MS)
        return { do: "wait" };
    const est = pingEstimateUsd(d) ?? Infinity;
    if (kw.spentUsd + est > kw.capUsd)
        return { do: "stop", why: `the next ping (~${money(est)}) would pass its ${money(kw.capUsd)} limit` };
    return { do: "ping" };
}
/**
 * What a ping read and cost. Warm: it read the context and wrote little
 * (the fork's own tail is never cached). Priced from the band's figures: a
 * read at the per-message rate, a write at the session's re-write rate,
 * uncached input at that over the TTL's multiple (2x for 1 hour, 1.25x for
 * 5 minutes), output at 5x input (every current Claude model). An estimate.
 */
export function pingOutcome(u, d) {
    const t = d.tokens && d.tokens > 0 ? d.tokens : 1;
    const read = (d.perMessageUsd ?? 0) / t, write = (d.rewriteUsd ?? 0) / t;
    const input = write / ((d.ttlMs ?? 0) >= 60 * MIN ? 2 : 1.25);
    const n = (x) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);
    const usd = n(u.cache_read_input_tokens) * read + n(u.cache_creation_input_tokens) * write + n(u.input_tokens) * input + n(u.output_tokens) * input * 5;
    return { warm: n(u.cache_read_input_tokens) > 0 && n(u.cache_creation_input_tokens) < 0.1 * n(u.cache_read_input_tokens), usd };
}
/** The band while keeping warm: for how long more, what it has spent, against its limit. */
export function keepWarmText(kw, now) {
    return `context-doctor: keeping the cache warm for ${duration(Math.max(0, kw.until - now))} more: ${kw.pings} ping${kw.pings === 1 ? "" : "s"}, ~${money(kw.spentUsd)} of ${money(kw.capUsd)}`;
}
/** What the command says when it arms. */
export function keepWarmArmedText(kw, d) {
    const est = pingEstimateUsd(d);
    return [
        `Keeping this session's prompt cache warm for up to ${duration(kw.until - kw.armedAt)} or ${money(kw.capUsd)}, whichever comes first:`,
        `a cache read of the ~${tokens(d.tokens ?? 0)}-token context every ${everyText(d.ttlMs ?? 60 * MIN)} while you are away${est !== undefined ? ` (~${money(est)} each at list price)` : ""},`,
        "so your next message reads the context instead of writing it again. The pings bill to your plan or key (on a subscription they use your limit).",
        `It stops at either limit, at /clear, or with /${KEEP_WARM_COMMAND} off, and never starts again by itself.`,
    ].join(" ");
}
/** The command with no arguments: the price of a yes, or how the one in force stands. Arms nothing. */
export function keepWarmStatusText(kw, d, now) {
    if (kw && !kw.stopped)
        return `${keepWarmText(kw, now).replace(/^context-doctor: /, "")}. /${KEEP_WARM_COMMAND} off stops it.`;
    const last = kw?.stopped ? `Last time it stopped: ${kw.stopped} (${kw.pings} ping${kw.pings === 1 ? "" : "s"}, ~${money(kw.spentUsd)}). ` : "";
    const est = d ? pingEstimateUsd(d) : undefined;
    const each = d?.tokens !== undefined && est !== undefined ? `Here a ping reads ~${tokens(d.tokens)} tokens, ~${money(est)} at list price, every ${everyText(d.ttlMs ?? 60 * MIN)} while you are away. ` : "";
    return `${last}${each}To keep the cache warm while you step away: /${KEEP_WARM_COMMAND} 2h (at most ${KEEP_WARM_MAX_HOURS}h), with a dollar limit such as $5 (default ${money(KEEP_WARM_DEFAULT_CAP_USD)}). context-doctor cache-misses shows what it would have saved on your history.`;
}
/** The agent statuses that count as running: started and not settled. */
export const RUNNING = new Set(["pending", "running", "waiting"]);
/** "claude-opus-5-5" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5"; anything else as it is. */
export function shortModel(id) {
    if (!id)
        return "unknown model";
    const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/.exec(id);
    if (!m)
        return id;
    return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] !== undefined ? `.${m[3]}` : ""}${m[4] ? " (1M)" : ""}`;
}
/** A bar of `width` cells, filled to `pct`: "██████░░░░". */
export function bar(pct, width = 16) {
    const w = Math.max(4, Math.min(40, Math.round(width)));
    const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
    const full = Math.round((p / 100) * w);
    return "█".repeat(full) + "░".repeat(w - full);
}
/** "41%", "0.4%", "100%". */
export function pctText(pct) {
    if (!Number.isFinite(pct))
        return "?%";
    return pct > 0 && pct < 1 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}
/** The context ring, for the surfaces that draw `Svg`: a circle filled to `pct`, the percent in its middle. */
export function ringSvg(pct, size = 64) {
    const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
    const r = 26, c = 2 * Math.PI * r;
    const dash = ((p / 100) * c).toFixed(2);
    // Near the window's end Claude Code compacts soon: amber past 80%, red past 95%.
    const color = p >= 95 ? "#d64545" : p >= 80 ? "#d99a1e" : "#4a7bd0";
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">`
        + `<circle cx="32" cy="32" r="${r}" fill="none" stroke="#8884" stroke-width="7"/>`
        + `<circle cx="32" cy="32" r="${r}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${dash} ${c.toFixed(2)}" transform="rotate(-90 32 32)"/>`
        + `<text x="32" y="37" text-anchor="middle" font-family="system-ui, sans-serif" font-size="15" fill="currentColor">${pctText(p)}</text>`
        + `</svg>`;
}
/** The limit windows to show: the ledger's, each overlaid by Claude Code's own newer reading; a window only Claude Code has, from it alone. */
export function mergeLimits(ledger, live) {
    const out = ledger.map((w) => ({ ...w }));
    for (const r of live?.rateLimits ?? []) {
        if ((r.kind !== "five_hour" && r.kind !== "seven_day") || typeof r.percentUsed !== "number" || !Number.isFinite(r.percentUsed))
            continue;
        const reset = typeof r.resetsAt === "string" ? Date.parse(r.resetsAt) : NaN;
        const w = out.find((x) => x.window === r.kind);
        if (w) {
            if (live.at >= w.at) {
                w.pct = r.percentUsed;
                w.at = live.at;
                if (Number.isFinite(reset))
                    w.resetsAt = reset;
                w.resetSince = false;
            }
        }
        else {
            out.push({ window: r.kind, label: r.kind === "five_hour" ? "5-hour" : "Weekly", pct: r.percentUsed, at: live.at, resetSince: false, ...(Number.isFinite(reset) ? { resetsAt: reset } : {}) });
        }
    }
    return out.sort((a, b) => (a.window === "five_hour" ? 0 : 1) - (b.window === "five_hour" ? 0 : 1));
}
const per = (n) => (n >= 10 ? Math.round(n).toString() : n.toFixed(1));
/** Everything the usage pane says, as words; register.ts lays it out. */
export function usageView(v) {
    const { data, live, now } = v;
    // The context ring: Claude Code's own figure.
    const ctx = live?.context;
    const pct = ctx?.tokens !== undefined && ctx.window > 0 ? (ctx.percent ?? (ctx.tokens / ctx.window) * 100) : undefined;
    const context = pct !== undefined
        ? { pct, text: `${tokens(ctx.tokens)} of ${tokens(ctx.window)} tokens (${pctText(pct)})${live?.model ? ` · ${shortModel(live.model)}` : ""}` }
        : { text: "Measured after the session's first reply." };
    const limits = mergeLimits(data?.limits ?? [], live).map((w) => {
        if (w.resetSince)
            return { key: w.window, label: w.label, pct: 0, text: `reset since the last reading (${pctText(w.pct)} then)` };
        const parts = [];
        if (w.resetsAt !== undefined && w.resetsAt > now)
            parts.push(`resets in ${duration(w.resetsAt - now)}`);
        if (w.perHour !== undefined && w.perHour > 0) {
            const outIn = w.runsOutAt !== undefined && w.runsOutAt > now ? `, runs out in ${duration(w.runsOutAt - now)}${w.beforeReset ? " (before the reset)" : ""}` : "";
            parts.push(`+${per(w.perHour)} points an hour lately${outIn}`);
        }
        const sub = w.usdPerPct !== undefined ? `≈ ${money(w.usdPerPct)} of list price per 1%, fitted on your readings` : undefined;
        return { key: w.window, label: w.label, pct: w.pct, text: `${pctText(w.pct)}${parts.length ? ` · ${parts.join(" · ")}` : ""}`, ...(sub ? { sub } : {}) };
    });
    const limitsNote = limits.length
        ? limits.some((l) => l.key === "five_hour") ? undefined : "No 5-hour window on this plan (Ultra has none): the weekly limit only."
        : data || live ? "No limit readings yet: Claude Code reports the windows on a Pro, Max or Ultra sign-in, after the first reply." : undefined;
    const hist = data?.history;
    const periods = (hist?.periods ?? []).map((p) => ({ key: p.key, text: `${p.label} ${money(p.usd)} · ${tokens(p.tokens)} tokens` }));
    const chosen = hist?.periods.find((p) => p.key === (v.period ?? "today")) ?? hist?.periods[0];
    const period = chosen
        ? {
            key: chosen.key,
            label: chosen.label,
            rows: chosen.models.length
                ? chosen.models.map((m) => ({ model: /^\d+ other models?$/.test(m.model) ? m.model : shortModel(m.model), text: `${money(m.usd)} · ${tokens(m.tokens)} tokens · ${m.requests.toLocaleString("en-US")} request${m.requests === 1 ? "" : "s"}` }))
                : [{ model: "", text: "Nothing in Claude Code in this period." }],
        }
        : undefined;
    const historyNote = hist?.unpriced ? `${hist.unpriced} request${hist.unpriced === 1 ? "" : "s"} on a model with no list price, counted at $0.` : undefined;
    const running = v.agents?.filter((a) => !a.status || RUNNING.has(a.status));
    const byId = new Map((data?.agents ?? []).map((a) => [a.id, a]));
    const agents = (running ?? []).map((a) => {
        const u = byId.get(a.id);
        const bits = [];
        if (u?.model)
            bits.push(shortModel(u.model));
        if (u?.contextTokens !== undefined)
            bits.push(`context ${tokens(u.contextTokens)}${u.window ? ` of ${tokens(u.window)}` : ""}`);
        if (u?.usd !== undefined)
            bits.push(`${money(u.usd)} so far`);
        if (!u)
            bits.push("measuring…");
        else if (!bits.length)
            bits.push("no request yet");
        const what = (a.description ?? a.name ?? "").trim();
        return { key: a.id, head: `${a.type ?? "agent"}${what ? `: ${what.length > 60 ? what.slice(0, 59) + "…" : what}` : ""}${a.status && a.status !== "running" ? ` (${a.status})` : ""}`, text: bits.join(" · ") };
    });
    const agentsNote = v.agents === undefined ? "This Claude Code does not list subagents to mods." : agents.length ? undefined : "No subagents running.";
    const today = hist?.periods.find((p) => p.key === "today");
    const week = limits.find((l) => l.key === "seven_day");
    const glance = [pct !== undefined ? `context ${pctText(pct)}` : "", today ? `today ${money(today.usd)}` : "", week ? `weekly ${pctText(week.pct)}` : "", agents.length ? `${agents.length} subagent${agents.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") || "context-doctor usage";
    const footer = v.error
        ? v.error
        : v.loading && !hist
            ? "Measuring your last 30 days…"
            : hist
                ? `Dollars at list price, as context-doctor spend prices them; measured ${now - hist.at < MIN ? "just now" : `${duration(now - hist.at)} ago`}${v.loading ? ", measuring again…" : ""}.`
                : "";
    return { context, limits, ...(limitsNote ? { limitsNote } : {}), periods, ...(period ? { period } : {}), ...(historyNote ? { historyNote } : {}), agents, ...(agentsNote ? { agentsNote } : {}), glance, footer };
}
/** The pane as lines of text: the command's answer where no surface draws the pane (`claude -p`, a headless host). */
export function usageText(view) {
    const lines = [`context-doctor usage: ${view.glance}`, `Context: ${view.context.text}`];
    for (const l of view.limits)
        lines.push(`${l.label} limit: ${l.text}${l.sub ? ` (${l.sub})` : ""}`);
    if (view.limitsNote)
        lines.push(view.limitsNote);
    if (view.periods.length)
        lines.push(`Claude Code: ${view.periods.map((p) => p.text).join(" · ")}`);
    for (const r of view.period?.rows ?? [])
        lines.push(`  ${view.period.label}, ${r.model ? `${r.model}: ` : ""}${r.text}`);
    for (const a of view.agents)
        lines.push(`Subagent ${a.head}: ${a.text}`);
    if (view.agentsNote)
        lines.push(view.agentsNote);
    if (view.footer)
        lines.push(view.footer);
    return lines.join("\n");
}
/** How often the pane asks `mod usage` again: the history (cached by the CLI for as long) and the subagents while any runs. */
export const USAGE_HISTORY_EVERY_MS = 5 * MIN;
export const USAGE_AGENTS_EVERY_MS = 30_000;
/**
 * Whether the pane asks `mod usage` now, and for what. Never while closed or
 * while a run is in flight; the history at most every 5 minutes; the
 * subagents and the limits every 30 s while a subagent runs or after a turn
 * moved them. Nothing on a draw: drawing only reads.
 */
export function usageDue(s, now) {
    if (!s.open || s.loading)
        return false;
    if (s.lastAt === undefined || s.historyAt === undefined || now - s.historyAt >= USAGE_HISTORY_EVERY_MS)
        return { history: true };
    if (now - s.lastAt < USAGE_AGENTS_EVERY_MS)
        return false;
    if (s.agentsRunning > 0 || (s.measuredAt !== undefined && s.measuredAt > s.lastAt))
        return { history: false };
    return false;
}
/** The command the pane runs: the CLI's own. */
export function usageArgv(node, cli) {
    return [node, cli, "mod", "usage"];
}
/** Parse `mod usage`'s output; undefined when it is not one. */
export function parseUsage(stdout) {
    try {
        const j = JSON.parse(stdout);
        if (!j || typeof j !== "object" || typeof j.at !== "number" || !Array.isArray(j.limits) || !Array.isArray(j.agents))
            return undefined;
        return j;
    }
    catch {
        return undefined;
    }
}
