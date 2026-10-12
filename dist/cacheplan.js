/**
 * `context-doctor cache-plan <request.json>`: where an API app should put
 * Anthropic `cache_control` breakpoints, and what that saves.
 *
 * A request is cached as a prefix in a fixed order: tools, then system, then
 * messages. A breakpoint caches everything up to and including the block it
 * sits on, a prefix under the model's minimum (1,024 tokens; 2,048 on Haiku)
 * is not cached at all, a request may carry at most 4 breakpoints, and the
 * cache looks back at most 20 blocks from a breakpoint for an earlier hit.
 * The planner places breakpoints at the ends of the stable parts (last tool,
 * last system block) and on the last block of the conversation, adds a
 * middle anchor when the conversation is longer than the 20-block lookback,
 * prices the request sent N times with and without the plan, and with
 * --out saves the request with the breakpoints in place.
 *
 * Pricing assumes the same request is sent N times (an agent loop's steps, a
 * shared system prompt and document set); cache writes cost 1.25x input
 * (2x with ttl "1h"), reads 0.1x.
 */
import { estimateTokens, formatTokens } from "./tokens.js";
import { formatUsd, pricingFor } from "./pricing.js";
const LOOKBACK_BLOCKS = 20;
const MAX_BREAKPOINTS = 4;
function blocksOf(req, model) {
    const out = [];
    const mark = (obj) => (on) => {
        if (on)
            obj.cache_control = obj.cache_control ?? { type: "ephemeral" };
        else
            delete obj.cache_control;
    };
    const tok = (x) => estimateTokens(typeof x === "string" ? x : JSON.stringify(x ?? ""), model);
    (Array.isArray(req.tools) ? req.tools : []).forEach((t, i) => {
        out.push({ at: `tools[${i}]`, tokens: tok(t), section: "tools", hasBreakpoint: Boolean(t?.cache_control), set: mark(t) });
    });
    if (typeof req.system === "string" && req.system) {
        // A string system prompt cannot carry cache_control: it becomes one text block when planned.
        const holder = { type: "text", text: req.system };
        out.push({
            at: "system[0]",
            tokens: tok(req.system),
            section: "system",
            hasBreakpoint: false,
            set: (on) => {
                mark(holder)(on);
                req.system = on ? [holder] : req.system;
            },
        });
    }
    else if (Array.isArray(req.system)) {
        req.system.forEach((b, i) => out.push({ at: `system[${i}]`, tokens: tok(b?.text ?? b), section: "system", hasBreakpoint: Boolean(b?.cache_control), set: mark(b) }));
    }
    (Array.isArray(req.messages) ? req.messages : []).forEach((m, i) => {
        if (typeof m?.content === "string") {
            const holder = { type: "text", text: m.content };
            out.push({
                at: `messages[${i}].content[0]`,
                tokens: tok(m.content) + 4,
                section: "messages",
                hasBreakpoint: false,
                set: (on) => {
                    mark(holder)(on);
                    if (on)
                        m.content = [holder];
                },
            });
        }
        else if (Array.isArray(m?.content)) {
            m.content.forEach((b, j) => {
                const isImage = b?.type === "image";
                out.push({ at: `messages[${i}].content[${j}]`, tokens: isImage ? 1600 : tok(b?.text ?? b?.content ?? b) + (j === 0 ? 4 : 0), section: "messages", hasBreakpoint: Boolean(b?.cache_control), set: mark(b) });
            });
        }
    });
    return out;
}
export function planCache(request, calls = 10, modelOverride) {
    const req = (typeof request === "string" ? JSON.parse(request) : request);
    const model = modelOverride ?? (typeof req.model === "string" ? req.model : undefined);
    const notes = [];
    const isOpenAI = Array.isArray(req.input) || (Array.isArray(req.messages) && req.messages.some((m) => m?.role === "system" || m?.role === "developer" || m?.role === "tool"));
    if (isOpenAI || /gpt|^o\d/i.test(model ?? "")) {
        const text = JSON.stringify(req.tools ?? "") + JSON.stringify(req.messages ?? req.input ?? "");
        notes.push("OpenAI caches automatically: any request prefix over 1,024 tokens that matches an earlier one is billed at the cached rate, with no markers to place.", "What you control is order: keep tools, instructions and reference documents first and identical between calls, and put per-call content last.", "Set `prompt_cache_key` to a stable value per conversation or tenant so requests that share a prefix land on the same cache.");
        return {
            plan: { provider: "openai", model, totalTokens: estimateTokens(text, model), minCacheable: 1024, existing: [], plan: [], cachedTokens: 0, calls, notes },
            apply: () => req,
        };
    }
    const blocks = blocksOf(req, model);
    const total = blocks.reduce((s, b) => s + b.tokens, 0);
    const minCacheable = /haiku/i.test(model ?? "") ? 2048 : 1024;
    const prefixAt = (i) => blocks.slice(0, i + 1).reduce((s, b) => s + b.tokens, 0);
    const lastIndex = (section) => blocks.map((b) => b.section).lastIndexOf(section);
    const picks = [];
    const pick = (i, why) => {
        if (i < 0 || picks.some((p) => p.i === i) || prefixAt(i) < minCacheable)
            return;
        picks.push({ i, why });
    };
    const lastMsg = lastIndex("messages");
    pick(lastIndex("tools"), "end of the tool definitions: stable across every call");
    pick(lastIndex("system"), "end of the system prompt: stable across every call");
    // The conversation boundary moves forward each turn; a breakpoint on the last block caches the whole history for the next call.
    pick(lastMsg, "last block of the conversation: the next call reads everything before it from cache");
    // Beyond 20 blocks back from the moving breakpoint the cache stops looking; anchor the middle.
    const firstMsg = blocks.findIndex((b) => b.section === "messages");
    if (firstMsg >= 0 && lastMsg - firstMsg > LOOKBACK_BLOCKS && picks.length < MAX_BREAKPOINTS) {
        pick(lastMsg - LOOKBACK_BLOCKS, `anchor ${LOOKBACK_BLOCKS} blocks back: the cache only looks back ${LOOKBACK_BLOCKS} blocks from a breakpoint`);
    }
    picks.sort((a, b) => a.i - b.i);
    while (picks.length > MAX_BREAKPOINTS)
        picks.splice(1, 1);
    const existing = blocks.filter((b) => b.hasBreakpoint).map((b) => b.at);
    if (existing.length > MAX_BREAKPOINTS)
        notes.push(`The request carries ${existing.length} breakpoints; the API rejects more than ${MAX_BREAKPOINTS}.`);
    if (total < minCacheable)
        notes.push(`The whole request is ~${formatTokens(total)} tokens, under the ${formatTokens(minCacheable)} minimum ${model ?? "this model"} caches: caching cannot help until it grows.`);
    const cachedTokens = picks.length ? prefixAt(picks[picks.length - 1].i) : 0;
    const price = pricingFor(model);
    const longTtl = /"ttl"\s*:\s*"1h"/.test(JSON.stringify(req));
    const writeMult = longTtl ? 2 : 1.25;
    let usdWithout, usdWith;
    if (price) {
        const p = price.inputPerM / 1e6;
        usdWithout = calls * total * p;
        const rest = total - cachedTokens;
        usdWith = cachedTokens * writeMult * p + rest * p + (calls - 1) * (cachedTokens * 0.1 * p + rest * p);
    }
    return {
        plan: {
            provider: "anthropic",
            model,
            totalTokens: total,
            minCacheable,
            existing,
            plan: picks.map((p) => ({ at: blocks[p.i].at, prefixTokens: prefixAt(p.i), why: p.why })),
            cachedTokens,
            calls,
            usdWithout,
            usdWith,
            notes,
        },
        apply: () => {
            for (const b of blocks)
                b.set(false);
            for (const p of picks)
                blocks[p.i].set(true);
            return req;
        },
    };
}
export function renderCachePlan(p) {
    const out = ["CACHE PLAN", "═".repeat(56)];
    out.push(`${p.provider === "openai" ? "OpenAI" : "Anthropic"} request${p.model ? ` for ${p.model}` : ""}: ~${formatTokens(p.totalTokens)} tokens.`);
    if (p.provider === "openai") {
        out.push("", ...p.notes.map((n) => `• ${n}`));
        return out.join("\n");
    }
    out.push(`Breakpoints now: ${p.existing.length ? p.existing.join(", ") : "none"}.`, "");
    if (p.plan.length === 0) {
        out.push("Nothing to place: no stable prefix reaches the caching minimum.");
    }
    else {
        out.push(`Place cache_control on (${p.plan.length} of ${MAX_BREAKPOINTS} allowed):`);
        for (const b of p.plan)
            out.push(`  ${b.at.padEnd(26)} prefix ~${formatTokens(b.prefixTokens).padStart(6)}  ${b.why}`);
    }
    if (p.usdWithout !== undefined && p.usdWith !== undefined && p.plan.length) {
        const saved = p.usdWithout - p.usdWith;
        out.push("", `Sent ${p.calls} times: ${formatUsd(p.usdWithout)} of input without caching, ${formatUsd(p.usdWith)} with this plan (${saved >= 0 ? "saves" : "costs"} ${formatUsd(Math.abs(saved))}, ${Math.round((Math.abs(saved) / p.usdWithout) * 100)}%).`, `(~${formatTokens(p.cachedTokens)} tokens read at 0.1x after the first call, which writes them once at the cache-write rate.)`);
    }
    if (p.notes.length)
        out.push("", ...p.notes.map((n) => `! ${n}`));
    if (p.usdWithout === undefined && p.plan.length)
        out.push("", "Pass --model (e.g. claude-sonnet-5) to price it.");
    if (p.plan.length)
        out.push("", "--out <file> saves the request with exactly these breakpoints.");
    return out.join("\n");
}
