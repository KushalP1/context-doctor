/**
 * `context-doctor budget`: a spend budget the every-prompt hook enforces.
 *
 * `budget 50/day` (or `200/week`) is kept in ~/.claude/.context-doctor-budget.json.
 * Before each prompt the hook (Claude Code's UserPromptSubmit, Codex's
 * UserPromptSubmit, Gemini CLI's BeforeAgent) adds up what today (or this
 * week, from Monday) has cost across Claude Code, Codex and Gemini CLI, as
 * `spend` prices it, and says so to the user once per threshold: at 50%, 80%
 * and 100%. With `--block`, over the budget it holds the prompt in each
 * host's documented way (`decision: "block"` with a reason in Claude Code and
 * Codex, `decision: "deny"` in Gemini CLI), saying how to lift it. Cursor is
 * not counted: its history is a database too slow to read on every prompt,
 * and its prompt hook cannot add a line.
 *
 * The hook must stay fast, so the period's spend is a ledger
 * (~/.claude/.context-doctor-budget-state.json): per transcript, its size,
 * time and inode when last read, and the period's requests in it (a short
 * key and the dollars). A transcript met for the first time in a period is
 * read through the shared scan (scan.ts), as `spend` reads it; after that a
 * prompt reads only what was appended to the transcripts that changed, a
 * few kilobytes, without loading the scan's records for a whole transcript
 * (megabytes for a long one). The keys let a fork's copy of its parent's
 * replies count once. Measured on the author's history: docs/spend.md.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { codexDir } from "./codexdir.js";
import { fallbackStateDir, statePath } from "./ledger.js";
import { claudeCodePresent, claudeDir } from "./claudedir.js";
import { claudeFileUsage, claudeUsageFiles, codexSessionsRoot, rolloutFiles, USAGE_ROWS } from "./limits.js";
import { codexFileSpend, codexFiles, geminiFileSpend, geminiFiles, TOOL_NAME } from "./spend.js";
import { pricingFor, usageCost } from "./pricing.js";
import { anchorOf, rowsOf } from "./scan.js";
import { realModel } from "./tokens.js";
/** Beside the hook state and the ledger: ~/.claude/.context-doctor-budget.json. */
export function budgetPath() {
    return join(dirname(statePath()), ".context-doctor-budget.json");
}
/** The period's spend ledger and what was said: ~/.claude/.context-doctor-budget-state.json. */
export function budgetStatePath() {
    return join(dirname(statePath()), ".context-doctor-budget-state.json");
}
/**
 * "50/day", "$200/week", "7.5/d", "100/wk", "50/days": a budget, or an
 * error to show. Dollars are kept to the cent (50.555 was stored as given
 * and shown as $50.55); `note` says so when the amount was rounded.
 */
