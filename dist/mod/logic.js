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
