/**
 * `context-doctor savings`: what autopilot would have saved on YOUR recent
 * Claude Code sessions, measured, not modelled.
 *
 * Each session is replayed request by request, twice: as it was sent, and as
 * autopilot (autoclear.ts, the shipped class) would have sent it. Both arms
 * are priced the way the prompt cache bills (reads at the model's cache-read
 * rate, writes at the session's own 5-minute/1-hour TTL mix, a cold cache
 * after an idle gap longer than the request's own TTL). The difference
 * between the arms is the saving. The baseline shown to the user is not an
 * estimate: it is the input the sessions were actually billed for, read from
 * the usage every transcript records, each request at its own model's price.
 */
import { basename, dirname } from "node:path";
import { AutoClearer } from "./autoclear.js";
import { coldResumeEvents } from "./coldresume.js";
import { forEachLine, listSessions, replyCounter } from "./session.js";
import { CACHE_WRITE_1H, CACHE_WRITE_5M, cacheWriteSplit, pricingFor, usageCost, writeMultiplier } from "./pricing.js";
import { estimateTokens, formatTokens, realModel } from "./tokens.js";
import { withInvocation } from "./invocation.js";
import { sessionsLabel } from "./compactwindow.js";
/** System prompt and tool schemas: sent on every request, identical in both arms. */
const FIXED_TOKENS = 54_000;
const CLAUDE_CODE_TTL_MS = 3_600_000;
/**
 * The desktop app runs Claude Code "host-orchestrated": it sets
 * ANTHROPIC_BASE_URL itself and drops the same key from settings files, so
 * the autopilot proxy cannot sit in front of it (checked in Claude Code
 * 2.1.284). Terminal and IDE sessions read settings normally.
 */
export function autopilotReaches(entrypoint) {
    return !(entrypoint ?? "").startsWith("claude-desktop");
}
/** Without a price on file the arms still need relative weights: Claude's usual 10% read rate. */
const UNPRICED = { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1 };
function arm(model, clearer) {
    const msgs = [];
    const tok = [];
    let total = 0, prevLen = 0, readUsd = 0, writeAtInput = 0, raw = 0;
    const size = (m) => estimateTokens(JSON.stringify(m), model);
    return {
        push(m) { msgs.push(structuredClone(m)); const k = size(m); tok.push(k); total += k; },
        extend(blocks) {
            const i = msgs.length - 1;
            msgs[i].content.push(...structuredClone(blocks));
            total -= tok[i];
            tok[i] = size(msgs[i]);
            total += tok[i];
        },
        request(now, cold, counted = true, price = UNPRICED) {
            let first = -1;
            if (clearer) {
                const body = { model, messages: msgs, system: [{ type: "text", text: "", cache_control: { type: "ephemeral", ttl: "1h" } }] };
                first = clearer.apply(body, now).firstChanged;
            }
            if (first >= 0)
                for (let i = first; i < msgs.length; i++) {
                    total -= tok[i];
                    tok[i] = size(msgs[i]);
                    total += tok[i];
                }
            const k = cold ? 0 : Math.min(prevLen, first >= 0 ? first : prevLen);
            let read = 0;
            for (let i = 0; i < k; i++)
                read += tok[i];
            const write = total - read;
            if (counted) {
                readUsd += ((cold ? 0 : FIXED_TOKENS) + read) * price.cacheReadPerM;
                writeAtInput += ((cold ? FIXED_TOKENS : 0) + write) * price.inputPerM;
                raw += FIXED_TOKENS + total;
            }
            prevLen = msgs.length;
        },
        usd(writeMult) { return (readUsd + writeAtInput * writeMult) / 1e6; },
        get raw() { return raw; },
    };
}
/**
 * Replay one Claude Code transcript. Undefined when it holds too few requests
 * to mean anything. `runRows` is shared by every transcript of one report: a
 * forked session starts as a copy of its parent's history, which replays
 * here (it shapes the context) but was billed once, under the parent.
 * `coldRows` does the same for the cold-resume count, which reads the
 * transcript again after the replay has added its rows to `runRows`.
 */