export function parseBudget(arg) {
    const m = /^\$?(\d*\.?\d+)\s*\/\s*(days?|d|daily|weeks?|w|wks?|weekly)$/i.exec(arg.trim());
    // Rounded in decimal ("50.555e2"), not in binary: 50.555 * 100 is 5055.4999...
    const usd = m ? Math.round(Number(`${m[1]}e2`)) / 100 : Number.NaN;
    // Under a cent it read "your $0.00/day budget".
    if (!m || !(usd >= 0.01) || usd > 1_000_000)
        return { error: `"${arg}" is not a budget: give dollars per day or per week, e.g. 50/day or 200/week.` };
    const period = /^d/i.test(m[2]) ? "day" : "week";
    return { usd, period, ...(usd !== Number(m[1]) ? { note: `${m[1]} rounded to the cent: $${usd.toFixed(2)} a ${period}.` } : {}) };
}
export function readBudget() {
    try {
        const b = JSON.parse(readFileSync(budgetPath(), "utf8"));
        if (typeof b?.usd === "number" && b.usd > 0 && (b.period === "day" || b.period === "week"))
            return { usd: b.usd, period: b.period, block: b.block === true, at: Number(b.at) || 0 };
    }
    catch {
        /* none set, or damaged: no budget */
    }
    return undefined;
}
/** A whole file renamed into place, so two prompts at once never read half of one. */
export function writeWhole(path, value) {
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
        renameSync(tmp, path);
    }
    catch (e) {
        try {
            unlinkSync(tmp);
        }
        catch { /* never written */ }
        throw e;
    }
}
export function writeBudget(b) {
    // Only the budget's own fields: a parse result's note is not part of it.
    writeWhole(budgetPath(), { usd: b.usd, period: b.period, block: b.block, at: b.at });
    // A new budget starts its thresholds afresh; the ledger stays (same period, same spend).
    const st = readState();
    if (st)
        writeWhole(budgetStatePath(), { ...st, warned: 0 });
}
/** Remove the budget and its ledger. True when there was one. */
export function clearBudget() {
    const had = existsSync(budgetPath());
    const dir = dirname(budgetPath());
    // A folder that held only our files, which we made (0.41.0 made ~/.claude for the budget on a
    // machine with only Codex), goes with them once empty; Claude Code's own folder never does.
    let ours = false;
    try {
        const entries = readdirSync(dir);
        ours = entries.length > 0 && entries.every((f) => f.startsWith(".context-doctor")) &&
            (dir === fallbackStateDir() || (dir === claudeDir() && !claudeCodePresent() && !process.env.CLAUDE_CONFIG_DIR?.trim()));
    }
    catch { /* no folder */ }
    rmSync(budgetPath(), { force: true });
    rmSync(budgetStatePath(), { force: true });
    if (ours)
        try {
            rmdirSync(dir);
        }
        catch { /* other files of ours are still in it */ }
    return had;
}
/** The start of the period holding `now`: local midnight, or Monday's for a week. */
export function periodStart(period, now = Date.now()) {
    const d = new Date(now);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (period === "week")
        start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    return start.getTime();
}
/** When the period holding `now` ends (the next one starts). */
export function periodEnd(period, now = Date.now()) {
    const s = new Date(periodStart(period, now));
    s.setDate(s.getDate() + (period === "week" ? 7 : 1));
    return s.getTime();
}
/** Replies remembered per transcript, to tell a later row of one from a new reply. */
const RECENT_REPLIES = 64;
function readState() {
    try {
        const s = JSON.parse(readFileSync(budgetStatePath(), "utf8"));
        if (typeof s?.start === "number" && s.files && typeof s.files === "object")
            return { start: s.start, files: s.files, warned: Number(s.warned) || 0, unpricedSaid: s.unpricedSaid === true, ...(s.cx && typeof s.cx.at === "number" && Array.isArray(s.cx.files) ? { cx: s.cx } : {}), usd: Number(s.usd) || 0, byTool: s.byTool ?? {} };
    }
    catch {
        /* none yet, or damaged: start afresh */
    }
    return undefined;
}
/**
 * Write the ledger. Another prompt or the status line may have written it
 * meanwhile: a threshold it already said stays said.
 */
function saveState(st) {
    const disk = readState();
    if (disk?.start === st.start) {
        st.warned = Math.max(st.warned, disk.warned);
        st.unpricedSaid = st.unpricedSaid || disk.unpricedSaid;
    }
    try {
        writeWhole(budgetStatePath(), st);
    }
    catch { /* a read-only folder: worked out again next time */ }
}
/** Claude Code's main transcripts written since `since`, without listing Codex's or Gemini's too. */
function claudeTops(since) {
    const root = join(claudeDir(), "projects");
    const out = [];
    let dirs;
    try {
        dirs = readdirSync(root);
    }
    catch {
        return out;
    }
    for (const d of dirs) {
        let names;
        try {
            names = readdirSync(join(root, d));
        }
        catch {
            continue;
        }
        for (const n of names) {
            if (!n.endsWith(".jsonl"))
                continue;
            try {
                if (statSync(join(root, d, n)).mtimeMs >= since)
                    out.push(join(root, d, n));
            }
            catch { /* vanished */ }
        }
    }
    return out;
}
/** How long the hook goes between full walks of Codex's folders. */
const CODEX_WALK_MS = 5 * 60_000;
/**
 * Codex's rollouts written in the period, without stat'ing every rollout on
 * every prompt (3,000 of them took 16 ms; the status line runs this too).
 * Codex files a rollout under the day it began (sessions/YYYY/MM/DD), so a
 * new one is in the period's own folders, walked every time. A resumed one
 * is appended where it is, in an older folder: those are found by a full
 * walk, done once every CODEX_WALK_MS (so a resumed session's spend can be
 * up to five minutes late) and at once when a known rollout is gone (moved
 * to archived_sessions). `st.cx` keeps the last full walk.
 */
