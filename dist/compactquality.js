/**
 * `context-doctor compactions`: does a session work worse right after it
 * compacts? Measured on the user's own history, so the decision to compact
 * earlier (compact-window) rests on evidence about quality, not only cost.
 *
 * For every compaction in recent Claude Code transcripts, the requests just
 * before it are compared with the same number just after, on three signals a
 * transcript records:
 *  - re-reads: Read of a file the session had already read before the
 *    compaction (the summary lost it, so the model goes back for it);
 *  - tool errors: tool results marked as errors, per tool call;
 *  - corrections: user messages that push back ("no", "wrong", "revert",
 *    "you forgot", "I said"), per user message.
 * A compaction that costs quality shows up as all three rising after it.
 * Compactions shaped by context-doctor's PreCompact hook are reported apart,
 * so its effect can be seen as it accumulates.
 */
import { listSessions, queuedUserPrompt, isClaudeSession } from "./session.js";
import { rowsOf } from "./scan.js";
import { readLedger } from "./ledger.js";
import { estimateTokens, formatTokens } from "./tokens.js";
import { isIdleCompactNotice } from "./coldresume.js";
const WINDOW = 15;
const CORRECTION = /^(no\b|nope\b|wrong\b|that'?s (not|wrong)|not what i|you forgot|i (said|told you|asked)|revert\b|undo\b|stop\b|again\??$|why did you)/i;
const empty = () => ({ requests: 0, rereads: 0, rereadTokens: 0, reads: 0, calls: 0, errors: 0, userMsgs: 0, corrections: 0 });
export const QUALITY_ROWS = {
    id: "quality.1",
    init: () => ({ reads: {} }),
    line(_raw, row, out, st) {
        let e;
        try {
            e = row();
        }
        catch {
            return;
        }
        if (!e || e.isSidechain)
            return;
        if (e.type === "system" && e.subtype === "compact_boundary") {
            out.push({ k: "b", ...(typeof e.uuid === "string" ? { uuid: e.uuid } : {}), ...(e.timestamp !== undefined ? { ts: e.timestamp } : {}) });
            return;
        }
        if (isIdleCompactNotice(e)) {
            out.push({ k: "i" });
            return;
        }
        // Typed while the agent worked: a user message recorded only as an
        // attachment, and the likeliest moment for a "no, stop" to arrive.
        const queued = queuedUserPrompt(e);
        if (queued !== undefined) {
            const text = typeof queued === "string" ? queued : queued.map((b) => (typeof b?.text === "string" ? b.text : "")).join(" ");
            out.push({ k: "u", corr: CORRECTION.test(text.trim()) ? 1 : 0 });
            return;
        }
        const c = e.message?.content;
        if (e.type === "assistant") {
            // A request starts at a reply with usage whose id differs from the last request's.
            const n = e.message?.id !== st.lastId && e.message?.usage;
            if (n)
                st.lastId = e.message.id;
            let calls = 0;
            const reads = [];
            if (Array.isArray(c)) {
                for (const b of c) {
                    if (b?.type !== "tool_use")
                        continue;
                    calls++;
                    if (b.name === "Read" && typeof b.input?.file_path === "string") {
                        reads.push([b.id, b.input.file_path]);
                        st.reads[String(b.id)] = 1;
                    }
                }
            }
            if (n)
                out.push({ k: "a", n: 1, ...(e.timestamp !== undefined ? { ts: e.timestamp } : {}), calls, reads });
            else if (calls)
                out.push({ k: "a", calls, reads });
        }
        else if (e.type === "user") {
            if (typeof c === "string" && !e.isMeta && !e.isCompactSummary) {
                out.push({ k: "u", corr: CORRECTION.test(c.trim()) ? 1 : 0 });
            }
            else if (Array.isArray(c)) {
                let err = 0;
                const r = [];
                for (const b of c) {
                    if (b?.type !== "tool_result")
                        continue;
                    if (b.is_error) {
                        err++;
                        continue;
                    }
                    // Only a Read's result is ever counted: the rest are not sized.
                    if (!st.reads[String(b.tool_use_id)])
                        continue;
                    const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
                    r.push([b.tool_use_id, estimateTokens(text, "claude-opus-5")]);
                }
                if (err || r.length)
                    out.push({ k: "t", err, r });
            }
        }
    },
};
function add(s, reqs, readBefore) {
    for (const r of reqs) {
        s.requests++;
        s.calls += r.calls;
        s.errors += r.errors;
        s.userMsgs += r.userMsgs;
        s.corrections += r.corrections;
        r.reads.forEach((p, i) => {
            s.reads++;
            if (readBefore.has(p)) {
                s.rereads++;
                s.rereadTokens += r.readTokens[i] ?? 0;
            }
        });
    }
}
export function compactionQuality(days = 60, paths, onProgress) {
    const since = Date.now() - days * 86_400_000;
    const files = paths ?? listSessions(10_000).filter((s) => isClaudeSession(s) && s.modifiedAt.getTime() >= since).map((s) => s.path);
    const shapedAt = readLedger().filter((e) => e.ev === "precompact").map((e) => e.ts);
    const q = { compactions: 0, idle: 0, extraRereadTokensPerCompaction: 0, sessions: 0, before: empty(), after: empty() };
    const shaped = { compactions: 0, before: empty(), after: empty() };
    // A forked session copies its parent's compactions (same row uuid): one compaction, counted once.
    const countedBoundaries = new Set();
    for (const [fileIndex, path] of files.entries()) {
        onProgress?.(fileIndex, files.length);
        const reqs = [];
        /** `at` is NaN when the row carries no timestamp. */
        const boundaries = [];
        let cur;
        // User messages between a compaction and the next request belong to the "after" side.
        let pendingUser = 0, pendingCorrections = 0;
        const userMessage = (corr) => {
            if (cur) {
                cur.userMsgs++;
                cur.corrections += corr;
            }
            else {
                pendingUser++;
                pendingCorrections += corr;
            }
        };
        const readIds = new Map();
        for (const r of rowsOf(path, QUALITY_ROWS)) {
            if (r.k === "b") {
                const copy = r.uuid !== undefined && countedBoundaries.has(r.uuid);
                if (r.uuid !== undefined)
                    countedBoundaries.add(r.uuid);
                if (!copy)
                    boundaries.push({ index: reqs.length, at: Date.parse(r.ts) });
                cur = undefined;
            }
            else if (r.k === "i") {
                // Claude Code's idle compaction writes this right after its boundary.
                const last = boundaries[boundaries.length - 1];
                if (last && last.index === reqs.length)
                    last.idle = true;
            }
            else if (r.k === "u") {
                userMessage(r.corr);
            }
            else if (r.k === "a") {
                if (r.n) {
                    cur = { at: Date.parse(r.ts), reads: [], readTokens: [], calls: 0, errors: 0, userMsgs: pendingUser, corrections: pendingCorrections };
                    pendingUser = pendingCorrections = 0;
                    reqs.push(cur);
                }
                if (cur) {
                    cur.calls += r.calls;
                    for (const [id, file] of r.reads)
                        readIds.set(id, file);
                }
            }
            else if (cur) {
                cur.errors += r.err;
                for (const [id, tokens] of r.r) {
                    const p = readIds.get(id);
                    if (p) {
                        cur.reads.push(p);
                        cur.readTokens.push(tokens);
                    }
                }
            }
        }
        let counted = false;
        for (const b of boundaries) {
            // Each compaction by its own time: a session touched in the window
            // brought in all its older compactions. Undated ones count with the file.
            if (b.at < since)
                continue;
            const before = reqs.slice(Math.max(0, b.index - WINDOW), b.index);
            const after = reqs.slice(b.index, b.index + WINDOW);
            if (before.length < 5 || after.length < 5)
                continue;
            // Files read before the compaction: re-reading them afterwards means the summary lost them.
            const readBefore = new Set(reqs.slice(0, b.index).flatMap((r) => r.reads));
            // Before the compaction, a "re-read" is a read of a file already read earlier in that stretch.
            const earlier = new Set(reqs.slice(0, Math.max(0, b.index - WINDOW)).flatMap((r) => r.reads));
            add(q.before, before, earlier);
            add(q.after, after, readBefore);
            q.compactions++;
            if (b.idle)
                q.idle++;
            counted = true;
            if (shapedAt.some((t) => Math.abs(t - b.at) < 10 * 60_000)) {
                shaped.compactions++;
                add(shaped.before, before, earlier);
                add(shaped.after, after, readBefore);
            }
        }
        if (counted)
            q.sessions++;
    }
    if (shaped.compactions)
        q.shaped = shaped;
    // Only the rise counts against compacting: some re-reading happens anyway.
    const baseline = q.before.reads ? q.before.rereadTokens / Math.max(1, q.before.rereads) * (q.before.rereads / q.before.reads) * q.after.reads : 0;
    q.extraRereadTokensPerCompaction = q.compactions ? Math.max(0, q.after.rereadTokens - baseline) / q.compactions : 0;
    return q;
}
function rates(s) {
    return {
        reread: s.reads ? s.rereads / s.reads : 0,
        error: s.calls ? s.errors / s.calls : 0,
        correction: s.userMsgs ? s.corrections / s.userMsgs : 0,
    };
}
export function renderCompactionQuality(q, days = 60) {
    const out = ["DO SESSIONS WORK WORSE AFTER COMPACTING?", "═".repeat(56)];
    if (!q.compactions)
        return [...out, `No compactions with enough work on both sides in the last ${days} days.`].join("\n");
    const b = rates(q.before), a = rates(q.after);
    const pct = (x) => `${(x * 100).toFixed(1)}%`;
    const row = (label, x, y) => `  ${label.padEnd(36)} ${pct(x).padStart(7)}  ${pct(y).padStart(7)}   ${y - x > 0.0005 ? "+" : y - x < -0.0005 ? "−" : " "}${pct(Math.abs(y - x))}`;
    const thin = q.before.reads + q.after.reads < 50;
    out.push(`${q.compactions} compactions in ${q.sessions} sessions, last ${days} days; ${WINDOW} requests before vs after each.${q.idle ? ` ${q.idle} of them were Claude Code's idle compactions (a quiet session compacted before its cache expired).` : ""}`, `Sample: ${q.before.reads} file reads before, ${q.after.reads} after; ${q.before.calls} and ${q.after.calls} tool calls; ${q.before.userMsgs} and ${q.after.userMsgs} of your messages.${thin ? " Few reads: the re-read figure is a weak signal." : ""}`, "", `  ${"".padEnd(36)} ${"before".padStart(7)}  ${"after".padStart(7)}   change`, row("files re-read (forgotten)", b.reread, a.reread), row("tool calls that errored", b.error, a.error), row("your messages correcting course", b.correction, a.correction));
    if (q.shaped) {
        const sb = rates(q.shaped.before), sa = rates(q.shaped.after);
        out.push("", `Shaped by context-doctor's PreCompact hook (${q.shaped.compactions}): re-reads ${pct(sb.reread)} → ${pct(sa.reread)}, errors ${pct(sb.error)} → ${pct(sa.error)}, corrections ${pct(sb.correction)} → ${pct(sa.correction)}.`);
    }
    const forgets = a.reread - b.reread > 0.05;
    const worse = a.error - b.error > 0.03 || a.correction - b.correction > 0.05;
    out.push("");
    if (forgets) {
        // Rounded: an average below 1k otherwise printed as "~237.46428571428572".
        out.push(`Compacting forgets files: each compaction is followed by ~${formatTokens(Math.round(q.extraRereadTokensPerCompaction))} tokens of extra re-reads. compact-window charges that to every compaction it simulates.`);
    }
    // "No higher" only when neither went up: 0% before and 4.8% after is under
    // the margin for "worse", and it is still higher, so it is said as such.
    const higher = [
        a.error - b.error > 0.0005 ? `tool errors ${pct(b.error)} → ${pct(a.error)}` : "",
        a.correction - b.correction > 0.0005 ? `corrections ${pct(b.correction)} → ${pct(a.correction)}` : "",
    ].filter(Boolean);
    out.push(worse
        ? "Sessions also work worse after compacting (more tool errors or corrections): compact less often, and let the PreCompact hook tell each summary what to keep."
        : higher.length === 0
            ? "No sign of worse work after compacting: tool errors and corrections are no higher. The cost of compacting here is tokens, not quality."
            : `Little sign of worse work after compacting: ${higher.join(" and ")}, up by less than the margin counted as worse here (3 points for errors, 5 for corrections). The cost of compacting here is mostly tokens.`);
    return out.join("\n");
}
