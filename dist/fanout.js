/**
 * The fan-out guard: a price on a subagent before it starts.
 *
 * Claude Code launches subagents with its Agent tool (named Task before
 * 2.1.63; 2.1.308 still maps a "Task" matcher to it, 2.1.62 knows only
 * "Task", so the matcher is "Agent|Task"). Each one has its own context and
 * its own bill, and a fan-out of five is five bills, with nothing shown
 * before they start. A PreToolUse hook on that tool runs first: it answers
 * with a `systemMessage` the user sees, and once per session an
 * `additionalContext` note the model reads, and never a permission decision,
 * so the subagent always starts (verified in the hooks docs and both
 * binaries: no decision means the normal permission flow; a hook that fails
 * or times out does not block a PreToolUse call; only exit 2 would, and this
 * never exits 2). PreToolUse is in 2.1.62's event list, so it needs none of
 * PreModelSwitch's version guard.
 *
 * The price is the user's own: the median cost of the subagents of that
 * type (and model) in their transcripts, the same reading `context-doctor
 * subagents` does, cached for a day. Where the subagent would run on Opus or
 * Fable, the note gives the Sonnet price too: the Agent tool takes
 * `model: "sonnet"`.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { statePath } from "./ledger.js";
import { listSessions } from "./session.js";
import { scanSubagent } from "./subagentpay.js";
import { formatUsd, pricingFor } from "./pricing.js";
import { tailUsage } from "./statusline.js";
/** The subagent tool, by its current name and its pre-2.1.63 alias. */
export const FANOUT_MATCHER = "Agent|Task";
const DAY = 86_400_000;
/** Enough runs for a median to mean something. */
const MIN_RUNS = 3;
export function subagentCostsPath() {
    return join(dirname(statePath()), ".context-doctor-subagent-costs.json");
}
function stat(costs) {
    const s = costs.map((c) => c.usd).sort((a, b) => a - b);
    const models = new Map();
    for (const c of costs)
        if (c.model)
            models.set(c.model, (models.get(c.model) ?? 0) + 1);
    return {
        n: s.length,
        median: s[Math.floor(s.length / 2)],
        p90: s[Math.min(s.length - 1, Math.floor(s.length * 0.9))],
        model: [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0],
    };
}
/**
 * Each subagent's bill in the last `days`, newest transcripts first, by
 * type and model. `limit` and `budgetMs` bound the work when the hook has
 * to measure (the cache is a day old): the newest subagents are the best
 * guide anyway.
 */
