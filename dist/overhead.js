/**
 * `context-doctor overhead`: what every request pays before you type.
 *
 * Each request an agent sends re-sends the same front matter: the harness's
 * system prompt, tool and MCP schemas, skills, and the memory files the user
 * wrote (CLAUDE.md and its imports, rules, auto memory, AGENTS.md, Cursor
 * rules, GEMINI.md). It is cached, so each read is cheap, but it is read on
 * every request of every session, and at full write price after every cold
 * start. Nobody sees it: transcripts do not contain it.
 *
 * Two measurements, both local:
 *  - the fixed overhead itself, from the first request of each Claude Code
 *    session (the API's own count, minus the first user message);
 *  - the memory files that load in a directory, sized with Claude's ratios and
 *    priced per month from the user's own request and cold-start counts.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { forEachLine, listSessions } from "./session.js";
import { estimateTokens, formatTokens } from "./tokens.js";
import { formatUsd, pricingFor } from "./pricing.js";
import { claudeMcpConfigs, mcpUsage, measureServer, toolPrefixName } from "./mcpschema.js";
const TTL_MS = 3_600_000;
const CLAUDE = "claude-opus-5"; // Claude's tokenizer ratios; the model only picks the provider here.
function readText(path) {
    try {
        if (!statSync(path).isFile())
            return undefined;
        return readFileSync(path, "utf8");
    }
    catch {
        return undefined;
    }
}
/** Directories from `cwd` up to (and including) the filesystem root. */
function ancestors(cwd) {
    const out = [];
    let d = resolve(cwd);
    for (;;) {
        out.push(d);
        const up = dirname(d);
        if (up === d)
            return out;
        d = up;
    }
}
function mdFiles(dir, ext = /\.md$/) {
    const out = [];
    try {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory())
                out.push(...mdFiles(p, ext));
            else if (ext.test(e.name))
                out.push(p);
        }
    }
    catch {
        /* absent */
    }
    return out.sort();
}
/** `@path` imports in a CLAUDE.md, outside code spans and fences, resolved relative to the file. */
function imports(text, from, home) {
    const out = [];
    let fence = false;
    for (const line of text.split("\n")) {
        if (/^\s*(```|~~~)/.test(line))
            fence = !fence;
        if (fence)
            continue;
        for (const m of line.replace(/`[^`]*`/g, "").matchAll(/(?:^|\s)@((?:~\/|\.{0,2}\/|[\w.-]+\/)[^\s)]+|[\w.-]+\.\w+)/g)) {
            const raw = m[1];
            out.push(raw.startsWith("~/") ? join(home, raw.slice(2)) : isAbsolute(raw) ? raw : resolve(dirname(from), raw));
        }
    }
    return out;
}
/** Claude Code's auto-memory index for a directory (it loads MEMORY.md, first 200 lines). */
function autoMemoryPath(cwd, home) {
    return join(home, ".claude", "projects", resolve(cwd).replace(/[^A-Za-z0-9]/g, "-"), "memory", "MEMORY.md");
}
/** Every memory file the four agents load for a session started in `cwd`. */
export function findMemoryFiles(cwd = process.cwd(), home = homedir()) {
    const files = [];
    const seen = new Set();
    const add = (agent, path, via, text) => {
        const key = `${agent}:${resolve(path)}`;
        if (seen.has(key))
            return undefined;
        text ??= readText(path);
        if (text === undefined || !text.trim())
            return undefined;
        seen.add(key);
        files.push({ agent, path, via, tokens: estimateTokens(text, CLAUDE) });
        return text;
    };
    const addClaude = (path, via, depth = 0) => {
        const text = add("Claude Code", path, via);
        if (text === undefined || depth >= 4)
            return;
        for (const p of imports(text, path, home))
            addClaude(p, "import", depth + 1);
    };
    // Claude Code: user memory and rules, then each directory from the root down.
    addClaude(join(home, ".claude", "CLAUDE.md"), "user");
    for (const p of mdFiles(join(home, ".claude", "rules")))
        addClaude(p, "rules");
    for (const d of ancestors(cwd).reverse()) {
        addClaude(join(d, "CLAUDE.md"), "project");
        addClaude(join(d, ".claude", "CLAUDE.md"), "project");
        addClaude(join(d, "CLAUDE.local.md"), "project (local)");
        if (d !== home)
            for (const p of mdFiles(join(d, ".claude", "rules")))
                addClaude(p, "rules");
    }
    const auto = readText(autoMemoryPath(cwd, home));
    if (auto)
        add("Claude Code", autoMemoryPath(cwd, home), "auto memory", auto.split("\n").slice(0, 200).join("\n"));
    // Codex: global AGENTS.md, then each directory down to cwd (it stops at the git root; root-ward extras are rare).
    add("Codex", join(home, ".codex", "AGENTS.md"), "user");
    for (const d of ancestors(cwd).reverse()) {
        if (d === home)
            continue;
        add("Codex", join(d, "AGENTS.override.md"), "project") ?? add("Codex", join(d, "AGENTS.md"), "project");
    }
    // Cursor: legacy .cursorrules and always-applied project rules.
    add("Cursor", join(cwd, ".cursorrules"), "project");
    for (const p of mdFiles(join(cwd, ".cursor", "rules"), /\.mdc?$/)) {
        const text = readText(p) ?? "";
        if (/^alwaysApply:\s*true/m.test(text))
            add("Cursor", p, "rules (always)", text);
    }
    // Gemini CLI: global, then each directory down to cwd.
    add("Gemini CLI", join(home, ".gemini", "GEMINI.md"), "user");
    for (const d of ancestors(cwd).reverse())
        if (d !== home)
            add("Gemini CLI", join(d, "GEMINI.md"), "project");
    return files;
}
/**
 * Fixed overhead per session, measured: the first main-chain request's input
 * (input + cache read + cache write) minus the first user message, plus the
 * request and cold-start counts that turn tokens into a monthly bill.
 */
