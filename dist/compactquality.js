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
import { forEachLine, listSessions, queuedUserPrompt } from "./session.js";
import { readLedger } from "./ledger.js";
import { estimateTokens, formatTokens } from "./tokens.js";
const WINDOW = 15;
const CORRECTION = /^(no\b|nope\b|wrong\b|that'?s (not|wrong)|not what i|you forgot|i (said|told you|asked)|revert\b|undo\b|stop\b|again\??$|why did you)/i;
const empty = () => ({ requests: 0, rereads: 0, rereadTokens: 0, reads: 0, calls: 0, errors: 0, userMsgs: 0, corrections: 0 });
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
    const files = paths ?? listSessions(10_000).filter((s) => s.path.includes(".claude") && s.modifiedAt.getTime() >= since).map((s) => s.path);
    const shapedAt = readLedger().filter((e) => e.ev === "precompact").map((e) => e.ts);
    const q = { compactions: 0, extraRereadTokensPerCompaction: 0, sessions: 0, before: empty(), after: empty() };
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
        const userMessage = (text) => {
            const corr = CORRECTION.test(text.trim()) ? 1 : 0;
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
        let lastId;
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
            const at = Date.parse(e.timestamp);
            if (e.type === "system" && e.subtype === "compact_boundary") {
                const copy = typeof e.uuid === "string" && countedBoundaries.has(e.uuid);
                if (typeof e.uuid === "string")
                    countedBoundaries.add(e.uuid);
                if (!copy)
                    boundaries.push({ index: reqs.length, at });
                cur = undefined;
                return;
            }
            // Typed while the agent worked: a user message recorded only as an
            // attachment, and the likeliest moment for a "no, stop" to arrive.
            const queued = queuedUserPrompt(e);
            if (queued !== undefined) {
                userMessage(typeof queued === "string" ? queued : queued.map((b) => (typeof b?.text === "string" ? b.text : "")).join(" "));
                return;
            }
            const c = e.message?.content;
            if (e.type === "assistant") {
                if (e.message?.id !== lastId && e.message?.usage) {
                    lastId = e.message.id;
                    cur = { at, reads: [], readTokens: [], calls: 0, errors: 0, userMsgs: pendingUser, corrections: pendingCorrections };
                    pendingUser = pendingCorrections = 0;
                    reqs.push(cur);
                }
                if (cur && Array.isArray(c)) {
                    for (const b of c) {
                        if (b?.type !== "tool_use")
                            continue;
                        cur.calls++;
                        if (b.name === "Read" && typeof b.input?.file_path === "string")
                            readIds.set(b.id, b.input.file_path);
                    }
                }
            }
            else if (e.type === "user") {
                if (typeof c === "string" && !e.isMeta && !e.isCompactSummary) {
                    userMessage(c);
                }
                else if (cur && Array.isArray(c)) {
                    for (const b of c) {
                        if (b?.type !== "tool_result")
                            continue;
                        if (b.is_error)
                            cur.errors++;
                        const p = readIds.get(b.tool_use_id);
                        if (p && !b.is_error) {
                            cur.reads.push(p);
                            const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
                            cur.readTokens.push(estimateTokens(text, "claude-opus-5"));
                        }
                    }
                }
            }
        });
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
    out.push(`${q.compactions} compactions in ${q.sessions} sessions, last ${days} days; ${WINDOW} requests before vs after each.`, `Sample: ${q.before.reads} file reads before, ${q.after.reads} after; ${q.before.calls} and ${q.after.calls} tool calls; ${q.before.userMsgs} and ${q.after.userMsgs} of your messages.${thin ? " Few reads: the re-read figure is a weak signal." : ""}`, "", `  ${"".padEnd(36)} ${"before".padStart(7)}  ${"after".padStart(7)}   change`, row("files re-read (forgotten)", b.reread, a.reread), row("tool calls that errored", b.error, a.error), row("your messages correcting course", b.correction, a.correction));
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
    out.push(worse
        ? "Sessions also work worse after compacting (more tool errors or corrections): compact less often, and let the PreCompact hook tell each summary what to keep."
        : "No sign of worse work after compacting: tool errors and corrections are no higher. The cost of compacting here is tokens, not quality.");
    return out.join("\n");
}
