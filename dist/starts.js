/**
 * The start of every session and every subagent: the first request's prompt
 * before the first message, per Claude Code entrypoint (the Desktop app, the
 * terminal, the SDK) and per subagent type, priced across the period.
 *
 * Every later request re-reads that start: from the cache at the read price
 * on a warm step, written again at the write price on a cold one. On the
 * author's machine a Desktop-app session starts at a median ~70k tokens and a
 * general-purpose subagent at ~52k, re-read at each of its steps (#105328:
 * a terminal session starts at ~13k, because the tools the terminal defers
 * behind tool search the app sends whole).
 *
 * Claude Code records what it sent: each transcript's `api-request-shape`
 * rows carry the request's system prompt and every tool definition, with
 * `defer_loading` on the ones held behind tool search, and the
 * `deferred_tools_delta` attachments name the ones announced as deferred. So
 * the part of a start that could be deferred, MCP tool definitions sent whole,
 * is read from the request itself; its tokens are estimated from its length
 * (Claude's ratios), the start itself is the API's own count.
 */
import { readFileSync } from "node:fs";
import { claudeMcpConfigs } from "./mcpschema.js";
import { REQUEST_ROWS } from "./coldresume.js";
import { rowsOf } from "./scan.js";
import { listSessions, isClaudeSession, replyCounter, textOf } from "./session.js";
import { subagentFiles, workflowRunOf } from "./subagents.js";
import { cacheWriteSplit, formatUsd, rateCard, ratesAt, usageCost } from "./pricing.js";
import { formatTokens, isCodeLike, realModel, tokensForLength } from "./tokens.js";
const CLAUDE = "claude-opus-5";
/**
 * What a start's measurement takes from a transcript: the entrypoint, the
 * first request's query source (it names a subagent's type), the first user
 * message's length (never its text), the tools announced as deferred before
 * the first reply, and the first request's shape as names and lengths. A
 * handful of records per transcript, read once (scan.ts).
 */