export function measureBaseline(days = 30, paths) {
    const since = Date.now() - days * 86_400_000;
    const files = paths ?? listSessions(10_000).filter((s) => s.path.includes(".claude") && s.modifiedAt.getTime() >= since).map((s) => s.path);
    const firsts = [];
    let requests = 0, coldStarts = 0;
    const models = new Map();
    for (const path of files) {
        let firstUser;
        let first;
        let lastId;
        let prevAt;
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
            if (e.type === "user" && first === undefined && firstUser === undefined && !e.isMeta) {
                const c = e.message?.content;
                const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
                if (text)
                    firstUser = text;
                return;
            }
            if (e.type !== "assistant" || !e.message?.usage || e.message.id === lastId)
                return;
            lastId = e.message.id;
            const u = e.message.usage;
            const prompt = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            const at = Date.parse(e.timestamp);
            if (!(prompt > 0) || !Number.isFinite(at))
                return;
            if (first === undefined)
                first = Math.max(0, prompt - estimateTokens(firstUser ?? "", CLAUDE));
            if (at >= since) {
                requests++;
                if (prevAt === undefined || at - prevAt > TTL_MS)
                    coldStarts++;
                if (e.message.model)
                    models.set(e.message.model, (models.get(e.message.model) ?? 0) + 1);
            }
            prevAt = at;
        });
        if (first !== undefined && first > 1000)
            firsts.push(first);
    }
    if (firsts.length === 0)
        return undefined;
    firsts.sort((a, b) => a - b);
    const model = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const price = pricingFor(model);
    // Each overhead token is a cache read on warm requests and a cache write
    // (1.25x input) after every cold start.
    const usdPerKPerMonth = price
        ? ((1000 * ((requests - coldStarts) * price.cacheReadPerM + coldStarts * 1.25 * price.inputPerM)) / 1e6) * (30 / days)
        : undefined;
    return {
        sessions: firsts.length,
        median: firsts[Math.floor(firsts.length / 2)],
        p90: firsts[Math.min(firsts.length - 1, Math.floor(firsts.length * 0.9))],
        requests,
        coldStarts,
        days,
        model,
        usdPerKPerMonth,
    };
}
function normalize(s) {
    return s.toLowerCase().replace(/\s+/g, " ").trim();
}
/** What is worth changing in the memory files. */
export function overheadFindings(files, baseline) {
    const out = [];
    const cost = (tok) => (baseline?.usdPerKPerMonth ? ` (~${formatUsd((tok / 1000) * baseline.usdPerKPerMonth)}/month at your usage)` : "");
    for (const f of files) {
        if (f.tokens >= 2000) {
            out.push({
                severity: f.tokens >= 5000 ? "warn" : "info",
                message: `${f.path} is ~${formatTokens(f.tokens)} tokens, read on every ${f.agent} request${f.agent === "Claude Code" ? cost(f.tokens) : ""}.`,
                suggestion: `Keep rules the agent needs on most requests; move reference material to a file it reads when relevant. \`context-doctor overhead split ${f.path}\` shows the split first.`,
            });
        }
    }
    // Paragraphs repeated across files of the same agent load twice.
    const byPara = new Map();
    for (const f of files) {
        const text = readText(f.path) ?? "";
        for (const p of text.split(/\n\s*\n/)) {
            const n = normalize(p);
            if (n.length < 120)
                continue;
            const k = `${f.agent}\u0000${n}`;
            (byPara.get(k) ?? byPara.set(k, new Set()).get(k)).add(f.path);
        }
    }
    const dup = new Map();
    for (const [k, set] of byPara) {
        if (set.size < 2)
            continue;
        const key = [...set].sort().join(" + ");
        const d = dup.get(key) ?? { tokens: 0, count: 0 };
        d.tokens += estimateTokens(k.split("\u0000")[1], CLAUDE) * (set.size - 1);
        d.count++;
        dup.set(key, d);
    }
    for (const [key, d] of dup) {
        out.push({
            severity: "info",
            message: `${d.count} paragraph(s) appear in more than one loaded file (${key}): ~${formatTokens(d.tokens)} tokens read twice.`,
            suggestion: "Keep each rule in one file.",
        });
    }
    // Big fenced blocks: examples and reference code rarely need to ride on every request.
    for (const f of files) {
        const text = readText(f.path) ?? "";
        let total = 0;
        for (const m of text.matchAll(/```[\s\S]*?```/g))
            total += estimateTokens(m[0], CLAUDE);
        if (total >= 800) {
            out.push({
                severity: "info",
                message: `${f.path} carries ~${formatTokens(total)} tokens of code blocks.`,
                suggestion: "Move long examples to a file the agent opens when the task needs them.",
            });
        }
    }
    return out;
}
export function overheadReport(opts = {}) {
    const cwd = opts.cwd ?? process.cwd();
    const home = opts.home ?? homedir();
    const files = findMemoryFiles(cwd, home);
    const baseline = measureBaseline(opts.days ?? 30, opts.paths);
    const mcp = { configs: claudeMcpConfigs(cwd, home), usage: mcpUsage(opts.days ?? 30, opts.paths) };
    return { cwd, baseline, files, findings: overheadFindings(files, baseline), mcp };
}
/** Launch each configured server and size its tool definitions, then add the findings they support. */
export async function measureMcpSizes(r) {
    r.mcp.sizes = await Promise.all(r.mcp.configs.map((c) => measureServer(c)));
    r.findings.push(...mcpFindings(r.mcp, r.baseline));
}
/** Configured servers nobody called: their definitions ride on every request for nothing. */
export function mcpFindings(m, baseline) {
    const out = [];
    const deferred = m.usage.sessions > 0 && m.usage.toolSearchSessions / m.usage.sessions >= 0.5;
    for (const c of m.configs) {
        const size = m.sizes?.find((s) => s.name === c.name);
        const calls = m.usage.calls.get(toolPrefixName(c.name)) ?? 0;
        const tokens = size?.schemaTokens === undefined ? undefined : deferred ? size.nameTokens : size.schemaTokens;
        if (calls > 0 || tokens === undefined || tokens < 200)
            continue;
        const usd = baseline?.usdPerKPerMonth ? ` (~${formatUsd((tokens / 1000) * baseline.usdPerKPerMonth)}/month)` : "";
        out.push({
            severity: tokens >= 2000 ? "warn" : "info",
            message: `MCP server "${c.name}" (${c.scope}) was not called in ${m.usage.sessions} sessions, yet adds ~${formatTokens(tokens)} tokens to every request${deferred ? " even deferred" : ""}${usd}.`,
            suggestion: `Remove it where you do not use it (claude mcp remove ${c.name}${c.scope === "user" ? " -s user" : ""}), or scope it to the projects that need it.`,
        });
    }
    return out;
}
export function renderOverhead(r, home = homedir()) {
    const out = [];
    const short = (p) => (p.startsWith(home) ? "~" + p.slice(home.length) : relative(r.cwd, p) || p);
    out.push("FIXED OVERHEAD: what every request re-reads before your message", "═".repeat(56));
    const b = r.baseline;
    const claudeTokens = r.files.filter((f) => f.agent === "Claude Code").reduce((s, f) => s + f.tokens, 0);
    if (b) {
        out.push(`Claude Code, last ${b.days} days: ${b.sessions} sessions start at a median ~${formatTokens(b.median)} tokens (p90 ~${formatTokens(b.p90)}) before the first message.`, `Memory files loaded here are ~${formatTokens(claudeTokens)} of that; the rest is Claude Code's system prompt, tools, skills and MCP schemas.`);
        if (b.usdPerKPerMonth !== undefined) {
            out.push(`At your usage (${b.requests.toLocaleString("en-US")} requests, ${b.coldStarts.toLocaleString("en-US")} cold starts, ${b.model} list prices) every 1k tokens of it costs ~${formatUsd(b.usdPerKPerMonth)} a month;`, `the whole overhead ~${formatUsd((b.median / 1000) * b.usdPerKPerMonth)} a month.`);
        }
    }
    else {
        out.push("No Claude Code sessions in the period to measure; memory files are sized below.");
    }
    out.push(...renderMcp(r));
    out.push("", "Memory files loaded in this directory", "─".repeat(56));
    if (r.files.length === 0)
        out.push("  none");
    for (const f of r.files) {
        const usd = f.agent === "Claude Code" && b?.usdPerKPerMonth !== undefined ? `  ${formatUsd((f.tokens / 1000) * b.usdPerKPerMonth)}/mo` : "";
        out.push(`  ${f.agent.padEnd(11)} ~${formatTokens(f.tokens).padStart(5)}${usd.padEnd(12)}  ${short(f.path)}${f.via === "project" ? "" : `  (${f.via})`}`);
    }
    out.push("", `Findings (${r.findings.length})`, "─".repeat(56));
    if (r.findings.length === 0)
        out.push("  Nothing to trim. The memory files are lean.");
    for (const f of r.findings)
        out.push(`${f.severity === "warn" ? "▲" : "ℹ"} ${f.message.replace(home, "~")}`, `   → ${f.suggestion}`);
    return out.join("\n");
}
function renderMcp(r) {
    const { configs, usage, sizes } = r.mcp;
    if (configs.length === 0 && usage.calls.size === 0)
        return [];
    const out = ["", "MCP servers", "─".repeat(56)];
    const deferred = usage.sessions > 0 && usage.toolSearchSessions / usage.sessions >= 0.5;
    out.push(deferred
        ? `Tool search was used in ${usage.toolSearchSessions} of ${usage.sessions} sessions: Claude Code defers MCP definitions, so a server costs about its tool names until the model looks one up.`
        : `Tool search was used in ${usage.toolSearchSessions} of ${usage.sessions} sessions: MCP definitions mostly load in full, on every request.`);
    const configured = new Set(configs.map((c) => toolPrefixName(c.name)));
    for (const c of configs) {
        const s = sizes?.find((x) => x.name === c.name);
        const calls = usage.calls.get(toolPrefixName(c.name)) ?? 0;
        const size = !sizes
            ? "size: run with --mcp"
            : s?.error
                ? s.error
                : `${s.tools} tools, ~${formatTokens(s.schemaTokens)} tokens of definitions (names ~${formatTokens(s.nameTokens)})`;
        out.push(`  ${c.name.padEnd(22)} ${c.scope.padEnd(9)} ${String(calls).padStart(6)} calls  ${size}`);
    }
    const app = [...usage.calls.entries()].filter(([n]) => !configured.has(n)).sort((a, b) => b[1] - a[1]);
    if (app.length) {
        out.push(`  Provided by the app or connectors (not in your config; toggle them in the app):`);
        for (const [n, calls] of app.slice(0, 10))
            out.push(`  ${n.padEnd(38)} ${String(calls).padStart(6)} calls`);
        if (app.length > 10)
            out.push(`  … ${app.length - 10} more`);
    }
    if (!sizes && configs.length)
        out.push(`  \`context-doctor overhead --mcp\` launches the ${configs.length} configured server(s) once to size their definitions.`);
    return out;
}