function codexPeriodFiles(st, start, now, home) {
    const known = st.cx?.files ?? [];
    if (!st.cx || now - st.cx.at >= CODEX_WALK_MS || now < st.cx.at || known.some((f) => !existsSync(f))) {
        st.cx = { at: now, files: codexFiles(start, home) };
        return st.cx.files;
    }
    // The period's day folders, by local and by UTC date, a day either side.
    const root = codexSessionsRoot(home);
    const days = new Set();
    for (let t = start - 86_400_000; t <= now + 86_400_000; t += 3_600_000) {
        const d = new Date(t);
        for (const [y, m, dd] of [[d.getFullYear(), d.getMonth() + 1, d.getDate()], [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]])
            days.add(join(root, String(y), String(m).padStart(2, "0"), String(dd).padStart(2, "0")));
    }
    const out = new Set(known);
    for (const dir of days)
        for (const f of rolloutFiles(dir, start))
            out.add(f);
    return [...out];
}
/** 12 hex digits of a row's uuid: enough to tell a fork's copy, a third of the bytes. */
const keyOf = (uuid) => (uuid ? uuid.slice(0, 13) : "");
/** The offset just after the last newline before `size`: where a whole-line read resumes. */
function lineStart(fd, size) {
    const buf = Buffer.alloc(64 * 1024);
    for (let end = size; end > 0;) {
        const from = Math.max(0, end - buf.length);
        const n = readSync(fd, buf, 0, end - from, from);
        const nl = buf.subarray(0, n).lastIndexOf(10);
        if (nl >= 0)
            return from + nl + 1;
        end = from;
    }
    return 0;
}
/**
 * The requests of one transcript in the period, read in full (through the
 * shared scan, so only what it has not cached), as the ledger keeps them.
 */
function readFile(tool, file, since, size) {
    const k = [], d = [], x = [];
    if (tool !== "claude") {
        // A Codex request's key (a forked rollout repeats its parent's) kept short: 12 hex digits of its hash.
        for (const r of tool === "codex" ? codexFileSpend(file, since) : geminiFileSpend(file, since)) {
            if (!r.priced)
                x.push([k.length, r.model ?? "unknown"]);
            k.push(r.key ? createHash("sha1").update(r.key).digest("hex").slice(0, 12) : "");
            d.push(r.usd);
        }
        return { k, d, ...(x.length ? { x } : {}) };
    }
    const reqs = claudeFileUsage(file, since);
    const at = new Map();
    reqs.forEach((q, i) => {
        if (!pricingFor(q.model))
            x.push([i, q.model ?? "unknown"]);
        k.push(keyOf(q.uuid));
        d.push(q.usd);
        if (q.id)
            at.set(q.id, i);
    });
    // The last replies, those from before the period too: a reply streamed
    // across midnight has its first row in yesterday, and its later rows,
    // appended after this read, must still be known as its own (they were
    // counted again as a new request).
    const last = new Map();
    for (const row of rowsOf(file, USAGE_ROWS)) {
        const m = row?.message;
        if (row?.type !== "assistant" || typeof m?.id !== "string")
            continue;
        const out = Number(m.usage?.output_tokens) > 0 ? Number(m.usage.output_tokens) : 0;
        const known = last.get(m.id);
        if (known) {
            known[2] = Math.max(known[2], out);
            continue;
        }
        const i = at.get(m.id) ?? -1;
        last.set(m.id, [m.id, i, out, pricingFor(i >= 0 ? reqs[i].model : realModel(m.model))?.outputPerM ?? 0]);
        if (last.size > RECENT_REPLIES)
            last.delete(last.keys().next().value);
    }
    const r = [...last.values()];
    const fd = openSync(file, "r");
    try {
        const o = lineStart(fd, size);
        return { k, d, o, a: anchorOf(fd, o), r: r.slice(-RECENT_REPLIES), ...(x.length ? { x } : {}) };
    }
    finally {
        closeSync(fd);
    }
}
/**
 * A Claude Code transcript that grew: the whole lines after `e.o`, each
 * reply counted as claudeFileUsage counts it (once, its output settled on
 * its later rows, priced with usageCost), into `e`. False, `e` untouched,
 * when what came before `e.o` is not what was read (rewritten in place).
 */
