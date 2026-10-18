/**
 * `context-doctor compact-window`: compact earlier, automatically, in every
 * Claude Code surface, including the desktop app.
 *
 * Claude Code auto-compacts near the model's window. With a 1M-token window
 * that is ~970k (measured: 31 compactions on the author's machine, median
 * preTokens 970,119), so long sessions spend most of their life re-reading
 * 400k-900k tokens on every message. Claude Code has a native setting for
 * this, `autoCompactWindow` in ~/.claude/settings.json ("Auto-compact window
 * size"): it compacts as if the window were that size. It is a settings key,
 * not an environment variable, so the desktop app (which filters settings env
 * it sets itself) honours it, and no proxy or hook is involved.
 *
 * The trade-off is real: more compactions, each replacing history with a
 * summary. So this measures both sides on the user's own history and changes
 * nothing until asked. The replay uses the usage every transcript records;
 * its baseline came within 9% of the billed figure on the author's history.
 * Like `savings`, the replay decides each session's SHARE saved, and that
 * share is applied to what the session was billed (its recorded usage at
 * list price): "as now" is the same billed figure `savings` shows, over the
 * same sessions (10+ requests in the window), so the two never disagree.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { forEachLine, listSessions, replyCounter } from "./session.js";
import { cacheWriteSplit, pricingFor, usageCost, writeMultiplier } from "./pricing.js";
import { realModel } from "./tokens.js";
import { readJson, writeJsonWithBackup } from "./install.js";
import { withInvocation } from "./invocation.js";
import { idleCompactMinTokens, isIdleCompactNotice } from "./coldresume.js";
/** Claude Code compacts at about this share of the window (970k of 1M, measured). */
const TRIGGER_SHARE = 0.97;
/** Context right after a compaction: system prompt, tools and the summary (median 75,447, measured). */
const AFTER_COMPACT = 75_000;
/** Output tokens a compaction summary costs, at the model's output price. */
const SUMMARY_OUTPUT = 20_000;
const TTL_MS = 3_600_000;
export const MIN_WINDOW = 100_000;
export const MAX_WINDOW = 1_000_000;
/**
 * `writeMult`: what this session pays to write a token to the cache,
 * relative to input, from the 5-minute and 1-hour writes its usage records.
 * The replay charges writes that never happened (a cold re-read, a fresh
 * context after a simulated compaction); the harness would have written
 * those at the TTL it writes everything else at, mostly 1 hour (2x) for
 * Claude Code's main thread, not the 1.25x a constant assumed.
 */
function readRequests(path, runRows) {
    const reqs = [];
    let model, writes5m = 0, writes1h = 0, priced = false;
    const sighting = replyCounter(runRows);
    forEachLine(path, (line) => {
        let e;
        try {
            e = JSON.parse(line);
        }
        catch {
            return;
        }
        if (!e || e.isSidechain)
            return;
        if (e.type === "system" && e.subtype === "compact_boundary") {
            const copy = typeof e.uuid === "string" && !!runRows?.has(e.uuid);
            if (typeof e.uuid === "string")
                runRows?.add(e.uuid);
            reqs.push({ compact: true, copy });
            return;
        }
        // Claude Code's idle compaction marks its boundary with a notice row.
        if (isIdleCompactNotice(e)) {
            const last = reqs[reqs.length - 1];
            if (last && "compact" in last)
                last.idle = true;
            return;
        }
        if (e.type !== "assistant" || !e.message)
            return;
        const seen = sighting(e);
        if (seen === "repeat")
            return;
        const u = e.message.usage ?? {};
        const prompt = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        const at = Date.parse(e.timestamp);
        if (!(prompt > 0) || !Number.isFinite(at))
            return;
        // Each request at its own model's price; "<synthetic>" rows carry no usage.
        model = realModel(e.message.model) ?? model;
        const p = pricingFor(model);
        if (p)
            priced = true;
        const w = cacheWriteSplit(u);
        writes5m += w.fiveMinute;
        writes1h += w.oneHour;
        reqs.push({ at, prompt, inPerM: p?.inputPerM ?? 0, readPerM: p?.cacheReadPerM ?? 0, outPerM: p?.outputPerM ?? 0, copy: seen === "copy", billedUsd: p ? usageCost(u, p).promptUsd : 0 });
    });
    return { reqs, writeMult: writeMultiplier(writes5m, writes1h), priced };
}
/**
 * Replay one session twice: as it ran, and with compaction whenever the
 * context reaches the window's trigger. Both arms are priced as the prompt
 * cache bills, in USD at each request's own model (warm: the cache-read rate
 * on what was there + a write for what is new; cold after an hour idle: a
 * write for everything, writes at the session's own `writeMult`); each
 * simulated compaction also pays its own request and summary.
 *
 * `reread`: tokens a session fetches again after a compaction because the
 * summary dropped them (measured by `context-doctor compactions`). Each
 * simulated compaction writes them to the cache and carries them onward.
 */
