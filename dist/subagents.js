/**
 * Subagent accounting.
 *
 * Every session profile here excludes subagent traffic, correctly: a subagent
 * has its own context window, so its tokens are not in the parent's context.
 * But they are on the parent's bill. Claude Code writes each subagent to its
 * own transcript under `<session>/subagents/agent-<id>.jsonl`, next to the
 * parent's `<session>.jsonl` — which is why scanning the parent for
 * `isSidechain` entries found nothing for weeks. On this machine: 195
 * subagents across 19 sessions whose final contexts sum to 28 million tokens,
 * none of it ever shown.
 *
 * Reads only the lines that matter (usage, first user turn, timestamps) and
 * never the whole content, so a session with 49 subagents stays fast.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { formatTokens } from "./tokens.js";
import { formatUsd, pricingFor } from "./pricing.js";
import { forEachLine } from "./session.js";
/** Where Claude Code keeps a session's subagents: beside the transcript, under its id. */
export function subagentDir(transcriptPath) {
    return join(transcriptPath.replace(/\.jsonl$/, ""), "subagents");
}
function n(v) {
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}
function summarize(path) {
    const s = {
        id: basename(path, ".jsonl").replace(/^agent-/, ""),
        task: "",
        calls: 0,
        finalContextTokens: 0,
        inputBilledTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
    };
    let first;
    let last;
    let cost = 0;
    let priced = true;
    forEachLine(path, (line) => {
        // Cheap pre-filter: most lines are content we do not need to parse.
        if (!line.includes('"usage"') && !line.includes('"timestamp"') && !s.task)
            return;
        let e;
        try {
            e = JSON.parse(line);
        }
        catch {
            return;
        }
        const at = Date.parse(String(e.timestamp ?? ""));
        if (Number.isFinite(at)) {
            first = first === undefined ? at : Math.min(first, at);
            last = last === undefined ? at : Math.max(last, at);
        }
        const m = e.message;
        if (!m)
            return;
        if (e.type === "user" && !s.task) {
            const c = m.content;
            const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (typeof b === "string" ? b : b?.text ?? "")).join(" ") : "";
            s.task = text.replace(/\s+/g, " ").trim().slice(0, 140);
        }
        if (e.type === "assistant" && m.usage) {
            const u = m.usage;
            const input = n(u.input_tokens);
            const read = n(u.cache_read_input_tokens);
            const write = n(u.cache_creation_input_tokens);
            const out = n(u.output_tokens);
            if (input + read + write === 0)
                return;
            if (typeof m.model === "string")
                s.model = m.model;
            s.calls++;
            s.finalContextTokens = input + read + write;
            s.inputBilledTokens += input + read + write;
            s.cacheReadTokens += read;
            s.outputTokens += out;
            const p = pricingFor(s.model);
            if (p) {
                // Cache writes bill at 1.25x input; reads at the cache-read rate.
                cost += ((input + write * 1.25) * p.inputPerM + read * p.cacheReadPerM + out * p.outputPerM) / 1_000_000;
            }
            else {
                priced = false;
            }
        }
    });
    if (first !== undefined && last !== undefined)
        s.durationMs = last - first;
    if (priced && s.calls > 0)
        s.estCostUsd = cost;
    return s;
}
/** Account for every subagent of a session, or null when there are none. */
export function subagentReport(transcriptPath) {
    const dir = subagentDir(transcriptPath);
    if (!existsSync(dir))
        return null;
    let files;
    try {
        files = readdirSync(dir).filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"));
    }
    catch {
        return null;
    }
    if (files.length === 0)
        return null;
    const agents = files
        .map((f) => join(dir, f))
        .filter((p) => {
        try {
            return statSync(p).size > 0;
        }
        catch {
            return false;
        }
    })
        .map(summarize)
        .filter((a) => a.calls > 0)
        .sort((a, b) => (b.estCostUsd ?? 0) - (a.estCostUsd ?? 0) || b.inputBilledTokens - a.inputBilledTokens);
    if (agents.length === 0)
        return null;
    return {
        agents,
        totalInputBilled: agents.reduce((t, a) => t + a.inputBilledTokens, 0),
        totalOutput: agents.reduce((t, a) => t + a.outputTokens, 0),
        totalCostUsd: agents.reduce((t, a) => t + (a.estCostUsd ?? 0), 0),
        unpriced: agents.filter((a) => a.estCostUsd === undefined).length,
    };
}
function fmtDuration(ms) {
    if (ms === undefined)
        return "";
    if (ms >= 3_600_000)
        return `${(ms / 3_600_000).toFixed(1)}h`;
    if (ms >= 60_000)
        return `${(ms / 60_000).toFixed(0)}m`;
    return `${(ms / 1000).toFixed(0)}s`;
}
/**
 * @param parentInputUsd what the PARENT session's input actually cost across
 *   all its calls (from the cache analysis), so the comparison is total against
 *   total. Comparing against a per-call figure produced nonsense like "159x".
 */
export function renderSubagents(report, parentInputUsd, top = 5) {
    if (!report)
        return null;
    const lines = [];
    lines.push("Subagents (their own windows, your bill)");
    lines.push("─".repeat(56));
    const cost = report.unpriced === 0 ? formatUsd(report.totalCostUsd) : `${formatUsd(report.totalCostUsd)}+ (${report.unpriced} unpriced)`;
    lines.push(`${report.agents.length} subagent(s) made ${report.agents.reduce((t, a) => t + a.calls, 0)} API calls: ` +
        `${formatTokens(report.totalInputBilled)} input billed, ${formatTokens(report.totalOutput)} output, ~${cost}.`);
    if (parentInputUsd !== undefined && parentInputUsd > 0 && report.totalCostUsd > 0) {
        const ratio = report.totalCostUsd / parentInputUsd;
        lines.push(ratio >= 1
            ? `That is ${ratio.toFixed(1)}x what the parent session's own input cost (${formatUsd(parentInputUsd)}). None of it appears in the profile above.`
            : `That is ${Math.round(ratio * 100)}% on top of the parent session's own input cost (${formatUsd(parentInputUsd)}), and none of it appears in the profile above.`);
    }
    for (const a of report.agents.slice(0, top)) {
        const cost = a.estCostUsd !== undefined ? formatUsd(a.estCostUsd) : "unpriced";
        lines.push(`  ${cost.padStart(8)}  ${String(a.calls).padStart(3)} calls  ctx ${formatTokens(a.finalContextTokens).padStart(6)}  ${fmtDuration(a.durationMs).padStart(4)}  ${a.task.slice(0, 60) || "(no task text)"}`);
    }
    if (report.agents.length > top)
        lines.push(`  … and ${report.agents.length - top} more`);
    const heavy = report.agents.filter((a) => a.finalContextTokens > 200_000);
    if (heavy.length > 0) {
        lines.push(`${heavy.length} subagent(s) ended above 200k tokens of context. A subagent that big is doing a main session's job; ` +
            "give it a narrower brief, or split the task.");
    }
    return lines.join("\n");
}
