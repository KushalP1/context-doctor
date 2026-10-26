/**
 * Two costs the other reports do not show: the output side of the bill, and
 * polling.
 *
 *  - Output and reasoning: what share of a session's (or a period's) cost is
 *    output tokens, and of those the reasoning (Claude's
 *    `output_tokens_details.thinking_tokens`, Codex's
 *    `reasoning_output_tokens`), per model. Only shown: whether shorter output
 *    keeps quality is a question for `context-doctor ab`, so no saving is
 *    claimed here.
 *  - Polling: a tool call identical to the one before it (same tool, same
 *    input), as a wait-and-check loop makes (BashOutput on one shell, Codex's
 *    `wait` or `write_stdin` with nothing to write, `sleep 30 && tail log`).
 *    Each repeat is a whole request that re-reads the context; it is priced
 *    at that request's billed cost.
 */
import { forEachLine, listSessions, replyCounter } from "./session.js";
import { openAIUsage, pricingFor, usageCost } from "./pricing.js";
import { formatTokens, realModel } from "./tokens.js";
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
class Acc {
    models = new Map();
    polls = new Map();
    pollContext = 0;
    sessions = 0;
    request(model, u, reasoning) {
        const name = model ?? "unknown";
        const m = this.models.get(name) ?? { model: name, requests: 0, outputTokens: 0, reasoningTokens: 0, outputUsd: 0, totalUsd: 0 };
        const price = pricingFor(model);
        const cost = price ? usageCost(u, price) : undefined;
        m.requests++;
        m.outputTokens += num(u.output_tokens);
        m.reasoningTokens += Math.min(num(u.output_tokens), reasoning);
        m.outputUsd += cost?.outputUsd ?? 0;
        m.totalUsd += cost?.totalUsd ?? 0;
        this.models.set(name, m);
        return cost?.totalUsd ?? 0;
    }
    poll(tool, usd, context) {
        const p = this.polls.get(tool) ?? { repeats: 0, usd: 0 };
        p.repeats++;
        p.usd += usd;
        this.polls.set(tool, p);
        this.pollContext += context;
    }
    result() {
        const byModel = [...this.models.values()].filter((m) => m.requests > 0).sort((a, b) => b.totalUsd - a.totalUsd);
        const byTool = [...this.polls.entries()].map(([tool, p]) => ({ tool, ...p })).sort((a, b) => b.usd - a.usd || b.repeats - a.repeats);
        return {
            sessions: this.sessions,
            byModel,
            polls: { repeats: byTool.reduce((n, t) => n + t.repeats, 0), usd: byTool.reduce((n, t) => n + t.usd, 0), contextTokens: this.pollContext, byTool },
            totalUsd: byModel.reduce((n, m) => n + m.totalUsd, 0),
        };
    }
}
/** A call's identity: its tool and its exact input. */
const callKey = (name, input) => `${name}\u0000${typeof input === "string" ? input : JSON.stringify(input ?? null)}`;
function scanClaude(path, acc, since, runRows) {
    const sighting = replyCounter(runRows);
    const costOf = new Map();
    let prevCall;
    forEachLine(path, (line) => {
        const prompt = line.includes('"type":"user"') && !line.includes('"tool_result"');
        if (!prompt && !line.includes('"usage"') && !line.includes('"tool_use"'))
            return;
        let e;
        try {
            e = JSON.parse(line);
        }
        catch {
            return;
        }
        // A prompt the user typed between two identical calls makes the second a
        // new request, not a poll (the same check, asked for again).
        if (e?.type === "user" && !e.isSidechain && !e.isMeta && !(Array.isArray(e.message?.content) && e.message.content.some((b) => b?.type === "tool_result"))) {
            prevCall = undefined;
            return;
        }
        if (e?.type !== "assistant" || e.isSidechain || !e.message)
            return;
        const m = e.message;
        const at = Date.parse(String(e.timestamp ?? ""));
        const inPeriod = !(Number.isFinite(at) && at < since);
        const id = typeof m.id === "string" ? m.id : undefined;
        if (m.usage && realModel(m.model)) {
            const seen = sighting(e);
            if (seen === "new" && inPeriod) {
                const u = m.usage;
                const usd = acc.request(realModel(m.model), u, num(u.output_tokens_details?.thinking_tokens));
                if (id)
                    costOf.set(id, { usd, context: num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens) });
            }
        }
        if (!Array.isArray(m.content))
            return;
        for (const b of m.content) {
            if (b?.type !== "tool_use" || typeof b.name !== "string")
                continue;
            const key = callKey(b.name, b.input);
            if (key === prevCall && inPeriod) {
                // One reply's cost once, however many identical calls it holds.
                const c = id ? costOf.get(id) : undefined;
                acc.poll(b.name, c?.usd ?? 0, c?.context ?? 0);
                if (id && c)
                    costOf.set(id, { usd: 0, context: 0 });
            }
            prevCall = key;
        }
    });
}
function scanCodex(path, acc, since) {
    let model;
    let prevCall;
    /** Repeats waiting for the token_count of the response that made them. */
    let pending = [];
    let total = -1;
    forEachLine(path, (line) => {
        let e;
        try {
            e = JSON.parse(line);
        }
        catch {
            return;
        }
        const p = e?.payload;
        if (!p || typeof p !== "object")
            return;
        const at = Date.parse(String(e.timestamp ?? ""));
        const inPeriod = !(Number.isFinite(at) && at < since);
        if (e.type === "turn_context" && typeof p.model === "string")
            model = p.model;
        if (e.type === "response_item" && p.type === "message" && p.role === "user")
            prevCall = undefined;
        if (e.type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call")) {
            const name = String(p.name ?? (p.type === "local_shell_call" ? "shell" : p.type));
            const key = callKey(name, p.arguments ?? p.input ?? p.action);
            if (key === prevCall && inPeriod)
                pending.push(name);
            prevCall = key;
        }
        if (e.type === "event_msg" && p.type === "token_count") {
            const last = p.info?.last_token_usage;
            const runTotal = num(p.info?.total_token_usage?.total_tokens);
            if (!last || !(num(last.input_tokens) > 0) || (runTotal !== 0 && runTotal === total))
                return;
            total = runTotal;
            if (!inPeriod) {
                pending = [];
                return;
            }
            const u = openAIUsage(last);
            const usd = acc.request(model, u, num(last.reasoning_output_tokens));
            pending.forEach((name, i) => acc.poll(name, i === 0 ? usd : 0, i === 0 ? num(last.input_tokens) : 0));
            pending = [];
        }
    });
}
/** One session transcript (Claude Code or Codex). */
export function sessionLens(path, since = 0) {
    const acc = new Acc();
    acc.sessions = 1;
    if (/[\\/]\.codex[\\/]/.test(path) || /rollout-[^\\/]*\.jsonl$/.test(path))
        scanCodex(path, acc, since);
    else
        scanClaude(path, acc, since);
    return acc.result();
}
/** Every Claude Code (and, unless `claudeOnly`, Codex) session touched in the last `days`. */
export function lensOverSessions(days = 30, opts = {}) {
    const since = (opts.now ?? Date.now()) - days * 86_400_000;
    const files = opts.paths ?? listSessions(10_000).filter((s) => s.modifiedAt.getTime() >= since && (s.path.includes(".claude") || (!opts.claudeOnly && s.project === "codex"))).map((s) => s.path);
    const acc = new Acc();
    const runRows = new Set();
    for (const f of files) {
        try {
            if (/[\\/]\.codex[\\/]/.test(f))
                scanCodex(f, acc, since);
            else
                scanClaude(f, acc, since, runRows);
            acc.sessions++;
        }
        catch { /* skip */ }
    }
    return acc.result();
}
const pct = (x) => `${Math.round(x * 100)}%`;
const usd = (n) => (n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : n >= 0.01 ? `$${n.toFixed(2)}` : n > 0 ? "<$0.01" : "$0");
/** A tool as people say it: an MCP tool by its own name, without the server prefix. */
const toolName = (t) => /^mcp__.+?__(.+)$/.exec(t)?.[1] ?? t;
/** Lines for `session` and `savings` (within 60 columns), or none when nothing is priced. */
export function renderLens(l, opts = {}) {
    const priced = l.byModel.filter((m) => m.totalUsd > 0);
    if (!priced.length)
        return [];
    const out = [];
    if (opts.heading !== false)
        out.push("Output and polling (at list price; shown, not a lever)");
    const all = priced.reduce((a, m) => ({ out: a.out + m.outputUsd, total: a.total + m.totalUsd, tokens: a.tokens + m.outputTokens, reasoning: a.reasoning + m.reasoningTokens }), { out: 0, total: 0, tokens: 0, reasoning: 0 });
    out.push(`  Output: ${pct(all.out / all.total)} of ${usd(all.total)}` + (all.reasoning > 0 ? `; reasoning ${pct(all.reasoning / Math.max(1, all.tokens))} of output tokens.` : "."));
    if (priced.length > 1) {
        for (const m of priced.slice(0, 4)) {
            out.push(`    ${m.model.slice(0, 20).padEnd(20)} ${pct(m.outputUsd / m.totalUsd).padStart(4)} of ${usd(m.totalUsd).padStart(7)}${m.reasoningTokens > 0 ? `, reasoning ${pct(m.reasoningTokens / Math.max(1, m.outputTokens))}` : ""}`);
        }
    }
    if (l.polls.repeats > 0) {
        const top = l.polls.byTool.slice(0, 3).map((t) => `${toolName(t.tool).slice(0, 18)} ${t.repeats}`).join(", ");
        out.push(`  ${l.polls.repeats} repeated identical tool call${l.polls.repeats === 1 ? "" : "s"} (polling) re-read`);
        out.push(`  ~${formatTokens(l.polls.contextTokens)} tokens: ${usd(l.polls.usd)}. Most: ${top}.`);
    }
    out.push("  Does shorter output keep quality? context-doctor ab");
    return out;
}
