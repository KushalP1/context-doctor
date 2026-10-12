/**
 * `context-doctor reads`: the same files, read into session after session.
 *
 * Agents orient themselves by reading the same files at the start of most
 * sessions: the README, the main module, a config. Each read is written into
 * that session's context and re-read on every later request, and the next
 * session pays for it again. This counts Read calls across recent Claude Code
 * transcripts, groups them by file, and says per file whether a short summary
 * in the project's CLAUDE.md would pay (read in most of the project's
 * sessions) or not (CLAUDE.md is paid on every request, so an occasional read
 * is cheaper left as a read; `pack` can cut it to the part a question needs).
 */
import { forEachLine, listSessions } from "./session.js";
import { estimateTokens, formatTokens, realModel } from "./tokens.js";
import { CACHE_WRITE_5M, formatUsd, pricingFor } from "./pricing.js";
const CLAUDE = "claude-opus-5";
/** An image in a tool result bills as an image (~1.6k tokens for a full-size screenshot), not as its base64. */
const IMAGE_TOKENS = 1600;
function resultTokens(content) {
    if (typeof content === "string")
        return estimateTokens(content, CLAUDE);
    if (!Array.isArray(content))
        return estimateTokens(JSON.stringify(content ?? ""), CLAUDE);
    let n = 0;
    for (const part of content) {
        if (part?.type === "image")
            n += IMAGE_TOKENS;
        else if (typeof part?.text === "string")
            n += estimateTokens(part.text, CLAUDE);
        else
            n += estimateTokens(JSON.stringify(part ?? ""), CLAUDE);
    }
    return n;
}
/**
 * Read calls in one transcript: path -> reads, tokens and their cost floor,
 * plus the project directory and whether the session did anything after
 * `since`. Each read counts by its own timestamp (a session active today
 * does not bring last week's reads into `--days 1`), and a read already
 * counted from another transcript (a forked session copies its parent's
 * history) is not counted again. Rows without a timestamp count with their file.
 */
