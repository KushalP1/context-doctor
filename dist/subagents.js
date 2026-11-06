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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { formatTokens } from "./tokens.js";
import { formatUsd, pricingFor, usageCost } from "./pricing.js";
import { forEachLine, outputSettler, replyCounter } from "./session.js";
import { realModel } from "./tokens.js";
/** Where Claude Code keeps a session's subagents: beside the transcript, under its id. */
export function subagentDir(transcriptPath) {
    return join(transcriptPath.replace(/\.jsonl$/, ""), "subagents");
}
/**
 * Every subagent transcript of a session: the Agent tool's
 * (`subagents/agent-*.jsonl`) and the workflow agents'
 * (`subagents/workflows/<run>/agent-*.jsonl`, one folder per workflow run,
 * the run's own record in `<session>/workflows/<run>.json`). Workflow agents
 * bill to the session like any subagent, and every reader skipped their
 * folder: on the author's machine, 804 transcripts and ~$1,354 in 30 days.
 * `since`: only files written since then. `run`: the workflow run's id.
 */
export function subagentFiles(transcriptPath, since = -Infinity) {
    const dir = subagentDir(transcriptPath);
    const out = [];
    const add = (file, run) => {
        try {
            if (since === -Infinity || statSync(file).mtimeMs >= since)
                out.push(run ? { file, run } : { file });
        }
        catch { /* gone */ }
    };
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return out;
    }
    for (const f of names)
        if (f.endsWith(".jsonl"))
            add(join(dir, f));
    if (!names.includes("workflows"))
        return out;
    let runs;
    try {
        runs = readdirSync(join(dir, "workflows"));
    }
    catch {
        return out;
    }
    for (const run of runs) {
        let agents;
        try {
            agents = readdirSync(join(dir, "workflows", run));
        }
        catch {
            continue;
        }
        for (const f of agents)
            if (f.endsWith(".jsonl"))
                add(join(dir, "workflows", run, f), run);
    }
    return out;
}
/** The workflow run a subagent transcript belongs to (its folder under subagents/workflows), or undefined. */
export function workflowRunOf(file) {
    return /[\\/]subagents[\\/]workflows[\\/]([^\\/]+)[\\/][^\\/]+\.jsonl$/.exec(file)?.[1];
}
/** A workflow run's own record, `<session>/workflows/<run>.json`: its name and default model, when Claude Code wrote one. */
export function workflowRunInfo(transcriptPath, run) {
    try {
        const j = JSON.parse(readFileSync(join(transcriptPath.replace(/\.jsonl$/, ""), "workflows", `${run}.json`), "utf8"));
        const s = (v) => (typeof v === "string" && v ? v.slice(0, 80) : undefined);
        return { ...(s(j?.workflowName) ? { name: s(j.workflowName) } : {}), ...(s(j?.defaultModel) ? { model: s(j.defaultModel) } : {}), ...(s(j?.status) ? { status: s(j.status) } : {}) };
    }
    catch {
        return {};
    }
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
    // One reply is written as several rows with the same usage; counting rows
    // doubled the calls and the bill (a real session: 6156 calls / $769 per
    // row against 3228 / $387 per reply).
    const sighting = replyCounter();
    const settle = outputSettler();
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
            const seen = sighting(e);
            if (seen === "repeat") {
                // A later row of the same reply: only its final output count is new.
                const more = settle(e, false);
                const p = more ? pricingFor(s.model) : undefined;
                s.outputTokens += more;
                if (p)
                    cost += (more * p.outputPerM) / 1_000_000;
                return;
            }
            if (seen !== "new")
                return;
            settle(e, true);
            s.model = realModel(m.model) ?? s.model;
            s.calls++;
            s.finalContextTokens = input + read + write;
            s.inputBilledTokens += input + read + write;
            s.cacheReadTokens += read;
            s.outputTokens += out;
            const p = pricingFor(s.model);
            if (p) {
                // Subagents write at the 5-minute TTL (1.25x), the main thread mostly
                // at 1 hour (2x); the usage records which.
                cost += usageCost(u, p).totalUsd;
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
    // The Agent tool's subagents and the workflow agents alike: both bill to this session.
    const found = subagentFiles(transcriptPath).filter((f) => basename(f.file).startsWith("agent-"));
    if (found.length === 0)
        return null;
    const runOf = new Map(found.map((f) => [f.file, f.run]));
    const summarized = found
        .map((f) => f.file)
        .filter((p) => {
        try {
            return statSync(p).size > 0;
        }
        catch {
            return false;
        }
    })
        .map((p) => ({ s: summarize(p), run: runOf.get(p) }))
        .filter((a) => a.s.calls > 0)
        .sort((a, b) => (b.s.estCostUsd ?? 0) - (a.s.estCostUsd ?? 0) || b.s.inputBilledTokens - a.s.inputBilledTokens);
    const agents = summarized.map((a) => a.s);
    if (agents.length === 0)
        return null;
    const runs = new Set(summarized.flatMap((a) => (a.run ? [a.run] : [])));
    return {
        agents,
        totalInputBilled: agents.reduce((t, a) => t + a.inputBilledTokens, 0),
        totalOutput: agents.reduce((t, a) => t + a.outputTokens, 0),
        totalCostUsd: agents.reduce((t, a) => t + (a.estCostUsd ?? 0), 0),
        unpriced: agents.filter((a) => a.estCostUsd === undefined).length,
        ...(runs.size ? { workflowAgents: summarized.filter((a) => a.run).length, workflowRuns: runs.size } : {}),
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
export function renderSubagents(report, parentInputUsd, top = 5, options = {}) {
    if (!report)
        return null;
    const lines = [];
    lines.push("Subagents (their own windows, your bill)");
    lines.push("─".repeat(56));
    const cost = report.unpriced === 0 ? formatUsd(report.totalCostUsd) : `${formatUsd(report.totalCostUsd)}+ (${report.unpriced} unpriced)`;
    lines.push(`${report.agents.length} subagent(s) made ${report.agents.reduce((t, a) => t + a.calls, 0)} API calls: ` +
        `${formatTokens(report.totalInputBilled)} input billed, ${formatTokens(report.totalOutput)} output, ~${cost}.`);
    if (report.workflowAgents)
        lines.push(`${report.workflowAgents} of them are workflow agents, in ${report.workflowRuns} workflow run${report.workflowRuns === 1 ? "" : "s"}.`);
    if (parentInputUsd !== undefined && parentInputUsd > 0 && report.totalCostUsd > 0) {
        const ratio = report.totalCostUsd / parentInputUsd;
        lines.push(ratio >= 1
            ? `That is ${ratio.toFixed(1)}x what the parent session's own input cost (${formatUsd(parentInputUsd)}). None of it appears in the profile above.`
            : `That is ${Math.round(ratio * 100)}% on top of the parent session's own input cost (${formatUsd(parentInputUsd)}), and none of it appears in the profile above.`);
    }
    for (const a of report.agents.slice(0, top)) {
        const cost = a.estCostUsd !== undefined ? formatUsd(a.estCostUsd) : "unpriced";
        const task = options.redact ? "[redacted]" : a.task.slice(0, 60) || "(no task text)";
        lines.push(`  ${cost.padStart(8)}  ${String(a.calls).padStart(3)} calls  ctx ${formatTokens(a.finalContextTokens).padStart(6)}  ${fmtDuration(a.durationMs).padStart(4)}  ${task}`);
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