export const START_ROWS = {
    id: "starts.1",
    init: () => ({}),
    line(raw, row, out, st) {
        const want = (!st.e && raw.includes('"entrypoint"')) ||
            (!st.q && raw.includes('"api-request"')) ||
            (!st.s && raw.includes('"api-request-shape"')) ||
            (!st.u && raw.includes('"user"')) ||
            (!st.r && (raw.includes('"deferred_tools_delta"') || raw.includes('"usage"')));
        if (!want)
            return;
        let e;
        try {
            e = row();
        }
        catch {
            return;
        }
        if (!e || typeof e !== "object")
            return;
        if (!st.e && typeof e.entrypoint === "string" && e.entrypoint) {
            st.e = 1;
            out.push({ k: "e", v: e.entrypoint.slice(0, 40) });
        }
        if (e.type === "api-request" && !st.q && typeof e.querySource === "string") {
            st.q = 1;
            out.push({ k: "q", v: e.querySource.slice(0, 120) });
        }
        if (e.type === "api-request-shape" && !st.s && e.shape && typeof e.shape === "object") {
            st.s = 1;
            const tools = [];
            for (const t of Array.isArray(e.shape.tools) ? e.shape.tools : []) {
                if (!t || typeof t !== "object" || typeof t.name !== "string")
                    continue;
                tools.push([t.name.slice(0, 200), JSON.stringify(t).length, t.defer_loading === true ? 1 : 0]);
            }
            const sys = e.shape.system === undefined ? 0 : JSON.stringify(e.shape.system).length;
            out.push({ k: "s", sys, tools });
        }
        if (!st.r && e.type === "attachment" && e.attachment?.type === "deferred_tools_delta" && Array.isArray(e.attachment.addedNames)) {
            out.push({ k: "d", names: e.attachment.addedNames.filter((n) => typeof n === "string").map((n) => n.slice(0, 200)) });
        }
        if (!st.u && e.type === "user" && !e.isMeta) {
            const text = textOf(e.message?.content);
            if (text) {
                st.u = 1;
                out.push({ k: "u", len: text.length, code: isCodeLike(text) });
            }
        }
        if (!st.r && e.type === "assistant") {
            const u = e.message?.usage;
            if (u && (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) > 0)
                st.r = 1;
        }
    },
};
/** An entrypoint as people call it. */
export function entrypointName(e) {
    switch (e) {
        case "claude-desktop": return "Desktop app";
        case "cli": return "terminal";
        case "sdk-cli": return "claude -p / SDK";
        case "sdk-ts":
        case "sdk-py": return "Agent SDK";
        case "claude-vscode": return "VS Code";
        case undefined:
        case "": return "unknown";
        default: return e;
    }
}
/** The MCP server a tool name belongs to (`mcp__<server>__<tool>`), or undefined for a built-in. */
export function mcpServerOf(name) {
    const m = /^mcp__(.+?)__/.exec(name);
    return m?.[1];
}
function quantile(sorted, q) {
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}
/** The subagent's type: its meta file's `agentType`, else the first request's query source, else a workflow agent. */
function agentTypeOf(file, querySource) {
    try {
        const t = JSON.parse(readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8"))?.agentType;
        if (typeof t === "string" && t)
            return t.slice(0, 80);
    }
    catch { /* none */ }
    const q = querySource && /^agent:(?:builtin|custom|plugin|user|project)?:?(.+)$/.exec(querySource)?.[1];
    if (q)
        return q.slice(0, 80);
    return workflowRunOf(file) ? "workflow" : "unknown";
}
/** One transcript's start and what it cost across the period, or undefined when it has none to measure. */
function measureStart(path, kind, since, runRows, parentEntry) {
    const meta = rowsOf(path, START_ROWS);
    let entrypoint = parentEntry, querySource, user, shape;
    const deferred = new Set();
    for (const r of meta) {
        if (r.k === "e")
            entrypoint = r.v;
        else if (r.k === "q")
            querySource = r.v;
        else if (r.k === "u")
            user = r;
        else if (r.k === "d")
            for (const n of r.names)
                deferred.add(n);
        else if (r.k === "s")
            shape = r;
    }
    const sighting = replyCounter(runRows);
    let tokens;
    let usd = 0, requests = 0, priced = true, started = false;
    for (const e of rowsOf(path, REQUEST_ROWS)) {
        if (!e || e.type !== "assistant" || !e.message?.usage)
            continue;
        // A session's own thread; a subagent's transcript is all sidechain.
        if (kind === "session" && e.isSidechain)
            continue;
        const seen = sighting(e);
        if (seen === "repeat")
            continue;
        const u = e.message.usage;
        const read = Number(u.cache_read_input_tokens) || 0, write = Number(u.cache_creation_input_tokens) || 0, input = Number(u.input_tokens) || 0;
        const prompt = input + read + write;
        const at = Date.parse(e.timestamp);
        if (!(prompt > 0) || !Number.isFinite(at))
            continue;
        if (!started) {
            started = true;
            // A fork's first request is its parent's: not a start of its own.
            if (seen !== "new")
                return undefined;
            tokens = Math.max(0, prompt - (user ? tokensForLength(user.len, user.code, CLAUDE) : 0));
            if (tokens <= 1000)
                return undefined;
        }
        if (seen === "copy" || at < since)
            continue;
        requests++;
        // The start's tokens on this request, at the rates it paid for them: read from the cache first, then written, then uncached.
        const part = Math.min(tokens, prompt);
        const r = Math.min(part, read);
        const w = Math.min(part - r, write);
        const split = cacheWriteSplit(u);
        const all = split.fiveMinute + split.oneHour + split.twelveHour;
        const oneHour = all > 0 ? (w * split.oneHour) / all : 0;
        const card = rateCard(realModel(e.message.model), u, at);
        if (!card) {
            priced = false;
            continue;
        }
        usd += usageCost({ input_tokens: part - r - w, cache_read_input_tokens: r, cache_creation_input_tokens: w, cache_creation: { ephemeral_5m_input_tokens: w - oneHour, ephemeral_1h_input_tokens: oneHour } }, ratesAt(card, prompt)).promptUsd;
    }
    if (tokens === undefined || requests === 0)
        return undefined;
    const start = { kind, entrypoint, tokens, usd, priced, requests };
    if (kind === "subagent")
        start.agentType = agentTypeOf(path, querySource);
    if (shape) {
        const servers = new Map();
        let wholeTools = 0, wholeTokens = 0, mcpTokens = 0;
        for (const [name, chars, d] of shape.tools) {
            if (d || deferred.has(name))
                continue;
            // Tool definitions are mostly descriptions: prose ratios (an estimate, labelled so).
            const t = tokensForLength(chars, false, CLAUDE);
            wholeTools++;
            wholeTokens += t;
            const server = mcpServerOf(name);
            if (!server)
                continue;
            mcpTokens += t;
            const s = servers.get(server) ?? servers.set(server, { tools: 0, tokens: 0 }).get(server);
            s.tools++;
            s.tokens += t;
        }
        start.shape = { wholeTools, wholeTokens: Math.min(wholeTokens, tokens), mcpTokens: Math.min(mcpTokens, tokens), servers };
    }
    return start;
}
/** Claude Code transcripts written in the last `days` days. */
function claudeTranscripts(days) {
    const since = Date.now() - days * 86_400_000;
    return listSessions(10_000).filter((s) => isClaudeSession(s) && s.modifiedAt.getTime() >= since).map((s) => s.path);
}
/**
 * Every session's and subagent's start in the period, grouped by entrypoint
 * and subagent type, each priced on every request that re-read it.
 * `paths`: the main transcripts (subagents are found beside each).
 */
export function measureStarts(opts = {}) {
    const days = opts.days ?? 30;
    const since = Date.now() - days * 86_400_000;
    const mains = (opts.paths ?? claudeTranscripts(days)).filter((p) => !/[\\/]\.codex[\\/]/.test(p) && !/[\\/]\.gemini[\\/]/.test(p));
    const starts = [];
    const runRows = new Set();
    for (const path of mains) {
        let s;
        try {
            s = measureStart(path, "session", since, runRows);
        }
        catch {
            continue;
        }
        if (s)
            starts.push(s);
        let parentEntry = s?.entrypoint;
        if (parentEntry === undefined) {
            try {
                parentEntry = rowsOf(path, START_ROWS).find((r) => r.k === "e")?.v;
            }
            catch { /* unreadable */ }
        }
        for (const f of subagentFiles(path, since)) {
            try {
                const sub = measureStart(f.file, "subagent", since, undefined, parentEntry);
                if (sub)
                    starts.push(sub);
            }
            catch { /* unreadable: skipped */ }
        }
    }
    let configured = new Map();
    try {
        configured = new Map(claudeMcpConfigs(opts.cwd, opts.home).map((c) => [c.name, c.scope]));
    }
    catch { /* none */ }
    const byKey = new Map();
    for (const s of starts) {
        const k = `${s.kind}\u0000${s.entrypoint ?? ""}\u0000${s.agentType ?? ""}`;
        (byKey.get(k) ?? byKey.set(k, []).get(k)).push(s);
    }
    const groups = [];
    for (const list of byKey.values()) {
        const first = list[0];
        const sorted = list.map((s) => s.tokens).sort((a, b) => a - b);
        const shaped = list.filter((s) => s.shape);
        const med = (xs) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : undefined);
        const servers = new Map();
        for (const s of shaped)
            for (const [name, v] of s.shape.servers) {
                const cur = servers.get(name) ?? servers.set(name, { name, starts: 0, tools: 0, tokens: 0, ...(configured.get(name) ? { configured: configured.get(name) } : {}) }).get(name);
                cur.starts++;
                cur.tools = Math.max(cur.tools, v.tools);
                cur.tokens += v.tokens;
            }
        for (const s of servers.values())
            s.tokens = Math.round(s.tokens / s.starts);
        const g = {
            kind: first.kind,
            entrypoint: first.entrypoint ?? "",
            ...(first.agentType ? { agentType: first.agentType } : {}),
            starts: list.length,
            median: quantile(sorted, 0.5),
            p10: quantile(sorted, 0.1),
            p90: quantile(sorted, 0.9),
            requests: list.reduce((t, s) => t + s.requests, 0),
            usd: list.reduce((t, s) => t + s.usd, 0),
            unpriced: list.filter((s) => !s.priced).length,
            shaped: shaped.length,
            servers: [...servers.values()].sort((a, b) => b.starts * b.tokens - a.starts * a.tokens),
        };
        if (shaped.length) {
            g.wholeTokens = med(shaped.map((s) => s.shape.wholeTokens));
            g.mcpTokens = med(shaped.map((s) => s.shape.mcpTokens));
            g.wholeTools = med(shaped.map((s) => s.shape.wholeTools));
            g.deferrableUsd = shaped.reduce((t, s) => t + s.usd * Math.min(1, s.shape.mcpTokens / s.tokens), 0);
        }
        groups.push(g);
    }
    groups.sort((a, b) => (a.kind === b.kind ? b.usd - a.usd : a.kind === "session" ? -1 : 1));
    const report = { days, groups };
    const desktop = starts.filter((s) => s.kind === "session" && s.entrypoint === "claude-desktop");
    const terminal = starts.filter((s) => s.kind === "session" && s.entrypoint === "cli");
    if (desktop.length && terminal.length) {
        const d = quantile(desktop.map((s) => s.tokens).sort((a, b) => a - b), 0.5);
        const t = quantile(terminal.map((s) => s.tokens).sort((a, b) => a - b), 0.5);
        // What the Desktop app's starts cost above a terminal-sized start, each at its own requests' rates.
        const usd = desktop.reduce((sum, s) => sum + s.usd * Math.max(0, s.tokens - t) / s.tokens, 0);
        report.gap = { desktop: d, terminal: t, tokens: d - t, usd };
    }
    return report;
}
/** The servers whose tools went whole into some start and that the user's own config holds: `alwaysLoad: false` defers them. */
export function deferrableConfigured(r) {
    const out = new Map();
    for (const g of r.groups) {
        if (!g.mcpTokens || !g.deferrableUsd)
            continue;
        for (const s of g.servers) {
            if (!s.configured)
                continue;
            const cur = out.get(s.name) ?? out.set(s.name, { name: s.name, scope: s.configured, tokens: 0, usd: 0 }).get(s.name);
            cur.tokens = Math.max(cur.tokens, s.tokens);
            // Its share of the group's deferrable part, by its tokens on the starts it went into.
            cur.usd += g.deferrableUsd * (s.tokens * s.starts) / (g.servers.reduce((t, x) => t + x.tokens * x.starts, 0) || 1);
        }
    }
    return [...out.values()].sort((a, b) => b.usd - a.usd);
}
const tok = (n) => `~${formatTokens(n)}`;
/** The starts section of `overhead`. */
export function renderStarts(r) {
    const out = ["", "Session and subagent starts (the first request, before the first message)", "─".repeat(56)];
    if (r.groups.length === 0) {
        out.push("  No Claude Code session in the period to measure.");
        return out;
    }
    const line = (label, g) => {
        const cost = `${formatUsd(g.usd)}${g.unpriced ? "+" : ""}`;
        out.push(`  ${label.padEnd(30)} ${String(g.starts).padStart(4)}  median ${tok(g.median).padStart(6)} (p10 ${tok(g.p10)}, p90 ${tok(g.p90)})  ${g.requests.toLocaleString("en-US")} steps re-read it: ${cost}`);
        if (g.mcpTokens !== undefined && g.wholeTokens !== undefined) {
            out.push(`  ${"".padEnd(30)}       tools sent whole ${tok(g.wholeTokens)} (${g.wholeTools} tools), of which MCP ${tok(g.mcpTokens)}${g.deferrableUsd ? `: ${formatUsd(g.deferrableUsd)} of the ${cost}` : ""}${g.shaped < g.starts ? ` (${g.shaped} of ${g.starts} starts record their tools)` : ""}`);
        }
    };
    const sessions = r.groups.filter((g) => g.kind === "session");
    const subs = r.groups.filter((g) => g.kind === "subagent");
    for (const g of sessions)
        line(`${entrypointName(g.entrypoint)} sessions`, g);
    for (const g of subs)
        line(`${g.agentType} (subagent)${new Set(subs.map((x) => x.entrypoint)).size > 1 ? ` (${entrypointName(g.entrypoint)})` : ""}`, g);
    const total = r.groups.reduce((t, g) => t + g.usd, 0);
    const subUsd = subs.reduce((t, g) => t + g.usd, 0);
    out.push(`  Every start, re-read at each step over ${r.days} days: ${formatUsd(total)}${subs.length ? ` (subagents ${formatUsd(subUsd)})` : ""}. Token counts are the API's; tool sizes are estimates from their length.`);
    if (r.gap && r.gap.tokens > 0) {
        out.push(`  Desktop app vs terminal: a Desktop session starts ~${formatTokens(r.gap.tokens)} tokens larger (median ${tok(r.gap.desktop)} against ${tok(r.gap.terminal)}): ${formatUsd(r.gap.usd)} of its starts' cost in ${r.days} days.`);
    }
    else if (r.gap) {
        out.push(`  Desktop app vs terminal: a Desktop session starts no larger here (median ${tok(r.gap.desktop)} against ${tok(r.gap.terminal)}).`);
    }
    else if (sessions.some((g) => g.entrypoint === "claude-desktop")) {
        out.push("  No terminal sessions in the period to compare the Desktop app's start with (#105328 reports ~79k against ~13k).");
    }
    // What could be deferred, and whether any setting reaches it.
    const servers = new Map();
    for (const g of r.groups)
        for (const s of g.servers) {
            const share = g.deferrableUsd ? (g.deferrableUsd * s.tokens * s.starts) / (g.servers.reduce((t, x) => t + x.tokens * x.starts, 0) || 1) : 0;
            const cur = servers.get(s.name);
            if (cur) {
                cur.usd += share;
                cur.starts += s.starts;
                cur.tokens = Math.max(cur.tokens, s.tokens);
                cur.tools = Math.max(cur.tools, s.tools);
            }
            else
                servers.set(s.name, { ...s, usd: share });
        }
    const list = [...servers.values()].sort((a, b) => b.usd - a.usd);
    if (list.length) {
        out.push("  MCP tool definitions sent whole (not deferred behind tool search):");
        for (const s of list.slice(0, 8)) {
            const where = s.configured ? `your ${s.configured === "user" ? "~/.claude.json" : s.configured === "project" ? "~/.claude.json (this project)" : ".mcp.json"}: \`alwaysLoad: false\` defers it` : "provided by the app or a connector";
            const name = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.name) ? `claude.ai connector ${s.name.slice(0, 8)}` : s.name;
            out.push(`    ${name.padEnd(28)} ${String(s.tools).padStart(3)} tools ${tok(s.tokens).padStart(6)}  ${formatUsd(s.usd).padStart(8)}  ${where}`);
        }
        if (list.length > 8)
            out.push(`    … ${list.length - 8} more`);
        const app = list.filter((s) => !s.configured);
        if (app.length) {
            out.push(`  No setting defers the ${app.length === 1 ? "server" : `${app.length} servers`} the app provides (${formatUsd(app.reduce((t, s) => t + s.usd, 0))} of the starts' cost): the Desktop app hands its own servers and connectors to Claude Code in-process with their tools marked to load upfront, and no MCP setting or ENABLE_TOOL_SEARCH value reaches them (tool search is on: the other tools are deferred). A subagent definition's \`tools:\` list or \`disallowedTools: mcp__*\` keeps them out of that agent's start, and out of its reach too.`);
        }
        if (list.some((s) => s.configured))
            out.push("  `context-doctor fix --apply mcp-defer` sets `alwaysLoad: false` on the ones in your own config (reversible with `fix undo mcp-defer`).");
    }
    else if (r.groups.some((g) => g.shaped > 0)) {
        out.push("  Every MCP tool definition was deferred behind tool search: nothing of the start to defer.");
    }
    return out;
}