export function measureSubagentCosts(days = 30, opts = {}) {
    const now = opts.now ?? Date.now();
    const since = now - days * DAY;
    const started = Date.now();
    const parents = opts.sessions ?? listSessions(10_000).filter((s) => s.path.includes(".claude") && s.modifiedAt.getTime() >= since).map((s) => s.path);
    const files = [];
    for (const parent of parents) {
        const dir = join(parent.replace(/\.jsonl$/, ""), "subagents");
        let names;
        try {
            names = readdirSync(dir);
        }
        catch {
            continue;
        }
        for (const f of names) {
            if (!/^agent-.+\.jsonl$/.test(f))
                continue;
            const file = join(dir, f);
            try {
                const at = statSync(file).mtimeMs;
                if (at >= since)
                    files.push({ file, meta: join(dir, f.replace(/\.jsonl$/, ".meta.json")), at });
            }
            catch { /* gone */ }
        }
    }
    files.sort((a, b) => b.at - a.at);
    const runs = [];
    for (const f of files.slice(0, opts.limit ?? Infinity)) {
        if (opts.budgetMs !== undefined && Date.now() - started > opts.budgetMs)
            break;
        try {
            const s = scanSubagent(f.file);
            if (!(s.costUsd > 0))
                continue;
            let type = "unknown";
            try {
                type = String(JSON.parse(readFileSync(f.meta, "utf8"))?.agentType ?? "unknown").slice(0, 60);
            }
            catch { /* older Claude Code: no meta */ }
            runs.push({ type, model: s.model, usd: s.costUsd });
        }
        catch { /* unreadable */ }
    }
    const group = (key) => {
        const m = new Map();
        for (const r of runs) {
            const k = key(r);
            if (k)
                m.set(k, [...(m.get(k) ?? []), r]);
        }
        return Object.fromEntries([...m.entries()].map(([k, v]) => [k, stat(v)]));
    };
    return {
        computedAt: now,
        days,
        n: runs.length,
        all: runs.length ? stat(runs) : undefined,
        byType: group((r) => r.type),
        byTypeModel: group((r) => (r.model ? `${r.type}|${r.model}` : undefined)),
        byModel: group((r) => r.model),
    };
}
export function saveSubagentCosts(c, path = subagentCostsPath()) {
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(c));
    }
    catch { /* a cache */ }
}
/** The cached medians when under a day old, else measured now (bounded) and cached. */
export function subagentCosts(now = Date.now(), path = subagentCostsPath()) {
    try {
        if (existsSync(path)) {
            const c = JSON.parse(readFileSync(path, "utf8"));
            if (typeof c?.computedAt === "number" && now - c.computedAt < DAY && now >= c.computedAt && c.byType && typeof c.byType === "object")
                return c;
        }
    }
    catch { /* remeasure */ }
    try {
        const c = measureSubagentCosts(30, { limit: 80, budgetMs: 1500, now });
        saveSubagentCosts(c, path);
        return c;
    }
    catch {
        return undefined;
    }
}
/** The Agent tool's model aliases, as a model id to price them at: the one these runs used most, else the current version. */
const ALIAS = {
    sonnet: { family: /sonnet/i, fallback: "claude-sonnet-5-5" },
    opus: { family: /opus/i, fallback: "claude-opus-5-5" },
    haiku: { family: /haiku/i, fallback: "claude-haiku-5-5" },
    fable: { family: /fable|mythos/i, fallback: "claude-fable-5-1" },
};
function aliasModel(alias, costs) {
    const a = ALIAS[alias.toLowerCase()];
    if (!a)
        return undefined;
    const seen = Object.entries(costs.byModel).filter(([m]) => a.family.test(m)).sort((x, y) => y[1].n - x[1].n)[0]?.[0];
    return seen ?? a.fallback;
}
const short = (model) => {
    const m = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(model ?? "");
    return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : model ?? "its model";
};
/** What a subagent of this type on this model costs, from the user's own runs. Undefined with too few. */
export function estimateSubagent(costs, type, modelAlias, parentModel) {
    const byType = costs.byType[type];
    // A subagent runs on the model it is given, else (built-in types included,
    // on the author's history) on the parent's: the parent's, not the type's
    // past model, which may be a version since replaced.
    const model = (modelAlias ? aliasModel(modelAlias, costs) : undefined) ?? parentModel ?? (byType && byType.n >= MIN_RUNS ? byType.model : undefined);
    const scale = (from, to) => {
        const a = pricingFor(from), b = pricingFor(to);
        return a && b && a.inputPerM > 0 ? b.inputPerM / a.inputPerM : 1;
    };
    let base, factor = 1;
    const exact = model ? costs.byTypeModel[`${type}|${model}`] : undefined;
    if (exact && exact.n >= MIN_RUNS)
        base = exact;
    else if (byType && byType.n >= MIN_RUNS) {
        base = byType;
        factor = scale(byType.model, model ?? byType.model);
    }
    else if (model && costs.byModel[model]?.n >= MIN_RUNS)
        base = costs.byModel[model];
    else if (costs.all && costs.all.n >= MIN_RUNS) {
        base = costs.all;
        factor = scale(costs.all.model, model ?? costs.all.model);
    }
    if (!base)
        return undefined;
    const est = { type, model: model ?? base.model, median: base.median * factor, p90: base.p90 * factor, runs: base.n };
    if (est.model && /opus|fable|mythos/i.test(est.model)) {
        const sonnet = aliasModel("sonnet", costs);
        const measured = costs.byTypeModel[`${type}|${sonnet}`];
        est.cheaper = measured && measured.n >= MIN_RUNS
            ? { model: sonnet, median: measured.median, measured: true }
            : { model: sonnet, median: est.median * scale(est.model, sonnet), measured: false };
        if (!(est.cheaper.median < est.median))
            delete est.cheaper;
    }
    return est;
}
const BURST_MS = 120_000;
/**
 * What to say before this subagent starts, and the session state after it.
 * The user sees the price the first time a type starts in a session and when
 * launches bunch up (3 within two minutes, then every 5th); the model gets
 * one short note per session, only where a cheaper model exists.
 */
