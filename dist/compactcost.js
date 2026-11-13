/**
 * A compaction's own request, estimated: the one request of a session that no
 * transcript row carries usage for.
 *
 * Compacting sends the whole conversation once more with an instruction to
 * summarize it, and the answer is the summary the session restarts from.
 * Claude Code bills it and counts it in its own cost (the mods API says the
 * session's cost ledger holds it), but writes only a `compact_boundary` row
 * (`compactMetadata.preTokens`: the context it read) and the summary as a user
 * row (`isCompactSummary`): no usage (2.1.321). So `spend`, the budget and a
 * session's price left every compaction out, and the mod's comparison with
 * Claude Code's own cost showed the gap.
 *
 * Estimated from what the transcript does record, at the model of the reply
 * before it (rateCard, as every request: the organization's rates, the day's
 * price, its fast mode and US-only):
 *  - the context it read, `preTokens`: at the cache-read rate when the cache
 *    the last reply left was still alive (an automatic compaction mid-turn,
 *    Claude Code's idle compaction before expiry), else written again at the
 *    session's lifetime (a /compact after the cache went cold);
 *  - its output, the summary: the summary row's text, in tokens.
 * Not counted: the request's own instruction (a few hundred tokens) and any
 * thinking it did. The next request's re-write of the new context is in that
 * request's own usage, as before.
 */
import { requestCost } from "./pricing.js";
import { textOf } from "./session.js";
import { realModel, tokensForLength } from "./tokens.js";
const HOUR_MS = 3_600_000;
const FIVE_MIN_MS = 300_000;
/** The summary's output when no summary row follows the boundary: compactwindow.ts's measured figure. */
export const SUMMARY_TOKENS_UNSEEN = 20_000;
export const newTrack = () => ({ t: {} });
/** A ledger's kept state, when it is one this version wrote. */
export function isTrack(v) {
    return Boolean(v) && typeof v === "object" && Boolean(v.t) && typeof v.t === "object";
}
/** The rows a reader must hand on: replies with usage, compaction boundaries, summary rows. */
export function isCompactionRow(line) {
    return line.includes('"compact_boundary"') || line.includes('"isCompactSummary"');
}
const thread = (e) => (e?.isSidechain === true ? "1" : "0");
function priced(st, summaryTokens) {
    const p = st.p;
    st.p = undefined;
    if (!p)
        return undefined;
    const th = st.t[p.th];
    if (!th?.m || !(p.pre > 0))
        return undefined;
    const ttl = th.ttl ?? HOUR_MS;
    const warm = th.at !== undefined && p.at - th.at <= ttl;
    const usage = warm
        ? { input_tokens: 0, cache_read_input_tokens: p.pre, cache_creation_input_tokens: 0, output_tokens: summaryTokens, ...th.b }
        : { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: p.pre, cache_creation: ttl >= HOUR_MS ? { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: p.pre } : { ephemeral_5m_input_tokens: p.pre, ephemeral_1h_input_tokens: 0 }, output_tokens: summaryTokens, ...th.b };
    const cost = requestCost(th.m, usage, p.at);
    if (!cost)
        return undefined;
    return { ...(p.u ? { uuid: p.u } : {}), ...(p.s ? { sessionId: p.s } : {}), sidechain: p.th === "1", ts: p.at, model: th.m, usage, cost, warm };
}
/**
 * Feed one parsed row; a compaction's request when this row completes one
 * (its summary row, or a reply that came with no summary row between). A
 * boundary still waiting for its summary at the end of what was read is kept
 * in `st` and priced when the summary is read.
 */
export function trackCompaction(st, e) {
    if (!e || typeof e !== "object")
        return undefined;
    if (e.type === "system" && e.subtype === "compact_boundary") {
        // A boundary right after another (no summary between): the first is priced as unseen.
        const before = st.p ? priced(st, SUMMARY_TOKENS_UNSEEN) : undefined;
        const at = Date.parse(String(e.timestamp ?? ""));
        const pre = Number(e.compactMetadata?.preTokens);
        if (Number.isFinite(at) && Number.isFinite(pre) && pre > 0) {
            st.p = { at, pre, th: thread(e), ...(typeof e.uuid === "string" ? { u: e.uuid } : {}), ...(typeof e.sessionId === "string" ? { s: e.sessionId } : {}) };
        }
        return before;
    }
    if (e.type === "user" && e.isCompactSummary === true) {
        if (!st.p)
            return undefined;
        const length = typeof e.n === "number" ? e.n : textOf(e.message?.content).length;
        const model = st.t[st.p.th]?.m;
        return priced(st, Math.max(1, tokensForLength(length, false, model)));
    }
    if (e.type === "assistant" && e.message?.usage) {
        const done = st.p && st.p.th === thread(e) ? priced(st, SUMMARY_TOKENS_UNSEEN) : undefined;
        const model = realModel(e.message.model);
        if (!model)
            return done;
        const u = e.message.usage;
        const th = (st.t[thread(e)] ??= {});
        th.m = model;
        const at = Date.parse(String(e.timestamp ?? ""));
        if (Number.isFinite(at))
            th.at = at;
        const split = u.cache_creation;
        if (split && (split.ephemeral_1h_input_tokens ?? 0) > 0)
            th.ttl = HOUR_MS;
        else if (split && (split.ephemeral_5m_input_tokens ?? 0) > 0)
            th.ttl = FIVE_MIN_MS;
        const b = { ...(u.speed === "fast" ? { speed: "fast" } : {}), ...(u.inference_geo === "us" ? { inference_geo: "us" } : {}) };
        if (Object.keys(b).length)
            th.b = b;
        else
            delete th.b;
        return done;
    }
    return undefined;
}
/** A summary row as an extractor keeps it: its length, not its text. */
export function slimSummary(e) {
    return { type: "user", isCompactSummary: true, n: textOf(e?.message?.content).length, ...(e?.isSidechain === true ? { isSidechain: true } : {}) };
}
