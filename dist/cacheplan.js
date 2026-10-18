/**
 * `context-doctor cache-plan <request.json>`: where an API app should put
 * Anthropic `cache_control` breakpoints, and what that saves.
 *
 * A request is cached as a prefix in a fixed order: tools, then system, then
 * messages. A breakpoint caches everything up to and including the block it
 * sits on, a prefix under the model's minimum (512 to 4,096 tokens, see
 * minCacheableTokens) is not cached at all, a request may carry at most 4
 * breakpoints, and the cache looks back at most 20 positions from a
 * breakpoint for an earlier hit (a run of tool_use blocks, or of
 * tool_result blocks, is one position).
 *
 * Automatic caching (prompt-caching docs, Oct 2026): one top-level
 * `cache_control` puts a breakpoint on the last cacheable block and moves it
 * forward as the conversation grows, so the app never re-places it. It takes
 * one of the 4 slots; with 4 explicit breakpoints as well, or an explicit one
 * on the last block at a different TTL, the API answers 400. Every platform
 * has it except Bedrock's legacy integration (Opus 4.6 and earlier), which
 * rejects the field.
 *
 * The planner places breakpoints at the ends of the stable parts (last tool,
 * last system block) and at the end of the conversation, there by automatic
 * caching unless the platform lacks it or --explicit asks for a block-level
 * one; adds a middle anchor when the conversation is longer than the
 * 20-position lookback; prices the request sent N times with and without the
 * plan; and with --out saves the request with the breakpoints in place.
 *
 * Pricing assumes the same request is sent N times (an agent loop's steps, a
 * shared system prompt and document set); cache writes cost 1.25x input
 * (2x with ttl "1h"), reads the model's own cache-read rate (0.1x; 0.05x on
 * Opus 5.5 and Sonnet 5.5; 0.025x on Fable and Mythos 5.1).
 */
import { estimateTokens, formatTokens } from "./tokens.js";
import { formatUsd, pricingFor } from "./pricing.js";
const LOOKBACK_BLOCKS = 20;
const MAX_BREAKPOINTS = 4;
/**
 * Smallest prefix Anthropic caches, per model (prompt-caching docs, Oct 2026).
 * Not monotonic across generations: the 5.x models cache from 512 tokens,
 * Opus 4.6/4.5 and Haiku 4.5 only from 4,096, so one number for every model
 * (the old "1,024, 2,048 on Haiku") advised breakpoints that could never hit
 * on some models and called cacheable prompts too small on others.
 */
const CACHE_MINIMUMS = {
    "opus 5.5": 512, "opus 5.0": 512, "fable 5.0": 512, "fable 5.1": 512,
    "mythos 5.0": 512, "mythos 5.1": 512, "sonnet 5.5": 512, "haiku 5.5": 512,
    "opus 4.8": 1024, "sonnet 5.0": 1024, "sonnet 4.6": 1024, "sonnet 4.5": 1024,
    "opus 4.1": 1024, "opus 4.0": 1024, "sonnet 4.0": 1024,
    "opus 4.7": 2048, "haiku 3.5": 2048, "mythos preview": 2048,
    "opus 4.6": 4096, "opus 4.5": 4096, "haiku 4.5": 4096,
};
/** For a model the table does not know: the most common minimum across generations. */
const DEFAULT_CACHE_MINIMUM = 1024;
export function minCacheableTokens(model) {
    const m = (model ?? "").toLowerCase();
    if (/mythos-preview/.test(m))
        return CACHE_MINIMUMS["mythos preview"];
    // Current ids: claude-<family>-<major>[-<minor>], optionally dated (claude-opus-4-20250514 is
    // Opus 4.0, so a minor is one or two digits, never the 8-digit date) or with a platform
    // prefix/suffix (anthropic.claude-...-v1:0, claude-...@20251101).
    let key;
    const cur = /(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d{1,2}))?(?!\d)/.exec(m);
    if (cur)
        key = `${cur[1]} ${cur[2]}.${cur[3] ?? "0"}`;
    // Claude 3 ids put the version first: claude-3-5-haiku-20241022.
    const old = /claude-(\d)(?:-(\d))?-(opus|sonnet|haiku)/.exec(m);
    if (old)
        key = `${old[3]} ${old[1]}.${old[2] ?? "0"}`;
    return (key && CACHE_MINIMUMS[key]) || DEFAULT_CACHE_MINIMUM;
}
function blocksOf(req, model, longTtl = false) {
    const out = [];
    const mark = (obj) => (on) => {
        if (on)
            obj.cache_control = obj.cache_control ?? (longTtl ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" });
        else
            delete obj.cache_control;
    };
    const tok = (x) => estimateTokens(typeof x === "string" ? x : JSON.stringify(x ?? ""), model);
    (Array.isArray(req.tools) ? req.tools : []).forEach((t, i) => {
        out.push({ at: `tools[${i}]`, tokens: tok(t), section: "tools", hasBreakpoint: Boolean(t?.cache_control), ttl: blockTtl(t), set: mark(t) });
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
        req.system.forEach((b, i) => out.push({ at: `system[${i}]`, tokens: tok(b?.text ?? b), section: "system", hasBreakpoint: Boolean(b?.cache_control), ttl: blockTtl(b), set: mark(b) }));
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
                out.push({ at: `messages[${i}].content[${j}]`, tokens: isImage ? 1600 : tok(b?.text ?? b?.content ?? b) + (j === 0 ? 4 : 0), section: "messages", type: b?.type, hasBreakpoint: Boolean(b?.cache_control), ttl: blockTtl(b), set: mark(b) });
            });
        }
    });
    return out;
}
const blockTtl = (obj) => (obj?.cache_control ? (obj.cache_control.ttl === "1h" ? "1h" : "5m") : undefined);
/**
 * Bedrock's legacy integration rejects a top-level cache_control (400): its
 * ids are `anthropic.claude-…` (with an optional region prefix) and it serves
 * Opus 4.6 and earlier.
 */