function readAppended(e, file, since) {
    const fd = openSync(file, "r");
    try {
        const size = fstatSync(fd).size;
        const from = e.o ?? 0;
        if (e.a === undefined || size < from || anchorOf(fd, from) !== e.a)
            return false;
        const buf = Buffer.alloc(size - from);
        const n = readSync(fd, buf, 0, buf.length, from);
        const end = buf.subarray(0, n).lastIndexOf(10);
        if (end < 0)
            return true;
        const recent = e.r ?? [];
        for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
            if (!line.includes('"usage"'))
                continue;
            let row;
            try {
                row = JSON.parse(line);
            }
            catch {
                continue;
            }
            const m = row?.message;
            if (row?.type !== "assistant" || !m?.usage)
                continue;
            const u = m.usage;
            const out = Number(u.output_tokens) > 0 ? Number(u.output_tokens) : 0;
            const known = typeof m.id === "string" ? recent.find((x) => x[0] === m.id) : undefined;
            if (known) {
                // A later row of a reply already met: only output it settles on is new.
                if (out > known[2]) {
                    if (known[1] >= 0)
                        e.d[known[1]] += ((out - known[2]) * known[3]) / 1e6;
                    known[2] = out;
                }
                continue;
            }
            const ts = Date.parse(String(row.timestamp ?? ""));
            const tokens = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].reduce((t, v) => t + (Number(v) > 0 ? Number(v) : 0), 0);
            const price = pricingFor(realModel(m.model));
            let index = -1;
            if (Number.isFinite(ts) && ts >= since && tokens > 0) {
                index = e.k.length;
                if (!price)
                    (e.x ??= []).push([index, realModel(m.model) ?? "unknown"]);
                e.k.push(keyOf(typeof row.uuid === "string" ? row.uuid : undefined));
                e.d.push(price ? usageCost(u, price).totalUsd : 0);
            }
            if (typeof m.id === "string")
                recent.push([m.id, index, out, price?.outputPerM ?? 0]);
        }
        e.r = recent.slice(-RECENT_REPLIES);
        e.o = from + end + 1;
        e.a = anchorOf(fd, e.o);
        return true;
    }
    finally {
        closeSync(fd);
    }
}
/** A ledger entry this version can use: a damaged one threw on every prompt until its transcript changed. */
export function wellFormed(e) {
    return Boolean(e) && typeof e === "object" && Array.isArray(e.k) && Array.isArray(e.d) && e.k.length === e.d.length &&
        e.k.every((x) => typeof x === "string") && e.d.every((x) => typeof x === "number" && Number.isFinite(x)) &&
        (e.a === undefined || typeof e.a === "string") && (e.x === undefined || (Array.isArray(e.x) && e.x.every((y) => Array.isArray(y) && typeof y[0] === "number"))) && (e.r === undefined || (Array.isArray(e.r) && e.r.every((x) => Array.isArray(x) && x.length === 4)));
}
/** Above this, a transcript met for the first time goes through the shared scan even when `direct`: one buffer of all of it is too much. */
const DIRECT_MAX_BYTES = 16 * 1024 * 1024;
/**
 * One transcript's entry brought up to date: kept when the file is as last
 * read, read from where the last read stopped when a Claude Code transcript
 * only grew, read in full otherwise. `read`: the bytes read, -1 when the
 * entry was kept as it was. Undefined when the file cannot be read now.
 * `direct`: a Claude Code transcript met for the first time is read here,
 * not through the shared scan, which keeps a cache entry of it on disk (the
 * session price reads one session, and writes nothing while it has nothing
 * to say).
 */
export function refreshEntry(tool, file, prev, since, direct = false) {
    let s;
    try {
        s = statSync(file);
    }
    catch {
        return undefined;
    }
    // An entry not in the shape this version writes (edited, or another version's) is read again.
    const e = wellFormed(prev) ? prev : undefined;
    if (e && e.t === tool && e.s === s.size && e.m === s.mtimeMs && e.i === s.ino)
        return { e, read: -1 };
    try {
        // Claude Code appends: a transcript that only grew is read from where the last read stopped.
        if (e && tool === "claude" && e.o !== undefined && e.i === s.ino && s.size >= e.s) {
            const from = e.o;
            if (readAppended(e, file, since))
                return { e: { ...e, s: s.size, m: s.mtimeMs }, read: s.size - from };
        }
        if (direct && tool === "claude" && s.size <= DIRECT_MAX_BYTES) {
            // From the start, as an append to nothing: the same counting, without the scan.
            const fd = openSync(file, "r");
            let a;
            try {
                a = anchorOf(fd, 0);
            }
            finally {
                closeSync(fd);
            }
            const blank = { t: tool, s: 0, m: 0, i: s.ino, k: [], d: [], o: 0, a, r: [] };
            if (readAppended(blank, file, since))
                return { e: { ...blank, s: s.size, m: s.mtimeMs }, read: s.size };
        }
        return { e: { t: tool, s: s.size, m: s.mtimeMs, i: s.ino, ...readFile(tool, file, since, s.size) }, read: s.size };
    }
    catch {
        return undefined;
    }
}
/**
 * What the period holding `now` has cost so far, across Claude Code, Codex
 * and Gemini CLI. Re-reads only the transcripts that changed since the last
 * call (any process's), then writes the ledger back. `warn` (the hook's) is
 * the threshold reached, recorded as said, when it is one not said yet.
 */