function sessionReads(path, since = 0, countedReads = new Set()) {
    const pending = new Map();
    const files = new Map();
    let cwd;
    let model;
    let active = false, dated = false;
    forEachLine(path, (line) => {
        // Activity in the window from any row's own timestamp, without parsing it.
        if (!active) {
            const ts = /"timestamp":"([^"]+)"/.exec(line);
            const at = ts ? Date.parse(ts[1]) : Number.NaN;
            if (Number.isFinite(at)) {
                dated = true;
                if (at >= since)
                    active = true;
            }
        }
        if (!line.includes('"tool_use"') && !line.includes('"tool_result"') && cwd !== undefined)
            return;
        let e;
        try {
            e = JSON.parse(line);
        }
        catch {
            return;
        }
        if (!e || e.isSidechain)
            return;
        if (!cwd && typeof e.cwd === "string")
            cwd = e.cwd;
        const content = e.message?.content;
        if (!Array.isArray(content))
            return;
        if (e.type === "assistant") {
            model = realModel(e.message.model) ?? model;
            for (const b of content) {
                if (b?.type === "tool_use" && b.name === "Read" && typeof b.input?.file_path === "string")
                    pending.set(b.id, { file: b.input.file_path, model });
            }
        }
        else if (e.type === "user") {
            const at = Date.parse(e.timestamp);
            if (Number.isFinite(at) && at < since)
                return;
            for (const b of content) {
                if (b?.type !== "tool_result")
                    continue;
                const call = pending.get(b.tool_use_id);
                if (!call)
                    continue;
                pending.delete(b.tool_use_id);
                if (countedReads.has(b.tool_use_id))
                    continue;
                countedReads.add(b.tool_use_id);
                const f = files.get(call.file) ?? { reads: 0, tokens: 0, usd: 0, priced: false };
                const tokens = resultTokens(b.content);
                f.reads++;
                f.tokens += tokens;
                // Priced at the model that read it, written to the cache once at the
                // 5-minute rate: a floor, since Claude Code mostly writes at 1 hour (2x).
                const price = pricingFor(call.model);
                if (price) {
                    f.usd += (tokens * CACHE_WRITE_5M * price.inputPerM) / 1e6;
                    f.priced = true;
                }
                files.set(call.file, f);
            }
        }
    });
    return { cwd, active: active || !dated || files.size > 0, files };
}
export function repeatedReads(days = 30, paths, minSessions = 3) {
    const since = Date.now() - days * 86_400_000;
    const list = paths ?? listSessions(10_000).filter((s) => s.path.includes(".claude") && s.modifiedAt.getTime() >= since).map((s) => s.path);
    // Keyed by project AND file: the same path read from two projects is two
    // findings, each against its own project's session count ("4/1 sessions"
    // came from counting every project's readers against one project's total).
    const byFile = new Map();
    const projectSessions = new Map();
    const countedReads = new Set();
    let reads = 0, readTokens = 0, sessions = 0;
    for (const p of list) {
        const s = sessionReads(p, since, countedReads);
        if (!s.active)
            continue;
        sessions++;
        const project = s.cwd ?? "?";
        projectSessions.set(project, (projectSessions.get(project) ?? 0) + 1);
        for (const [file, f] of s.files) {
            reads += f.reads;
            readTokens += f.tokens;
            const key = `${project}\u0000${file}`;
            const agg = byFile.get(key) ?? { path: file, project, sessions: 0, reads: 0, tokens: 0, usd: 0, priced: false };
            agg.sessions++;
            agg.reads += f.reads;
            agg.tokens += f.tokens;
            agg.usd += f.usd;
            agg.priced ||= f.priced;
            byFile.set(key, agg);
        }
    }
    const files = [...byFile.values()]
        .filter((a) => a.sessions >= minSessions)
        .map((a) => {
        const ps = projectSessions.get(a.project) ?? a.sessions;
        return {
            path: a.path,
            project: a.project,
            sessions: a.sessions,
            projectSessions: ps,
            reads: a.reads,
            tokens: a.tokens,
            usd: a.priced ? a.usd : undefined,
            // In most of the project's sessions: a summary in CLAUDE.md is read anyway, so it replaces the reads.
            advice: a.sessions / ps >= 0.5 ? "summarize" : "pack",
        };
    })
        .sort((a, b) => b.tokens - a.tokens);
    return { days, sessions, reads, readTokens, files };
}
export function renderReads(r, limit = 15, home = process.env.HOME ?? "") {
    const short = (p) => (home && p.startsWith(home) ? "~" + p.slice(home.length) : p);
    const out = ["FILES READ INTO SESSION AFTER SESSION", "═".repeat(56)];
    out.push(`Claude Code, last ${r.days} days: ${r.reads.toLocaleString("en-US")} file reads across ${r.sessions} sessions, ~${formatTokens(r.readTokens)} tokens.`);
    if (r.files.length === 0) {
        out.push("No file was read in 3 or more sessions. Nothing to consolidate.");
        return out.join("\n");
    }
    const repeated = r.files.reduce((s, f) => s + f.tokens, 0);
    out.push(`${r.files.length} files were read in 3+ sessions: ~${formatTokens(repeated)} tokens of reads (${Math.round((repeated / Math.max(1, r.readTokens)) * 100)}% of all read tokens).`, "");
    for (const f of r.files.slice(0, limit)) {
        const usd = f.usd !== undefined ? `  ≥${formatUsd(f.usd)}` : "";
        out.push(`  ${String(f.sessions).padStart(3)}/${f.projectSessions} sessions  ${String(f.reads).padStart(4)} reads  ~${formatTokens(f.tokens).padStart(6)}${usd.padEnd(10)}  ${short(f.path)}`);
    }
    if (r.files.length > limit)
        out.push(`  … ${r.files.length - limit} more (--json for all)`);
    const summarize = r.files.filter((f) => f.advice === "summarize").slice(0, 5);
    out.push("");
    if (summarize.length) {
        out.push(`Read in most of their project's sessions: ${summarize.map((f) => short(f.path)).join(", ")}.`, "   → A few lines in that project's CLAUDE.md saying what sessions need from each file replace most of these reads (CLAUDE.md is read on every request, so keep it to what is needed each time).");
    }
    out.push("   → For the rest, read the part a task needs: `pack_context` (MCP) or `context-doctor pack <file> -q \"…\"` returns the relevant chunks with line ranges.");
    out.push("   (≥ = floor of the cost: each read written to the prompt cache once; every later request of that session re-reads it too.)");
    return out.join("\n");
}