export function replaySession(path, options = {}, since = 0, runRows, coldRows, makeClearer = () => new AutoClearer(options)) {
    let model;
    let base = arm(undefined, null), auto = arm(undefined, makeClearer());
    let baseUsd = 0, autoUsd = 0, baseRaw = 0, autoRaw = 0;
    let entrypoint;
    let billed = 0, billedUsd = 0, billedRaw = 0, requests = 0, lastId, lastTs = null;
    let writes5m = 0, writes1h = 0;
    const sighting = replyCounter(runRows);
    // Arms are closed out at each compaction and at the end, priced at the
    // session's write mix (known by the end, so the closed arms wait for it).
    const closed = [];
    const flush = () => { closed.push(base, auto); baseRaw += base.raw; autoRaw += auto.raw; };
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
        if (!entrypoint && typeof e.entrypoint === "string")
            entrypoint = e.entrypoint;
        if (e.type === "system" && e.subtype === "compact_boundary") {
            // Compaction replaces the history in both arms alike: start fresh.
            flush();
            base = arm(model, null);
            auto = arm(model, makeClearer(model));
            return;
        }
        if (e.type === "assistant" && e.message) {
            const m = e.message;
            // "<synthetic>" placeholders are not a model: a session that opened
            // with one was priced at nothing.
            model = model ?? realModel(m.model);
            const blocks = (Array.isArray(m.content) ? m.content : []).filter((b) => b?.type !== "thinking" && b?.type !== "redacted_thinking");
            if (m.id !== lastId) {
                lastId = m.id;
                const u = m.usage ?? {};
                const read = u.cache_read_input_tokens ?? 0, write = u.cache_creation_input_tokens ?? 0, fresh = u.input_tokens ?? 0;
                const seen = sighting(e);
                if (seen !== "repeat" && read + write + fresh > 0) {
                    const now = Date.parse(e.timestamp) || 0;
                    // History before the window, or already billed under the session
                    // it was forked from, still shapes the replay's state; only the
                    // rest is billed and counted.
                    const inWindow = now >= since && seen === "new";
                    // Each request at its own model: a session that switched from a
                    // $4 to a $10 model was priced at the first one throughout.
                    const price = pricingFor(realModel(m.model) ?? model);
                    const ttl = cacheWriteSplit(u);
                    writes5m += ttl.fiveMinute;
                    writes1h += ttl.oneHour;
                    if (inWindow) {
                        billed += fresh + read * 0.1 + ttl.fiveMinute * CACHE_WRITE_5M + ttl.oneHour * CACHE_WRITE_1H;
                        billedUsd += price ? usageCost(u, price).promptUsd : 0;
                        billedRaw += fresh + read + write;
                        requests++;
                    }
                    const cold = lastTs === null || now - lastTs > CLAUDE_CODE_TTL_MS;
                    base.request(now, cold, inWindow, price);
                    auto.request(now, cold, inWindow, price);
                    lastTs = now;
                }
                base.push({ role: "assistant", content: blocks });
                auto.push({ role: "assistant", content: blocks });
            }
            else {
                base.extend(blocks);
                auto.extend(blocks);
            }
        }
        else if (e.type === "user" && e.message) {
            const c = e.message.content;
            const msg = { role: "user", content: Array.isArray(c) ? c : [{ type: "text", text: String(c ?? "") }] };
            base.push(msg);
            auto.push(msg);
        }
    });
    flush();
    if (requests < 10 || billed <= 0)
        return undefined;
    // The replay decides the SHARE saved (both arms priced the same way); that
    // share is applied to what was actually billed, so the dollars and tokens
    // shown are fractions of the user's real usage, not of an estimate. The
    // arms write at this session's own TTL mix: the replay charges writes that
    // never happened (a cold re-read after clearing), and Claude Code would
    // have written those at the TTL it wrote everything else at.
    const mix = writeMultiplier(writes5m, writes1h);
    for (let i = 0; i < closed.length; i += 2) {
        baseUsd += closed[i].usd(mix);
        autoUsd += closed[i + 1].usd(mix);
    }
    const cold = coldResumeEvents(path, undefined, undefined, coldRows).filter((c) => c.at >= since);
    const pct = baseUsd > 0 ? (baseUsd - autoUsd) / baseUsd : 0;
    const rawPct = baseRaw > 0 ? (baseRaw - autoRaw) / baseRaw : 0;
    const dir = basename(dirname(path));
    return {
        path,
        project: dir.replace(/^-Users-[^-]+-/, "").replace(/^-/, "") || dir,
        model,
        requests,
        billedWeighted: billed,
        billedUsd,
        savedWeighted: pct * billed,
        savedUsd: pct * billedUsd,
        savedTokens: rawPct * billedRaw,
        savedPct: pct,
        entrypoint,
        autopilotReachable: autopilotReaches(entrypoint),
        coldResumes: cold.length,
        coldResumeNetUsd: cold.reduce((n, c) => n + c.netUsd, 0),
    };
}
export function estimateSavings(days = 30, options = {}, paths, onProgress) {
    const since = Date.now() - days * 86_400_000;
    const targets = paths ?? listSessions(10_000).filter((s) => s.path.includes(".claude") && s.modifiedAt.getTime() >= since).map((s) => s.path);
    const sessions = [];
    const runRows = new Set(), coldRows = new Set();
    for (const [i, p] of targets.entries()) {
        onProgress?.(i, targets.length);
        try {
            const s = replaySession(p, options, since, runRows, coldRows);
            if (s)
                sessions.push(s);
        }
        catch {
            /* one unreadable transcript must not sink the report */
        }
    }
    const sum = (k) => sessions.reduce((n, s) => n + s[k], 0);
    const billedUsd = sum("billedUsd"), savedUsd = sum("savedUsd");
    const billedW = sum("billedWeighted");
    // The share printed beside a dollar figure is a share of dollars. With each
    // request priced at its own model, token-weighted and dollar shares differ
    // (author's 133 days: 11.4% of weighted tokens, 12.7% of dollars); tokens
    // only when nothing could be priced.
    const savedPct = billedUsd > 0 ? savedUsd / billedUsd : billedW > 0 ? sum("savedWeighted") / billedW : 0;
    onProgress?.(targets.length, targets.length);
    return {
        days,
        sessions: sessions.sort((a, b) => b.savedUsd - a.savedUsd),
        transcripts: targets.length,
        billedUsd,
        savedUsd,
        savedTokens: sum("savedTokens"),
        billedTokens: sessions.reduce((n, s) => n + s.billedWeighted, 0),
        savedPct,
        worse: sessions.filter((s) => s.savedPct < -1e-9).length,
        reachableUsd: sessions.filter((s) => s.autopilotReachable).reduce((n, s) => n + s.savedUsd, 0),
        unreachableSessions: sessions.filter((s) => !s.autopilotReachable).length,
        coldResumes: sum("coldResumes"),
        coldResumeNetUsd: sum("coldResumeNetUsd"),
    };
}
const tokens = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : formatTokens(n));
const usd = (n) => (n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);
export function renderSavings(r, autopilotOn = false, cw, missLines, limitLines) {
    const lines = [];
    if (r.sessions.length === 0) {
        lines.push(`No Claude Code sessions with 10+ requests in the last ${r.days} days to replay.`);
        lines.push("Use Claude Code for a while, then run this again: `context-doctor savings`.");
        return withInvocation(lines.join("\n"));
    }
    const n = r.sessions.length;
    const allDesktop = r.unreachableSessions === n;
    const pct = (x) => (r.billedUsd > 0 ? ` (${Math.round((x / r.billedUsd) * 100)}%)` : "");
    // Kept within 80 columns: this is most people's first screen of the tool.
    lines.push("What context-doctor finds in your Claude Code sessions");
    // The same count, said the same way, as compact-window's.
    lines.push(`Last ${r.days} days, ${sessionsLabel(n, r.transcripts ?? n)}, at list prices`);
    lines.push("─".repeat(60));
    lines.push(`Input you were billed for         ${usd(r.billedUsd).padStart(9)}   from your transcripts' usage`);
    lines.push("");
    lines.push(`1. Compact when you come back     ${usd(Math.max(0, r.coldResumeNetUsd)).padStart(9)}${pct(Math.max(0, r.coldResumeNetUsd))}`);
    lines.push(`   ${r.coldResumes} return${r.coldResumes === 1 ? "" : "s"} to a session over 150k tokens after the prompt cache`);
    lines.push("   expired. Running /compact then, net of the compaction itself, would");
    lines.push("   have saved this. The every-prompt hook points these moments out, in");
    lines.push("   every Claude Code surface, the desktop app included.");
    lines.push("");
    if (allDesktop) {
        lines.push(`2. Autopilot                      ${"n/a".padStart(9)}`);
        lines.push(`   All ${n} sessions ran in the desktop app, which sets its own API`);
        lines.push("   address, so the autopilot proxy cannot sit in front of them. In a");
        lines.push(`   terminal or an IDE they would have saved ${usd(r.savedUsd)} (${(r.savedPct * 100).toFixed(1)}%).`);
    }
    else {
        lines.push(`2. Autopilot                      ${usd(r.reachableUsd).padStart(9)}${pct(r.reachableUsd)}`);
        lines.push("   Stale tool output cleared only when the cache is cold, so it never");
        lines.push(`   costs more (${r.worse} session${r.worse === 1 ? "" : "s"} made more expensive); ${tokens(r.savedTokens)} tokens not sent.`);
        if (r.unreachableSessions > 0)
            lines.push(`   Terminal and IDE sessions only; ${r.unreachableSessions} desktop-app session${r.unreachableSessions === 1 ? "" : "s"} not reachable.`);
        if (!autopilotOn)
            lines.push("   Turn it on:  context-doctor autopilot on");
    }
    if (cw) {
        lines.push("");
        lines.push(`${`3. Compact earlier (${Math.round(cw.window / 1000)}k window)`.padEnd(34)}${usd(Math.max(0, cw.savedUsd)).padStart(9)}${pct(Math.max(0, cw.savedUsd))}`);
        lines.push(`   Claude Code's own auto-compact window${cw.isCurrent ? ", as you have it set" : ""}: automatic in every surface,`);
        lines.push(`   ${cw.compactionsPerWeek.toFixed(1)} compactions a week instead of ${cw.nowPerWeek.toFixed(1)}. Each keeps a summary, not the`);
        lines.push("   full history. Compare sizes: context-doctor compact-window");
        if (!cw.isCurrent)
            lines.push(`   Set it with: context-doctor compact-window ${Math.round(cw.window / 1000)}k`);
    }
    if (limitLines?.length) {
        // Only when a fit on the user's own limit readings is good enough (limits.ts).
        lines.push("");
        lines.push(...limitLines);
    }
    if (missLines?.length) {
        // Not a lever of ours: money the cache lost on its own, said once, with where to look.
        lines.push("");
        lines.push(...missLines);
    }
    lines.push("");
    lines.push("Replayed request by request through the shipped code and priced as the");
    lines.push("prompt cache bills. On a subscription the same tokens come out of your");
    lines.push("usage limit instead. Share yours: context-doctor savings --share");
    // Hints as the user can type them: `npx context-doctor …` after an npx run.
    return withInvocation(lines.join("\n"));
}
/**
 * `savings --share`: a few lines people can paste or screenshot. Totals only:
 * no project names, paths or session ids, so sharing it leaks nothing.
 */
export function renderShare(r) {
    if (r.sessions.length === 0)
        return "context-doctor found no Claude Code sessions to measure yet.";
    const lines = [
        `My Claude Code input, last ${r.days} days: ${usd(r.billedUsd)} at list price (${r.sessions.length} sessions).`,
    ];
    if (r.coldResumeNetUsd > 0) {
        lines.push(`Running /compact when I came back to a big session after the cache expired would have saved ${usd(r.coldResumeNetUsd)} (${Math.round((r.coldResumeNetUsd / r.billedUsd) * 100)}%, ${r.coldResumes} times).`);
    }
    if (r.reachableUsd > 0) {
        lines.push(`Clearing stale tool output only when the cache is cold would have cut another ${usd(r.reachableUsd)}, with no session made more expensive.`);
    }
    lines.push("Measured from my own transcripts with context-doctor: npx context-doctor savings");
    return lines.join("\n");
}