export function fanoutMessage(input, costs, state, now = Date.now()) {
    const next = { spawns: [...state.spawns.filter((t) => now - t < 10 * 60_000), now].slice(-50), shown: [...state.shown], told: state.told };
    if (!costs || !/^(Agent|Task)$/.test(String(input.tool_name ?? "")))
        return { state: next };
    const ti = input.tool_input ?? {};
    const type = typeof ti.subagent_type === "string" && ti.subagent_type.trim() ? ti.subagent_type.trim().slice(0, 60) : "general-purpose";
    const alias = typeof ti.model === "string" ? ti.model : undefined;
    const parentModel = input.transcript_path && existsSync(input.transcript_path) ? tailUsage(input.transcript_path)?.model : undefined;
    const est = estimateSubagent(costs, type, alias, parentModel);
    if (!est)
        return { state: next };
    const burst = next.spawns.filter((t) => now - t < BURST_MS).length;
    const firstOfType = !next.shown.includes(type);
    const showBurst = burst >= 3 && (burst === 3 || burst % 5 === 0);
    const out = { state: next };
    if (firstOfType || showBurst) {
        const runs = `${est.runs} run${est.runs === 1 ? "" : "s"}`;
        const cheaper = est.cheaper && !alias ? ` On Sonnet: ~${formatUsd(est.cheaper.median)}${est.cheaper.measured ? "" : " at its price"}.` : "";
        out.systemMessage = showBurst
            ? `context-doctor: ${burst} subagents in 2 minutes, ~${formatUsd(est.median * burst)} together at your median of ~${formatUsd(est.median)} for ${type} on ${short(est.model)} (${runs}).${cheaper}`
            : `context-doctor: a ${type} subagent on ${short(est.model)} costs ~${formatUsd(est.median)} at your median (p90 ${formatUsd(est.p90)}, ${runs}, list price).${cheaper}`;
        if (firstOfType)
            next.shown = [...next.shown, type].slice(-30);
    }
    if (!next.told && est.cheaper && !alias) {
        out.additionalContext = `context-doctor: on this machine a ${type} subagent costs ~${formatUsd(est.median)} at the median on ${short(est.model)}, ~${formatUsd(est.cheaper.median)} on Sonnet. For search, reading or summarising, pass model: "sonnet" to the Agent tool.`;
        next.told = true;
    }
    return out;
}
/** For `doctor` and the docs: where the medians come from. */
export function describeCosts(c) {
    if (!c || !c.all)
        return "no subagent runs measured yet";
    return `${c.n} subagents in ${c.days} days, median ${formatUsd(c.all.median)} (${basename(subagentCostsPath())})`;
}
/** The medians the subagent price quotes, for `context-doctor subagents`. */
export function renderCostMedians(c) {
    const types = Object.entries(c.byType).filter(([, s]) => s.n >= MIN_RUNS).sort((a, b) => b[1].n - a[1].n).slice(0, 8);
    if (!types.length)
        return [];
    return [
        "",
        `What a subagent costs here (median, p90; the price shown before one starts):`,
        ...types.map(([t, s]) => `  ${t.slice(0, 26).padEnd(26)} ${formatUsd(s.median).padStart(8)} ${formatUsd(s.p90).padStart(8)}   ${s.n} runs, mostly ${short(s.model)}`),
    ];
}