function replay(reqs, window, since, reread = 0, writeMult = 1.25, idleMin = idleCompactMinTokens()) {
    let base = 0, sim = 0, extra = 0, actual = 0, idle = 0;
    let removed = 0, prevActual, prevSim, prevAt;
    for (const r of reqs) {
        if ("compact" in r) {
            if (prevAt !== undefined && prevAt >= since && !r.copy) {
                actual++;
                if (r.idle)
                    idle++;
            }
            // An idle compaction acts only on a context of idleMin or more: where
            // the smaller window had already left less, Claude Code would not have
            // compacted the simulated session here. It keeps its own context (now
            // larger than the real one, so `removed` turns negative), and its cache.
            if (r.idle && removed > 0 && prevSim !== undefined && prevSim < idleMin) {
                removed = AFTER_COMPACT - prevSim;
                prevActual = undefined;
                continue;
            }
            // A real compaction in the transcript: the simulated arm compacts there too.
            if (prevAt !== undefined && prevAt >= since && removed === 0 && !r.copy)
                extra++;
            removed = 0;
            prevActual = prevSim = undefined;
            continue;
        }
        // Requests before the window, or already counted from a forked copy,
        // still shape both arms; only the rest are billed.
        const counted = r.at >= since && !r.copy;
        const cold = prevAt === undefined || r.at - prevAt > TTL_MS;
        const write = writeMult * r.inPerM;
        const cost = (ctx, prev) => {
            if (cold)
                return write * ctx;
            const fresh = prev === undefined || ctx < prev ? ctx : ctx - prev;
            return r.readPerM * (ctx - fresh) + write * fresh;
        };
        if (counted)
            base += cost(r.prompt, prevActual);
        let ctx = r.prompt - removed;
        // The real context fell below what we had removed (a rewind with no
        // compaction marker): the two arms are back in step.
        if (ctx < AFTER_COMPACT && removed > 0) {
            removed = 0;
            ctx = r.prompt;
        }
        let simPrev = prevSim;
        if (ctx >= TRIGGER_SHARE * window) {
            if (counted) {
                sim += r.readPerM * ctx + r.outPerM * SUMMARY_OUTPUT + write * reread;
                extra++;
            }
            removed = r.prompt - AFTER_COMPACT - reread;
            ctx = AFTER_COMPACT + reread;
            simPrev = undefined; // everything after a compaction is new to the cache
        }
        if (counted)
            sim += cost(ctx, simPrev);
        prevActual = r.prompt;
        prevSim = ctx;
        prevAt = r.at;
    }
    return { base, sim, extra, actual, idle };
}
export function estimateCompactWindows(windows, days = 30, paths, rereadTokens = 0, onProgress) {
    const since = Date.now() - days * 86_400_000;
    const targets = paths ?? listSessions(10_000).filter((s) => s.path.includes(".claude") && s.modifiedAt.getTime() >= since).map((s) => s.path);
    const acc = windows.map((w) => ({ window: w, billed: 0, saved: 0, replayBase: 0, extra: 0 }));
    let sessions = 0, actualCompactions = 0, idleCompactions = 0;
    // Shared by every transcript of the run, so a fork's copy counts once.
    const runRows = new Set();
    for (const [i, p] of targets.entries()) {
        onProgress?.(i, targets.length);
        let parsed;
        try {
            parsed = readRequests(p, runRows);
        }
        catch {
            continue;
        }
        // The same sessions `savings` counts: 10+ requests of its own in the
        // period. An unpriced session counts too, at $0, as it does there.
        const counted = parsed.reqs.filter((r) => !("compact" in r) && r.at >= since && !r.copy);
        if (counted.length < 10)
            continue;
        sessions++;
        const billed = counted.reduce((n, r) => n + r.billedUsd, 0);
        const asNow = replay(parsed.reqs, Number.MAX_SAFE_INTEGER, since, 0, parsed.writeMult);
        actualCompactions += asNow.actual;
        idleCompactions += asNow.idle;
        for (const a of acc) {
            const r = replay(parsed.reqs, a.window, since, rereadTokens, parsed.writeMult);
            // The replay's share saved, applied to what this session was billed.
            const share = r.base > 0 ? (r.base - r.sim) / r.base : 0;
            a.billed += billed;
            a.saved += share * billed;
            a.replayBase += r.base / 1e6;
            a.extra += r.extra;
        }
    }
    onProgress?.(targets.length, targets.length);
    return {
        days,
        sessions,
        transcripts: targets.length,
        actualCompactions,
        idleCompactions,
        rereadTokens,
        estimates: acc.map((a) => ({
            window: a.window,
            baselineUsd: a.billed,
            replayBaselineUsd: a.replayBase,
            withWindowUsd: a.billed - a.saved,
            savedUsd: a.saved,
            savedPct: a.billed > 0 ? a.saved / a.billed : 0,
            compactions: a.extra,
        })),
    };
}
/** "37 sessions with 10+ requests (of 85 transcripts)": what the replayed reports count, said the same way. */
export function sessionsLabel(sessions, transcripts) {
    const s = `${sessions} session${sessions === 1 ? "" : "s"} with 10+ requests`;
    return transcripts > sessions ? `${s} (of ${transcripts} transcripts)` : s;
}
export function settingsPath(home = homedir()) {
    return join(home, ".claude", "settings.json");
}
/** The autoCompactWindow Claude Code will use from user settings, if set. */
export function currentCompactWindow(home = homedir()) {
    const p = settingsPath(home);
    if (!existsSync(p))
        return undefined;
    try {
        const v = JSON.parse(readFileSync(p, "utf8"))?.autoCompactWindow;
        return typeof v === "number" && Number.isFinite(v) ? v : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Set (or with undefined, remove) autoCompactWindow in ~/.claude/settings.json.
 * Nothing is written when nothing changes: `off` with no window set used to
 * create a settings.json of `{}`. A .backup is kept when there was a file.
 */
export function setCompactWindow(window, home = homedir()) {
    if (window !== undefined && (!Number.isInteger(window) || window < MIN_WINDOW || window > MAX_WINDOW)) {
        throw new Error(`window must be a whole number of tokens between ${MIN_WINDOW} and ${MAX_WINDOW}`);
    }
    const p = settingsPath(home);
    const existed = existsSync(p);
    const settings = readJson(p);
    if (window === undefined ? !("autoCompactWindow" in settings) : settings.autoCompactWindow === window) {
        return { changed: false, created: false };
    }
    if (window === undefined)
        delete settings.autoCompactWindow;
    else
        settings.autoCompactWindow = window;
    writeJsonWithBackup(p, settings);
    return { changed: true, created: !existed, backup: existed ? `${p}.context-doctor.backup` : undefined };
}
/** "400k" / "400000" / "0.4m" -> 400000. Undefined when unparseable. */
export function parseWindow(raw) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(raw);
    if (!m)
        return undefined;
    const n = Number(m[1]) * (m[2].toLowerCase() === "m" ? 1e6 : m[2].toLowerCase() === "k" ? 1e3 : 1);
    return Math.round(n);
}
const usd = (n) => (Math.abs(n) >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);
const k = (n) => `${Math.round(n / 1000)}k`;
export function renderCompactWindows(r, current) {
    const lines = [];
    lines.push("Auto-compact window: compact earlier, automatically (Claude Code's own setting)");
    // Counted and said exactly as `savings` says it, so the two screens agree.
    lines.push(`Last ${r.days} days, ${sessionsLabel(r.sessions, r.transcripts ?? r.sessions)}, at list prices`);
    lines.push("─".repeat(66));
    lines.push(`Now: ${current ? `${k(current)} (set in ~/.claude/settings.json)` : "not set: Claude Code compacts near the model's full window"}`);
    if (r.sessions === 0) {
        lines.push("No sessions with 10+ requests in the window to replay.");
        return withInvocation(lines.join("\n"));
    }
    lines.push("");
    lines.push("  window   input cost   saved            compactions");
    for (const e of r.estimates) {
        const mark = current === e.window ? "  ← current" : "";
        lines.push(`  ${k(e.window).padStart(6)}   ${usd(e.withWindowUsd).padStart(10)}   ${(usd(e.savedUsd) + ` (${Math.round(e.savedPct * 100)}%)`).padEnd(16)} ${String(e.compactions).padStart(4)} (${((e.compactions / r.days) * 7).toFixed(1)}/week)${mark}`);
    }
    lines.push(`  as now   ${usd(r.estimates[0]?.baselineUsd ?? 0).padStart(10)}                    ${String(r.actualCompactions).padStart(4)} (${((r.actualCompactions / r.days) * 7).toFixed(1)}/week${r.idleCompactions ? `; ${r.idleCompactions} while idle` : ""})`);
    lines.push("");
    lines.push("\"as now\" is what you were billed (transcript usage at list price, as in");
    lines.push("`context-doctor savings`); each window saves the replay's share of it.");
    if (r.rereadTokens) {
        lines.push(`Each simulated compaction also pays for ~${Math.round(r.rereadTokens / 100) / 10}k tokens of files read again afterwards`);
        lines.push("(measured on your compactions: context-doctor compactions).");
    }
    lines.push("Each compaction replaces the session's history with a summary, so a smaller");
    lines.push("window trades detail for cost. Set one with:  context-doctor compact-window 400k");
    lines.push("Undo with:  context-doctor compact-window off");
    return withInvocation(lines.join("\n"));
}