export function periodSpend(period, now = Date.now(), home = homedir(), warnAt) {
    const start = periodStart(period, now);
    const prev = readState();
    const fresh = !prev || prev.start !== start;
    const st = fresh ? { start, files: {}, warned: 0, usd: 0, byTool: {} } : prev;
    const walked = st.cx?.at;
    const files = [
        ...claudeUsageFiles(start, claudeTops(start)).map((f) => ["claude", f.file]),
        ...codexPeriodFiles(st, start, now, home).map((f) => ["codex", f]),
        ...geminiFiles(start, home).map((f) => ["gemini", f]),
    ];
    let changed = fresh || st.cx?.at !== walked;
    const kept = {};
    for (const [tool, file] of files) {
        const r = refreshEntry(tool, file, st.files[file], start);
        if (!r)
            continue; // unreadable now: left out, read again next time
        kept[file] = r.e;
        if (r.read >= 0)
            changed = true;
    }
    if (Object.keys(st.files).some((f) => !(f in kept)))
        changed = true;
    // Each reply once: a fork's copy shares its key with the reply it copied.
    const seen = new Set();
    let usd = 0;
    const byTool = {};
    let unpriced = 0;
    const models = new Set();
    for (const file of Object.keys(kept).sort()) {
        const e = kept[file];
        const x = new Map(e.x ?? []);
        e.k.forEach((key, i) => {
            if (key) {
                if (seen.has(key))
                    return;
                seen.add(key);
            }
            usd += e.d[i];
            byTool[e.t] = (byTool[e.t] ?? 0) + e.d[i];
            if (x.has(i)) {
                unpriced++;
                models.add(x.get(i));
            }
        });
    }
    const level = warnAt ? warnAt(usd, st.warned) : 0;
    const warn = level > st.warned ? level : undefined;
    if (warn) {
        st.warned = warn;
        changed = true;
    }
    // The hook (warnAt) says once a period that part of it has no price.
    const unpricedNew = Boolean(warnAt) && unpriced > 0 && !st.unpricedSaid;
    if (unpricedNew) {
        st.unpricedSaid = true;
        changed = true;
    }
    if (changed)
        saveState({ ...st, files: kept, usd, byTool });
    return { start, end: periodEnd(period, now), usd, byTool, ...(unpriced ? { unpriced: { requests: unpriced, models: [...models] } } : {}), ...(warn ? { warn } : {}), ...(unpricedNew ? { unpricedNew } : {}) };
}
// ---------------------------------------------------------------------------
// What the hook, the status line and `budget` say
// ---------------------------------------------------------------------------
/** "$12.30", "$1,234": dollars as the budget lines show them. */
const money = (n) => (n >= 1000 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);
/** "$50", "$7.50": the budget itself. */
const amount = (n) => (Number.isInteger(n) ? `$${n.toLocaleString("en-US")}` : `$${n.toFixed(2)}`);
const per = (p) => (p === "day" ? "day" : "week");
const span = (p) => (p === "day" ? "today" : "this week");
/** The thresholds the hook speaks at. */
export const THRESHOLDS = [50, 80, 100];
/** The highest threshold `usd` has reached of `budget` (0 below the first). */
export function levelOf(usd, budget) {
    const pct = (usd / budget) * 100;
    return [...THRESHOLDS].reverse().find((t) => pct >= t) ?? 0;
}
function byToolText(byTool) {
    const parts = Object.keys(byTool).filter((t) => (byTool[t] ?? 0) >= 0.005).sort((a, b) => byTool[b] - byTool[a]).map((t) => `${TOOL_NAME[t]} ${money(byTool[t])}`);
    return parts.length > 1 ? ` (${parts.join(", ")})` : "";
}
/** "3 requests on gpt-7 have no list price, so the budget does not count them." */
function unpricedText(u) {
    const names = u.models.slice(0, 2).join(", ") + (u.models.length > 2 ? " and others" : "");
    return `${u.requests.toLocaleString("en-US")} request${u.requests === 1 ? " is" : "s are"} on ${names}, with no list price, so the budget does not count ${u.requests === 1 ? "it" : "them"}.`;
}
/** When the period resets, in words. */
function resets(p) {
    return p === "day" ? "It resets at midnight." : "It resets on Monday.";
}
/** A higher budget to suggest: half again, or a fifth over what was spent, rounded up to $5. */
function raised(b, spent) {
    return Math.ceil(Math.max(b.usd * 1.5, spent * 1.2) / 5) * 5;
}
/**
 * The hook's check: undefined with no budget set (one failed read: the hot
 * path stays a stat), otherwise the spend so far and what to say or do.
 */
