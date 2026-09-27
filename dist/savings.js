/**
 * `context-doctor savings`: what autopilot would have saved on YOUR recent
 * Claude Code sessions, measured, not modelled.
 *
 * Each session is replayed request by request, twice: as it was sent, and as
 * autopilot (autoclear.ts, the shipped class) would have sent it. Both arms
 * are priced the way the prompt cache bills (reads 0.1x, writes 1.25x, a
 * cold cache after an idle gap longer than the request's own TTL). The
 * difference between the arms is the saving. The baseline shown to the user
 * is not an estimate: it is the input the sessions were actually billed for,
 * read from the usage every transcript records.
 */
import { basename, dirname } from "node:path";
import { AutoClearer } from "./autoclear.js";
import { forEachLine, listSessions } from "./session.js";
import { pricingFor } from "./pricing.js";
import { estimateTokens, formatTokens } from "./tokens.js";
/** System prompt and tool schemas: sent on every request, identical in both arms. */
const FIXED_TOKENS = 54_000;
const CLAUDE_CODE_TTL_MS = 3_600_000;
/** One arm of the replay: the history as sent, priced incrementally. */
function arm(model, clearer) {
    const msgs = [];
    const tok = [];
    let total = 0, prevLen = 0, weighted = 0, raw = 0;
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
        request(now, cold) {
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
            weighted += (cold ? FIXED_TOKENS * 1.25 : FIXED_TOKENS * 0.1) + read * 0.1 + write * 1.25;
            raw += FIXED_TOKENS + total;
            prevLen = msgs.length;
        },
        get weighted() { return weighted; },
        get raw() { return raw; },
    };
}
/** Replay one Claude Code transcript. Undefined when it holds too few requests to mean anything. */
export function replaySession(path, options = {}) {
    let model;
    let base = arm(undefined, null), auto = arm(undefined, new AutoClearer(options));
    let baseW = 0, autoW = 0, baseRaw = 0, autoRaw = 0;
    let billed = 0, billedRaw = 0, requests = 0, lastId, lastTs = null;
    const flush = () => { baseW += base.weighted; autoW += auto.weighted; baseRaw += base.raw; autoRaw += auto.raw; };
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
            // Compaction replaces the history in both arms alike: start fresh.
            flush();
            base = arm(model, null);
            auto = arm(model, new AutoClearer(options));
            return;
        }
        if (e.type === "assistant" && e.message) {
            const m = e.message;
            model = model ?? m.model;
            const blocks = (Array.isArray(m.content) ? m.content : []).filter((b) => b?.type !== "thinking" && b?.type !== "redacted_thinking");
            if (m.id !== lastId) {
                lastId = m.id;
                const u = m.usage ?? {};
                const read = u.cache_read_input_tokens ?? 0, write = u.cache_creation_input_tokens ?? 0, fresh = u.input_tokens ?? 0;
                if (read + write + fresh > 0) {
                    billed += fresh + read * 0.1 + write * 1.25;
                    billedRaw += fresh + read + write;
                    requests++;
                    const now = Date.parse(e.timestamp) || 0;
                    const cold = lastTs === null || now - lastTs > CLAUDE_CODE_TTL_MS;
                    base.request(now, cold);
                    auto.request(now, cold);
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
    // shown are fractions of the user's real usage, not of an estimate.
    const perM = pricingFor(model)?.inputPerM ?? 0;
    const pct = baseW > 0 ? (baseW - autoW) / baseW : 0;
    const rawPct = baseRaw > 0 ? (baseRaw - autoRaw) / baseRaw : 0;
    const dir = basename(dirname(path));
    return {
        path,
        project: dir.replace(/^-Users-[^-]+-/, "").replace(/^-/, "") || dir,
        model,
        requests,
        billedWeighted: billed,
        billedUsd: (billed / 1e6) * perM,
        savedWeighted: pct * billed,
        savedUsd: ((pct * billed) / 1e6) * perM,
        savedTokens: rawPct * billedRaw,
        savedPct: pct,
    };
}
export function estimateSavings(days = 30, options = {}, paths, onProgress) {
    const since = Date.now() - days * 86_400_000;
    const targets = paths ?? listSessions(10_000).filter((s) => s.path.includes(".claude") && s.modifiedAt.getTime() >= since).map((s) => s.path);
    const sessions = [];
    for (const [i, p] of targets.entries()) {
        onProgress?.(i, targets.length);
        try {
            const s = replaySession(p, options);
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
    const savedPct = billedW > 0 ? sum("savedWeighted") / billedW : 0;
    return {
        days,
        sessions: sessions.sort((a, b) => b.savedUsd - a.savedUsd),
        billedUsd,
        savedUsd,
        savedTokens: sum("savedTokens"),
        billedTokens: sessions.reduce((n, s) => n + s.billedWeighted, 0),
        savedPct,
        worse: sessions.filter((s) => s.savedPct < -1e-9).length,
    };
}
const tokens = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : formatTokens(n));
const usd = (n) => (n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);
export function renderSavings(r, autopilotOn = false) {
    const lines = [];
    if (r.sessions.length === 0) {
        lines.push(`No Claude Code sessions with 10+ requests in the last ${r.days} days to replay.`);
        lines.push("Use Claude Code for a while, then run this again: `context-doctor savings`.");
        return lines.join("\n");
    }
    const title = autopilotOn ? "What autopilot saves on your sessions" : "What autopilot would have saved you";
    lines.push(`${title} (last ${r.days} days, ${r.sessions.length} Claude Code session${r.sessions.length === 1 ? "" : "s"})`);
    lines.push("─".repeat(56));
    lines.push(`Input you were billed for     ${usd(r.billedUsd).padStart(10)}   (from the usage your transcripts record)`);
    lines.push(`Autopilot would have cut      ${usd(r.savedUsd).padStart(10)}   ${(r.savedPct * 100).toFixed(1)}%, ${tokens(r.savedTokens)} tokens not sent`);
    lines.push(`Sessions made more expensive  ${String(r.worse).padStart(10)}`);
    const best = r.sessions[0];
    if (best && best.savedUsd > 0)
        lines.push(`Biggest win                   ${usd(best.savedUsd).padStart(10)}   ${best.project} (${(best.savedPct * 100).toFixed(0)}% of that session)`);
    lines.push("");
    lines.push("Replayed request by request through the shipped autopilot code and priced as");
    lines.push("the prompt cache bills. List prices; on a subscription the same tokens come");
    lines.push("out of your usage limit instead.");
    if (!autopilotOn) {
        lines.push("");
        lines.push("Turn it on for every new session:  context-doctor autopilot on");
    }
    return lines.join("\n");
}
