/**
 * `context-doctor subagents`: which subagent tasks pay for themselves.
 *
 * The work costs money either way; the question is where it is cheaper. Done
 * in a subagent it costs the subagent's bill. Done in the parent, the same
 * steps would have run (at the parent's model price) with the parent's whole
 * context re-read on every step, and what they read would have stayed in the
 * parent for its later requests. Per subagent, all measured:
 *
 *   in a subagent = its bill
 *   in the parent = (bill - its own startup context) x parent/subagent price
 *                 + parent context at launch x steps x parent cache-read price
 *                 + (read - returned) x (W + 0.1 x later parent requests) x parent input price
 *
 * W is the parent's own cache-write price (1.25x input at the 5-minute TTL,
 * 2x at 1 hour, weighted by what the parent's usage records it wrote).
 *
 * "Read" is the tool output the subagent pulled in; "returned" is what the
 * parent received (tool result, or a background agent's task notification);
 * "later requests" run to the next compaction. Measured from transcripts and
 * subagents/<agent>.meta.json; nothing is sent anywhere.
 *
 * It ignores what a subagent buys besides context (parallel time, a clean
 * window for a hard task) and what the parent would have spent on its own tool
 * calls, so "did not pay" means "did not pay in context", not "was a mistake".
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { forEachLine, listSessions, outputSettler, replyCounter } from "./session.js";
import { estimateTokens, formatTokens, realModel } from "./tokens.js";
import { cacheWriteSplit, formatUsd, pricingFor, usageCost, writeMultiplier } from "./pricing.js";
const CLAUDE = "claude-opus-5";
const IMAGE_TOKENS = 1600;
function blockTokens(content) {
    if (typeof content === "string")
        return estimateTokens(content, CLAUDE);
    if (!Array.isArray(content))
        return estimateTokens(JSON.stringify(content ?? ""), CLAUDE);
    let n = 0;
    for (const p of content) {
        if (p?.type === "image")
            n += IMAGE_TOKENS;
        else if (typeof p?.text === "string")
            n += estimateTokens(p.text, CLAUDE);
        else
            n += estimateTokens(JSON.stringify(p ?? ""), CLAUDE);
    }
    return n;
}
/** A subagent's bill (usage priced as the cache bills it), steps, startup context, start time and the tool output it read. */
export function scanSubagent(path) {
    let costUsd = 0, readTokens = 0, task = "", model;
    let steps = 0, startup = 0, start = Infinity, writes5m = 0, writes1h = 0;
    const sighting = replyCounter();
    const settle = outputSettler();
    forEachLine(path, (line) => {
        let e;
        try {
            e = JSON.parse(line);
        }
        catch {
            return;
        }
        const content = e?.message?.content;
        if (e?.type === "user") {
            if (!task && typeof content === "string")
                task = content;
            if (Array.isArray(content))
                for (const b of content)
                    if (b?.type === "tool_result")
                        readTokens += blockTokens(b.content);
            return;
        }
        if (e?.type !== "assistant" || !e.message?.usage)
            return;
        if (typeof e.message.model === "string" && !realModel(e.message.model))
            return; // "<synthetic>": not a request
        const seen = sighting(e);
        if (seen === "repeat") {
            // A later row of the same reply: only its final output count is new.
            const more = settle(e, false);
            const price = more ? pricingFor(realModel(e.message.model) ?? model) : undefined;
            if (price)
                costUsd += (more * price.outputPerM) / 1e6;
            return;
        }
        if (seen !== "new")
            return;
        settle(e, true);
        model = realModel(e.message.model) ?? model;
        const u = e.message.usage;
        const n = (k) => (typeof u[k] === "number" && u[k] > 0 ? u[k] : 0);
        const at = Date.parse(e.timestamp);
        if (Number.isFinite(at))
            start = Math.min(start, at);
        if (steps === 0)
            startup = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
        steps++;
        const w = cacheWriteSplit(u);
        writes5m += w.fiveMinute;
        writes1h += w.oneHour;
        const price = pricingFor(model);
        if (!price)
            return;
        costUsd += usageCost(u, price).totalUsd;
    });
    return { costUsd, readTokens, task: task.replace(/\s+/g, " ").slice(0, 90), steps, startup, start, model, writeMult: writeMultiplier(writes5m, writes1h) };
}
function scanParent(path, ids) {
    const view = { requests: [], prompts: [], compactions: [], writes5m: 0, writes1h: 0, returns: new Map() };
    let lastId;
    forEachLine(path, (line) => {
        const hits = [...ids].filter((id) => line.includes(id));
        const isUsage = line.includes('"usage"');
        const isCompact = line.includes('"compact_boundary"');
        if (!hits.length && !isUsage && !isCompact)
            return;
        let e;
        try {
            e = JSON.parse(line);
        }
        catch {
            return;
        }
        const at = Date.parse(e?.timestamp);
        if (isCompact && e?.subtype === "compact_boundary" && Number.isFinite(at))
            view.compactions.push(at);
        // Placeholder messages Claude Code writes itself ("<synthetic>") are not API requests.
        if (e?.type === "assistant" && !e.isSidechain && e.message?.usage && e.message.id !== lastId && realModel(e.message.model)) {
            lastId = e.message.id;
            if (Number.isFinite(at)) {
                const u = e.message.usage;
                view.requests.push(at);
                view.prompts.push((u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0));
            }
            const w = cacheWriteSplit(e.message.usage);
            view.writes5m += w.fiveMinute;
            view.writes1h += w.oneHour;
            view.model = realModel(e.message.model) ?? view.model;
            return;
        }
        if (!hits.length || !Number.isFinite(at) || e?.type === "assistant")
            return;
        // Background agents report through a task notification; foreground ones through the tool result.
        const content = e?.message?.content ?? e?.content;
        const tokens = blockTokens(Array.isArray(content) ? content.map((b) => (b?.type === "tool_result" ? { text: typeof b.content === "string" ? b.content : JSON.stringify(b.content) } : b)) : content);
        for (const id of hits) {
            const prev = view.returns.get(id);
            if (!prev || tokens > prev.tokens)
                view.returns.set(id, { tokens, at });
        }
    });
    return view;
}
export function subagentPayback(days = 30, paths, onProgress) {
    const since = Date.now() - days * 86_400_000;
    const sessions = paths ?? listSessions(10_000).filter((s) => s.path.includes(".claude") && s.modifiedAt.getTime() >= since).map((s) => s.path);
    const out = [];
    let withSubagents = 0;
    for (const [index, parent] of sessions.entries()) {
        onProgress?.(index, sessions.length);
        const dir = join(parent.replace(/\.jsonl$/, ""), "subagents");
        if (!existsSync(dir))
            continue;
        const agents = readdirSync(dir).filter((f) => /^agent-.+\.jsonl$/.test(f));
        if (!agents.length)
            continue;
        const before = out.length;
        const metas = agents.map((f) => {
            const id = basename(f, ".jsonl").replace(/^agent-/, "");
            let meta = {};
            try {
                meta = JSON.parse(readFileSync(join(dir, `agent-${id}.meta.json`), "utf8"));
            }
            catch { /* older Claude Code: no meta */ }
            return { id, file: join(dir, f), meta };
        });
        const ids = new Set(metas.flatMap((m) => [m.id, m.meta.toolUseId].filter((x) => Boolean(x))));
        const view = scanParent(parent, ids);
        const price = pricingFor(view.model);
        // What the parent pays to write a token to its cache, from its own usage.
        const parentWrite = writeMultiplier(view.writes5m, view.writes1h);
        for (const m of metas) {
            const s = scanSubagent(m.file);
            // Each subagent by its own start: a long session touched today brought
            // all its subagents into `--days 1` (70 where 9 started that day).
            // A subagent with no dated request counts with its session.
            if (Number.isFinite(s.start) && s.start < since)
                continue;
            const ret = [m.id, m.meta.toolUseId].map((k) => (k ? view.returns.get(k) : undefined)).filter(Boolean).sort((a, b) => b.tokens - a.tokens)[0];
            const returnedTokens = ret?.tokens ?? 0;
            const from = ret?.at ?? Infinity;
            const until = Math.min(...view.compactions.filter((c) => c > from), Infinity);
            const laterRequests = view.requests.filter((t) => t > from && t < until).length;
            const carried = Math.max(0, s.readTokens - returnedTokens);
            // The parent's context when the subagent started: its last request before then.
            let parentContextTokens = 0;
            for (let i = 0; i < view.requests.length && view.requests[i] <= s.start; i++)
                parentContextTokens = view.prompts[i];
            const sub = pricingFor(s.model) ?? price;
            let inParentUsd = s.costUsd, avoidedUsd = 0;
            if (price && sub) {
                // Each side's cache writes at its own TTL mix (subagents write at 5
                // minutes, the main thread mostly at 1 hour) and reads at its model's rate.
                const startupUsd = (s.startup * (s.writeMult * sub.inputPerM + Math.max(0, s.steps - 1) * sub.cacheReadPerM)) / 1e6;
                const work = Math.max(0, s.costUsd - startupUsd) * (price.inputPerM / sub.inputPerM);
                const rideAlong = (parentContextTokens * s.steps * price.cacheReadPerM) / 1e6;
                avoidedUsd = (carried * (parentWrite * price.inputPerM + laterRequests * price.cacheReadPerM)) / 1e6;
                inParentUsd = work + rideAlong + avoidedUsd;
            }
            out.push({
                id: m.id,
                type: m.meta.agentType ?? "unknown",
                task: m.meta.description ?? s.task,
                costUsd: s.costUsd,
                inParentUsd,
                steps: s.steps,
                parentContextTokens,
                readTokens: s.readTokens,
                returnedTokens,
                laterRequests,
                avoidedUsd,
                netUsd: inParentUsd - s.costUsd,
            });
        }
        if (out.length > before)
            withSubagents++;
    }
    return { days, sessions: withSubagents, subagents: out };
}
export function renderPayback(r, top = 8) {
    const out = ["DO SUBAGENTS PAY FOR THEMSELVES?", "═".repeat(56)];
    const all = r.subagents;
    if (!all.length)
        return [...out, `No subagents in the last ${r.days} days.`].join("\n");
    const cost = all.reduce((s, a) => s + a.costUsd, 0);
    const inParent = all.reduce((s, a) => s + a.inParentUsd, 0);
    const paid = all.filter((a) => a.netUsd > 0);
    out.push(`Last ${r.days} days: ${all.length} subagents in ${r.sessions} sessions cost ${formatUsd(cost)} at list price.`, `The same work done in the parent would have cost ~${formatUsd(inParent)}: ${paid.length} of ${all.length} were cheaper as subagents, net ${inParent - cost >= 0 ? "+" : "−"}${formatUsd(Math.abs(inParent - cost))}.`, "");
    const byType = new Map();
    for (const a of all) {
        const t = byType.get(a.type) ?? { n: 0, cost: 0, net: 0, paid: 0 };
        t.n++;
        t.cost += a.costUsd;
        t.net += a.netUsd;
        if (a.netUsd > 0)
            t.paid++;
        byType.set(a.type, t);
    }
    out.push("  by type                     count      cost    paid off   net");
    for (const [type, t] of [...byType.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
        out.push(`  ${type.slice(0, 26).padEnd(26)} ${String(t.n).padStart(6)} ${formatUsd(t.cost).padStart(9)} ${`${t.paid}/${t.n}`.padStart(10)}   ${t.net >= 0 ? "+" : "−"}${formatUsd(Math.abs(t.net))}`);
    }
    const worst = [...all].sort((a, b) => a.netUsd - b.netUsd).slice(0, top).filter((a) => a.netUsd < 0);
    if (worst.length) {
        out.push("", "Would have been cheaper in the parent:");
        for (const a of worst)
            out.push(`  −${formatUsd(-a.netUsd).padEnd(8)} ${String(a.steps).padStart(3)} steps, parent at ~${formatTokens(a.parentContextTokens)}, read ~${formatTokens(a.readTokens)}  ${a.task}`);
    }
    out.push("", "Counts context only: a subagent can still be worth it for parallel time or a clean window on a hard task.", "Subagents pay most when the parent is already large (every step there re-reads it) and least for short tasks from a small parent.");
    return out.join("\n");
}