export function budgetVerdict(now = Date.now(), home = homedir()) {
    const b = readBudget();
    if (!b)
        return undefined;
    const spend = periodSpend(b.period, now, home, (usd) => levelOf(usd, b.usd));
    const pct = Math.round((spend.usd / b.usd) * 100);
    const head = `context-doctor: ${money(spend.usd)} spent ${span(b.period)}`;
    if (b.block && spend.usd >= b.usd) {
        return {
            spend, budget: b,
            block: `${head}${byToolText(spend.byTool)}, over your ${amount(b.usd)}/${per(b.period)} budget, so this prompt was held. To go on, turn it off (context-doctor budget off) or raise it (context-doctor budget ${raised(b, spend.usd)}/${per(b.period)} --block). ${resets(b.period)}`,
        };
    }
    // Once a period: requests the budget cannot price, by name, so it is not read as all there is.
    const unpriced = spend.unpricedNew && spend.unpriced ? unpricedText(spend.unpriced) : undefined;
    if (!spend.warn)
        return unpriced ? { spend, budget: b, message: `context-doctor: ${unpriced}` } : { spend, budget: b };
    const message = spend.warn >= 100
        ? `${head}${byToolText(spend.byTool)}: over your ${amount(b.usd)}/${per(b.period)} budget (${pct}%). Raise it with context-doctor budget ${raised(b, spend.usd)}/${per(b.period)}, or add --block to hold prompts over it.`
        : `${head}${byToolText(spend.byTool)}: ${pct}% of your ${amount(b.usd)}/${per(b.period)} budget.`;
    return { spend, budget: b, message: unpriced ? `${message} ${unpriced}` : message };
}
/** The status line's part: "$12/$50 today", or undefined with no budget set. */
export function budgetStatus(now = Date.now(), home = homedir()) {
    const b = readBudget();
    if (!b)
        return undefined;
    const s = periodSpend(b.period, now, home);
    const short = (n) => (n >= 10 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);
    return `${short(s.usd)}/${amount(b.usd)} ${span(b.period)}${s.usd >= b.usd ? " ⚠" : ""}`;
}
/** `budget` with no argument, and after setting one: the budget and where the period stands. */
export function renderBudgetStatus(b, s, hookInstalled) {
    if (!b || !s)
        return "No spend budget set. Set one: context-doctor budget 50/day (or 200/week; --block to hold prompts over it).";
    const lines = [
        `Budget: ${amount(b.usd)} a ${per(b.period)}, across Claude Code, Codex and Gemini CLI${b.block ? "; prompts over it are held" : ""}.`,
        `${span(b.period) === "today" ? "Today" : "This week"}: ${money(s.usd)} so far, ${Math.round((s.usd / b.usd) * 100)}%${byToolText(s.byTool)}. ${resets(b.period)}`,
    ];
    if (s.unpriced)
        lines.push(`Not counted: ${unpricedText(s.unpriced)}`);
    lines.push(hookInstalled
        ? `The every-prompt hook says so at ${THRESHOLDS.join("%, ").replace(/, (\d+)$/, " and $1")}%${b.block ? ", and holds prompts over it" : ""}. Cursor is not counted (context-doctor spend shows it).`
        : "No every-prompt hook is installed, so nothing will say so: run context-doctor install.");
    lines.push(`Off: context-doctor budget off`);
    return lines.join("\n");
}
/** Our every-prompt hook in Claude Code, Codex or Gemini CLI, or the plugin's. */
export function promptHookInstalled(home = homedir()) {
    const has = (path, pick) => {
        try {
            return JSON.stringify(pick(JSON.parse(readFileSync(path, "utf8"))) ?? "").includes("context-doctor");
        }
        catch {
            return false;
        }
    };
    return has(join(claudeDir(), "settings.json"), (j) => [j?.hooks?.UserPromptSubmit, j?.enabledPlugins]) ||
        has(join(codexDir(home), "hooks.json"), (j) => j?.hooks?.UserPromptSubmit) ||
        has(join(home, ".gemini", "settings.json"), (j) => j?.hooks?.BeforeAgent);
}