function legacyBedrock(model) {
    const m = (model ?? "").toLowerCase();
    if (!/^(?:[a-z]{2,6}\.)?anthropic\.claude/.test(m))
        return false;
    const cur = /(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(m);
    if (cur)
        return Number(cur[2]) + Number(cur[3] ?? 0) / 10 <= 4.6;
    return /claude-\d(?:-\d)?-(opus|sonnet|haiku)/.test(m); // Claude 3.x
}
/** Lookback positions of each block: a run of tool_use (or tool_result) blocks is one. */
function positions(blocks) {
    const out = [];
    let pos = -1;
    blocks.forEach((b, i) => {
        const prev = blocks[i - 1];
        const sameRun = prev && b.section === "messages" && prev.section === "messages" && (b.type === "tool_use" || b.type === "tool_result") && prev.type === b.type;
        if (!sameRun)
            pos++;
        out.push(pos);
    });
    return out;
}
export function planCache(request, calls = 10, modelOverride, opts = {}) {
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
    // Cache writes cost 1.25x input at the 5-minute TTL and 2x at one hour. A
    // request that already uses the hour keeps it on the planned breakpoints, so
    // the price below is the price of the request apply() returns.
    const longTtl = /"ttl"\s*:\s*"1h"/.test(JSON.stringify(req));
    const blocks = blocksOf(req, model, longTtl);
    const total = blocks.reduce((s, b) => s + b.tokens, 0);
    const minCacheable = minCacheableTokens(model);
    const prefixAt = (i) => blocks.slice(0, i + 1).reduce((s, b) => s + b.tokens, 0);
    const lastIndex = (section) => blocks.map((b) => b.section).lastIndexOf(section);
    // A top-level cache_control already in the request is automatic caching.
    const autoNow = req.cache_control && typeof req.cache_control === "object" ? req.cache_control : undefined;
    const bedrock = legacyBedrock(model);
    const useAuto = !bedrock && (!opts.explicit || autoNow !== undefined);
    const picks = [];
    const pick = (i, why, auto = false) => {
        if (i < 0 || picks.some((p) => p.i === i && !p.auto) || prefixAt(i) < minCacheable)
            return;
        picks.push({ i, why, auto });
    };
    const lastMsg = lastIndex("messages");
    // Automatic caching lands on the last cacheable block, whichever section it is in.
    const lastBlock = blocks.length - 1;
    pick(lastIndex("tools"), "end of the tool definitions: stable across every call");
    pick(lastIndex("system"), "end of the system prompt: stable across every call");
    // The conversation boundary moves forward each turn; a breakpoint on the last block caches the whole history for the next call.
    if (useAuto) {
        // An explicit breakpoint where the automatic one lands adds nothing.
        const dup = picks.findIndex((p) => p.i === lastBlock);
        if (dup >= 0)
            picks.splice(dup, 1);
        pick(lastBlock, "automatic caching: one top-level cache_control puts the breakpoint on the last block and moves it forward as the conversation grows", true);
    }
    else {
        pick(lastMsg, "last block of the conversation: the next call reads everything before it from cache");
    }
    // Beyond 20 positions back from the moving breakpoint the cache stops looking; anchor the middle.
    const pos = positions(blocks);
    const firstMsg = blocks.findIndex((b) => b.section === "messages");
    if (firstMsg >= 0 && lastMsg >= 0 && pos[lastMsg] - pos[firstMsg] > LOOKBACK_BLOCKS && picks.length < MAX_BREAKPOINTS) {
        const target = pos[lastMsg] - LOOKBACK_BLOCKS;
        pick(pos.findIndex((p) => p >= target), `anchor ${LOOKBACK_BLOCKS} positions back: the cache only looks back ${LOOKBACK_BLOCKS} positions from a breakpoint`);
    }
    picks.sort((a, b) => a.i - b.i || Number(a.auto) - Number(b.auto));
    while (picks.length > MAX_BREAKPOINTS)
        picks.splice(1, 1);
    const explicitNow = blocks.filter((b) => b.hasBreakpoint);
    const existing = [...(autoNow ? ["top level (automatic)"] : []), ...explicitNow.map((b) => b.at)];
    if (existing.length > MAX_BREAKPOINTS) {
        notes.push(autoNow
            ? `The request carries ${explicitNow.length} block breakpoints and a top-level cache_control, which takes a slot of its own: the API rejects more than ${MAX_BREAKPOINTS} (400).`
            : `The request carries ${existing.length} breakpoints; the API rejects more than ${MAX_BREAKPOINTS}.`);
    }
    const last = blocks[blocks.length - 1];
    const ttlOf = (c) => (c?.ttl === "1h" ? "1h" : "5m");
    if (autoNow && last?.hasBreakpoint && last.ttl !== ttlOf(autoNow)) {
        notes.push(`The last block's own cache_control (${last.ttl}) differs from the top-level one (${ttlOf(autoNow)}): the API answers 400. Remove one.`);
    }
    if (bedrock && autoNow)
        notes.push("Bedrock's legacy integration (Opus 4.6 and earlier) answers a top-level cache_control with a 400: use block-level breakpoints there (this plan does).");
    if (useAuto && picks.length === 1 && picks[0].auto)
        notes.push("Automatic caching is all this request needs: one top-level field, nothing to move as the conversation grows.");
    if (total < minCacheable)
        notes.push(`The whole request is ~${formatTokens(total)} tokens, under the ${formatTokens(minCacheable)} minimum ${model ?? "this model"} caches: caching cannot help until it grows.`);
    const cachedTokens = picks.length ? prefixAt(picks[picks.length - 1].i) : 0;
    const price = pricingFor(model);
    const writeMult = longTtl ? 2 : 1.25;
    let usdWithout, usdWith, readMultiplier;
    if (price) {
        const p = price.inputPerM / 1e6;
        readMultiplier = price.cacheReadPerM / price.inputPerM;
        usdWithout = calls * total * p;
        const rest = total - cachedTokens;
        usdWith = cachedTokens * writeMult * p + rest * p + (calls - 1) * (cachedTokens * readMultiplier * p + rest * p);
    }
    return {
        plan: {
            provider: "anthropic",
            model,
            totalTokens: total,
            minCacheable,
            existing,
            plan: picks.map((p) => (p.auto
                ? { at: "top level (automatic)", automatic: true, prefixTokens: prefixAt(p.i), why: p.why }
                : { at: blocks[p.i].at, prefixTokens: prefixAt(p.i), why: p.why })),
            cachedTokens,
            calls,
            usdWithout,
            usdWith,
            readMultiplier,
            notes,
        },
        apply: () => {
            for (const b of blocks)
                b.set(false);
            delete req.cache_control;
            for (const p of picks) {
                if (p.auto)
                    req.cache_control = autoNow ?? (longTtl ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" });
                else
                    blocks[p.i].set(true);
            }
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
        if (p.plan.some((b) => b.automatic))
            out.push(`  (top level: "cache_control": {"type": "ephemeral"} beside "model"; --explicit plans a block-level one instead)`);
    }
    if (p.usdWithout !== undefined && p.usdWith !== undefined && p.plan.length) {
        const saved = p.usdWithout - p.usdWith;
        out.push("", `Sent ${p.calls} times: ${formatUsd(p.usdWithout)} of input without caching, ${formatUsd(p.usdWith)} with this plan (${saved >= 0 ? "saves" : "costs"} ${formatUsd(Math.abs(saved))}, ${Math.round((Math.abs(saved) / p.usdWithout) * 100)}%).`, `(~${formatTokens(p.cachedTokens)} tokens read at ${p.readMultiplier !== undefined ? `${+p.readMultiplier.toFixed(3)}x` : "the cache-read rate"} after the first call, which writes them once at the cache-write rate.)`);
    }
    if (p.notes.length)
        out.push("", ...p.notes.map((n) => `! ${n}`));
    if (p.usdWithout === undefined && p.plan.length)
        out.push("", "Pass --model (e.g. claude-sonnet-5) to price it.");
    if (p.plan.length)
        out.push("", "--out <file> saves the request with exactly these breakpoints.");
    return out.join("\n");
}
