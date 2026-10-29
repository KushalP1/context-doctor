/**
 * A synthetic Claude Code history with every shape the history reports read,
 * for the golden tests of the shared scan (scan.ts): long sessions with
 * compactions (automatic and idle), cold returns, cache misses and
 * just-too-late re-writes, a model switch, edited contexts, API errors,
 * Read results (some failing), repeated identical calls, MCP tools, a
 * skill, slash commands, typed-while-working prompts, corrections, thinking
 * blocks, a reply written as several rows, a fork that copies its parent,
 * subagents, an older session only the 60-day check reaches, a desktop-app
 * session, a CRLF file, a malformed row and a last line still being written.
 *
 * Deterministic: a seeded generator, fixed times before FIXTURE_NOW (the
 * reports run with the clock frozen there, see `frozenClock`), and every
 * file's modification time set to its last row, since `listSessions` orders
 * transcripts by it. Only the home folder's path differs between builds,
 * and only in the rows' `cwd` (message content never holds it: its size is
 * what the replays price); `normalizeOutput` takes it out of a report.
 */
import { appendFileSync, mkdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const FIXTURE_NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const DAY = 86_400_000;
const MIN = 60_000;
/** Node arguments that freeze `Date` at `now` in a child process (as the reports see it). */
export function frozenClock(now = FIXTURE_NOW) {
    const src = `const T=${now};const R=Date;class D extends R{constructor(...a){if(a.length===0)super(T);else super(...a)}static now(){return T}}globalThis.Date=D;`;
    return ["--import", `data:text/javascript,${encodeURIComponent(src)}`];
}
/** A report with the fixture's home folder (as given and as resolved) replaced by "~". */
export function normalizeOutput(text, home) {
    let real = home;
    try {
        real = realpathSync(home);
    }
    catch { /* as given */ }
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const forms = [...new Set([real, home, JSON.stringify(real).slice(1, -1), JSON.stringify(home).slice(1, -1)])].sort((a, b) => b.length - a.length);
    const out = forms.reduce((t, f) => t.replace(new RegExp(esc(f), "g"), "~"), text);
    // Windows writes the same paths with backslashes (escaped in JSON).
    return process.platform === "win32" ? out.replace(/\\\\/g, "/").replace(/\\/g, "/") : out;
}
function rng(seed) {
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** Text of a Read result: code-like or prose, long enough to matter. */
function fileText(r, n) {
    const code = r() < 0.5;
    const line = code ? "export function f(x: number): number { return x * 2 + (x >> 1); }\n" : "The quick brown fox jumps over the lazy dog, again and again.\n";
    return line.repeat(n);
}
const PROMPTS = ["Add the retry to the uploader", "no, that's wrong: keep the old signature", "Run the tests again", "why did you delete the cache?", "Looks good, continue", "again?", "Refactor the parser into two files", "I said use the existing helper"];
/** One session's rows, request by request. */
function sessionRows(s, cwd) {
    const r = rng(s.seed);
    const rows = [];
    let t = s.start;
    let ctx = 30_000 + Math.floor(r() * 20_000);
    let prevAt;
    let n = 0;
    let lastBash = "";
    const base = (extra) => ({
        ...(s.sidechain ? { isSidechain: true } : {}),
        cwd,
        sessionId: s.id,
        version: s.version ?? "2.1.300",
        entrypoint: s.entrypoint ?? "cli",
        ...extra,
    });
    const iso = (ms) => new Date(ms).toISOString();
    for (let i = 0; i < s.requests; i++) {
        const model = s.switchTo && i >= s.switchTo.at ? s.switchTo.model : s.model ?? "claude-opus-5-5";
        // Gaps: mostly a minute or two, then a pause past the 5-minute cache, an
        // hour and a minute (just too late), and a long break (a cold return).
        const g = r();
        const gap = g < 0.75 ? 20_000 + r() * 100_000 : g < 0.85 ? 6 * MIN : g < 0.92 ? 61 * MIN + r() * 30_000 : g < 0.97 ? 3 * 60 * MIN : 30 * MIN;
        t += Math.round(gap);
        if (!s.sidechain && (i === 0 || r() < 0.3)) {
            const text = PROMPTS[Math.floor(r() * PROMPTS.length)];
            if (i > 0 && r() < 0.15) {
                rows.push(JSON.stringify(base({ type: "attachment", uuid: `${s.id}-q${n++}`, timestamp: iso(t - 5_000), attachment: { type: "queued_command", prompt: text, commandMode: "prompt" } })));
            }
            else if (r() < 0.1) {
                rows.push(JSON.stringify(base({ type: "user", uuid: `${s.id}-u${n++}`, timestamp: iso(t - 4_000), message: { role: "user", content: i % 2 ? "<command-name>/review</command-name>" : "<command-name>/mcp__github__pr</command-name>" } })));
            }
            else {
                rows.push(JSON.stringify(base({ type: "user", uuid: `${s.id}-u${n++}`, timestamp: iso(t - 4_000), message: { role: "user", content: i === 0 ? [{ type: "text", text }] : text } })));
            }
            if (r() < 0.1)
                rows.push(JSON.stringify(base({ type: "user", isMeta: true, uuid: `${s.id}-m${n++}`, timestamp: iso(t - 3_000), message: { role: "user", content: "<local-command-stdout>ok</local-command-stdout>" } })));
        }
        if (r() < 0.04)
            rows.push(JSON.stringify(base({ type: "system", subtype: "api_error", uuid: `${s.id}-e${n++}`, timestamp: iso(t - 2_000), content: "overloaded" })));
        // The cache: cold after an hour (5 minutes for 5-minute writes), else a read of what was there.
        const ttl = s.oneHour === false ? 5 * MIN : 60 * MIN;
        const cold = prevAt === undefined || t - prevAt > ttl;
        const added = 2_000 + Math.floor(r() * 25_000);
        const miss = !cold && r() < 0.08;
        const read = cold || miss ? 0 : ctx;
        const write = cold || miss ? ctx + added : added;
        ctx += added;
        const usage = {
            input_tokens: 3 + Math.floor(r() * 40),
            cache_creation_input_tokens: write,
            cache_read_input_tokens: read,
            output_tokens: 50 + Math.floor(r() * 900),
            cache_creation: s.oneHour === false ? { ephemeral_5m_input_tokens: write, ephemeral_1h_input_tokens: 0 } : { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write },
            service_tier: "standard",
        };
        if (r() < 0.2)
            usage.output_tokens_details = { thinking_tokens: Math.floor(Number(usage.output_tokens) / 3) };
        if (r() < 0.05)
            usage.context_management = { applied_edits: [{ type: "clear_tool_uses_20250919", cleared_input_tokens: 5000 }] };
        const id = `msg_${s.id}_${i}`;
        // Tools: a Read, a poll that may repeat the last command, an MCP call, now and then a skill or ToolSearch.
        const tools = [];
        const pick = r();
        if (pick < 0.35)
            tools.push({ type: "tool_use", id: `tu_${s.id}_${i}_r`, name: "Read", input: { file_path: `/work/app/src/file${Math.floor(r() * 6)}.ts` } });
        else if (pick < 0.6) {
            const cmd = r() < 0.5 && lastBash ? lastBash : `sleep 30 && tail -n ${Math.floor(r() * 4)} build.log`;
            lastBash = cmd;
            tools.push({ type: "tool_use", id: `tu_${s.id}_${i}_b`, name: "Bash", input: { command: cmd } });
        }
        else if (pick < 0.7)
            tools.push({ type: "tool_use", id: `tu_${s.id}_${i}_m`, name: "mcp__github__get_issue", input: { number: Math.floor(r() * 3) } });
        else if (pick < 0.74)
            tools.push({ type: "tool_use", id: `tu_${s.id}_${i}_s`, name: "Skill", input: { skill: "pdf" } });
        else if (pick < 0.78)
            tools.push({ type: "tool_use", id: `tu_${s.id}_${i}_t`, name: "ToolSearch", input: { query: "github" } });
        else if (pick < 0.8)
            tools.push({ type: "tool_use", id: `tu_${s.id}_${i}_x`, name: "ListMcpResourcesTool", input: { server: "github" } });
        const thinking = r() < 0.2 ? [{ type: "thinking", thinking: "Considering the options. ".repeat(20), signature: "sig" }] : [];
        const blocks = [...thinking, { type: "text", text: `Step ${i}: ${"working on it ".repeat(1 + Math.floor(r() * 30))}` }, ...tools];
        // A reply is written as one row per content block, each with the reply's usage.
        blocks.forEach((b, k) => {
            rows.push(JSON.stringify(base({ type: "assistant", uuid: `${s.id}-a${n++}`, timestamp: iso(t + k * 300), message: { id, type: "message", role: "assistant", model, content: [b], usage } })));
        });
        for (const tu of tools) {
            const err = r() < 0.12;
            const content = tu.name === "Read" && !err ? fileText(r, 20 + Math.floor(r() * 200)) : err ? "Error: file not found" : `ok ${Math.floor(r() * 5)}`;
            rows.push(JSON.stringify(base({ type: "user", uuid: `${s.id}-r${n++}`, timestamp: iso(t + 2_000), message: { role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content, ...(err ? { is_error: true } : {}) }] } })));
        }
        prevAt = t;
        t += 3_000;
        if (s.compactAt?.includes(i) || s.idleAt?.includes(i)) {
            const idle = s.idleAt?.includes(i);
            if (idle)
                t += 70 * MIN;
            rows.push(JSON.stringify(base({ type: "system", subtype: "compact_boundary", uuid: `${s.id}-c${n++}`, timestamp: iso(t), content: "Conversation compacted", compactMetadata: { trigger: idle ? "manual" : "auto", preTokens: ctx } })));
            if (idle)
                rows.push(JSON.stringify(base({ type: "system", uuid: `${s.id}-i${n++}`, timestamp: iso(t + 100), content: "Compacted while idle to keep the session warm" })));
            rows.push(JSON.stringify(base({ type: "user", isCompactSummary: true, uuid: `${s.id}-cs${n++}`, timestamp: iso(t + 200), message: { role: "user", content: "This session is being continued from a previous conversation." } })));
            ctx = 40_000 + Math.floor(r() * 10_000);
        }
    }
    return { rows, end: t };
}
const project = (home) => join(home, ".claude", "projects", "-work-app");
function write(path, rows, mtime, opts = {}) {
    mkdirSync(join(path, ".."), { recursive: true });
    const nl = opts.crlf ? "\r\n" : "\n";
    writeFileSync(path, rows.join(nl) + nl + (opts.partial ?? ""));
    utimesSync(path, mtime / 1000, mtime / 1000);
}
const SPECS = (now) => [
    { id: "s1", start: now - 20 * DAY, requests: 70, seed: 1, compactAt: [30], idleAt: [55] },
    { id: "s2", start: now - 12 * DAY, requests: 45, seed: 2, switchTo: { at: 25, model: "claude-sonnet-5" }, oneHour: false, version: "2.1.309" },
    { id: "s3", start: now - 6 * DAY, requests: 30, seed: 3, entrypoint: "claude-desktop", compactAt: [18] },
    { id: "s4", start: now - 3 * DAY, requests: 26, seed: 4, model: "claude-fable-5-1", version: "2.1.309" },
    { id: "s5", start: now - 2 * DAY, requests: 8, seed: 5 },
    { id: "old", start: now - 45 * DAY, requests: 50, seed: 6, compactAt: [20, 35] },
    { id: "crlf", start: now - 9 * DAY, requests: 14, seed: 7, oneHour: false },
    { id: "live", start: now - 1 * DAY, requests: 22, seed: 8 },
];
/** Write the history under `home`: ~/.claude/projects, a subagent's transcript, an MCP config, a limits log. */
export function buildHistory(home, now = FIXTURE_NOW) {
    const cwd = join(home, "work", "app");
    mkdirSync(join(cwd, "src"), { recursive: true });
    const specs = SPECS(now);
    const made = new Map();
    for (const s of specs)
        made.set(s.id, sessionRows(s, cwd));
    for (const s of specs) {
        const { rows, end } = made.get(s.id);
        const path = join(project(home), `${s.id}.jsonl`);
        if (s.id === "crlf")
            write(path, rows, end, { crlf: true });
        else if (s.id === "live")
            write(path, [...rows.slice(0, 10), "{not json", ...rows.slice(10, -1)], end, { partial: rows[rows.length - 1].slice(0, 120) });
        else
            write(path, rows, end);
    }
    // A fork: s1's first 40 rows copied (same uuids, same ids), then its own requests.
    const fork = sessionRows({ id: "fk", start: now - 19 * DAY, requests: 16, seed: 9 }, cwd);
    write(join(project(home), "fork.jsonl"), [...made.get("s1").rows.slice(0, 40), ...fork.rows], fork.end);
    // Subagents of s4: 5-minute writes, a cheaper model, every row a sidechain row.
    const subDir = join(project(home), "s4", "subagents");
    for (const [k, seed] of [[1, 11], [2, 12]]) {
        const sub = sessionRows({ id: `agent${k}`, start: now - 3 * DAY + k * 10 * MIN, requests: 12, seed, model: "claude-sonnet-5", oneHour: false, sidechain: true }, cwd);
        write(join(subDir, `agent-a${k}.jsonl`), sub.rows, sub.end);
        writeFileSync(join(subDir, `agent-a${k}.meta.json`), JSON.stringify({ agentType: "general-purpose", description: `task ${k}` }));
    }
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { github: { command: "github-mcp", args: [] }, unused: { command: "unused-mcp" } } }));
    // Five-hour window readings, as the status line records them.
    const limits = [];
    for (let i = 0; i < 40; i++)
        limits.push(JSON.stringify({ ts: now - 4 * DAY + i * 2 * 3_600_000, app: "claude", w: "five_hour", pct: (i * 7) % 100, reset: Math.round((now - 4 * DAY + (Math.floor(i / 2) + 1) * 5 * 3_600_000) / 1000) }));
    writeFileSync(join(home, ".claude", ".context-doctor-limits.jsonl"), limits.join("\n") + "\n");
}
/** Claude Code keeps writing: the live session's last line completes and more requests follow; a subagent and s5 grow. */
export function growHistory(home, now = FIXTURE_NOW) {
    const cwd = join(home, "work", "app");
    const live = sessionRows(SPECS(now).find((s) => s.id === "live"), cwd);
    const last = live.rows[live.rows.length - 1];
    const more = sessionRows({ id: "live2", start: live.end + 10 * MIN, requests: 9, seed: 21 }, cwd);
    const livePath = join(project(home), "live.jsonl");
    appendFileSync(livePath, last.slice(120) + "\n" + more.rows.join("\n") + "\n");
    utimesSync(livePath, more.end / 1000, more.end / 1000);
    const s5 = sessionRows({ id: "s5b", start: now - 2 * DAY + 6 * 3_600_000, requests: 7, seed: 22 }, cwd);
    const s5Path = join(project(home), "s5.jsonl");
    appendFileSync(s5Path, s5.rows.join("\n") + "\n");
    utimesSync(s5Path, s5.end / 1000, s5.end / 1000);
    const sub = sessionRows({ id: "agent1b", start: now - 2 * DAY, requests: 4, seed: 23, model: "claude-sonnet-5", oneHour: false, sidechain: true }, cwd);
    const subPath = join(project(home), "s4", "subagents", "agent-a1.jsonl");
    appendFileSync(subPath, sub.rows.join("\n") + "\n");
    utimesSync(subPath, sub.end / 1000, sub.end / 1000);
}
/** The reports compared byte for byte, text and JSON (each run from the fixture's project folder). */
export const GOLDEN_COMMANDS = [
    ["fix"],
    ["fix", "--json"],
    ["savings"],
    ["savings", "--json"],
    ["cache-misses"],
    ["cache-misses", "--json"],
    ["compact-window"],
    ["compact-window", "--json"],
    ["compactions"],
    ["overhead"],
    ["overhead", "--json"],
    ["overhead", "prune"],
    ["cache-ttl"],
    ["cache-ttl", "--json"],
    ["limits", "--json"],
];
