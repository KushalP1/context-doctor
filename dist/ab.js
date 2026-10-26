/**
 * `context-doctor ab`: does a lever cost quality? Each task of a small suite
 * (abtasks.ts) runs with and without the lever, through the Messages API,
 * with a minimal agent loop (read_file, write_file, run_check), and is
 * scored by its own test, run by the harness after the agent stops. Pass
 * counts, tokens and cost per arm, side by side: "no quality loss" as a
 * number rather than a proxy (re-reads, tool errors, corrections).
 *
 * Arms:
 *   none             the baseline: a plain system prompt and the three tools
 *   rules            + the standing context rules (what MCP clients and the
 *                    Copilot hook inject) in the system prompt
 *   autoclear        the client wrapped with withContextDoctor (autopilot in
 *                    process), every request treated as after an idle gap so
 *                    clearing is allowed on each one: the worst case for
 *                    quality, not autopilot's real cost
 *   pack             + a pack_context tool and the rule to use it for big
 *                    files instead of reading them whole
 *   compact-generic  one compaction mid-task with generic instructions
 *   compact          the same compaction with the PreCompact hook's
 *                    instructions (files changed, failing checks, the user's
 *                    own instructions) added, as Claude Code merges them
 *
 * It spends the caller's API budget, so the CLI prints the estimate first,
 * needs --yes to send anything, and stops starting requests at --budget.
 * The provider is an interface: anthropicProvider() speaks the Messages API
 * over fetch (this package has no runtime dependencies), and tests plug in a
 * local mock server through ANTHROPIC_BASE_URL.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AB_TASKS } from "./abtasks.js";
import { AutoClearer } from "./autoclear.js";
import { packContext, renderPack } from "./pack.js";
import { compactFacts, compactInstructions } from "./precompact.js";
import { formatUsd, pricingFor, usageCost, CACHE_WRITE_5M } from "./pricing.js";
import { SERVER_INSTRUCTIONS } from "./rules.js";
import { estimateTokens, formatTokens } from "./tokens.js";
import { contextDoctorStats, withContextDoctor } from "./wrap.js";
export const AB_LEVERS = ["rules", "autoclear", "pack", "compact"];
export const DEFAULT_AB_MODEL = "claude-opus-5-5";
/** The Messages API version the harness sends (sampling parameters are not sent). */
export const AB_API_VERSION = "2026-10-21";
/** What each lever is compared against, and what it is. */
const LEVER_INFO = {
    rules: { base: "none", arm: "rules", what: "the standing context rules in the system prompt (what MCP clients and the Copilot hook add)" },
    autoclear: { base: "none", arm: "autoclear", what: "autopilot in process (withContextDoctor), stale tool output cleared whenever the batch is big enough, as if every request came after an idle gap" },
    pack: { base: "none", arm: "pack", what: "a pack_context tool and the rule to use it for big files instead of reading them whole" },
    compact: { base: "compact-generic", arm: "compact", what: "one compaction mid-task, with the PreCompact hook's instructions vs generic ones" },
};
/**
 * The Messages API over fetch. Retries what the API asks to be retried
 * (429, 5xx, 529 overloaded, network errors) with backoff, honouring
 * retry-after; anything else is the caller's error and is thrown with its
 * status, so the SDK wrapper can recognise a refused history edit.
 */
export function anthropicProvider(options) {
    const base = (options.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "");
    const retries = options.retries ?? 4;
    return {
        name: `Anthropic Messages API (${base})`,
        async create(body) {
            for (let attempt = 0;; attempt++) {
                let status = 0;
                let text = "";
                let retryAfter = null;
                try {
                    const res = await fetch(`${base}/v1/messages`, {
                        method: "POST",
                        headers: { "content-type": "application/json", "x-api-key": options.apiKey, "anthropic-version": AB_API_VERSION },
                        body: JSON.stringify(body),
                        signal: AbortSignal.timeout(options.timeoutMs ?? 600_000),
                    });
                    status = res.status;
                    text = await res.text();
                    retryAfter = res.headers.get("retry-after");
                    if (res.ok)
                        return JSON.parse(text);
                }
                catch (e) {
                    if (attempt >= retries)
                        throw e;
                }
                const retryable = status === 0 || status === 429 || status === 529 || status >= 500;
                if (!retryable || attempt >= retries) {
                    let message = text.slice(0, 500);
                    try {
                        message = JSON.parse(text)?.error?.message ?? message;
                    }
                    catch { /* not JSON */ }
                    let error;
                    try {
                        error = JSON.parse(text);
                    }
                    catch {
                        error = text;
                    }
                    throw Object.assign(new Error(`HTTP ${status}: ${message}`), { status, error });
                }
                const wait = retryAfter && Number(retryAfter) > 0 ? Number(retryAfter) * 1000 : 1000 * 2 ** attempt;
                await new Promise((r) => setTimeout(r, Math.min(wait, 60_000)));
            }
        },
    };
}
// -- The agent's tools ---------------------------------------------------------
const CHECK_FILE = "test.mjs";
const BASE_TOOLS = [
    {
        name: "read_file",
        description: "Read one file of the repository, whole. `path` is relative to the repository root.",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    {
        name: "write_file",
        description: "Write one whole file of the repository, replacing what is there (folders are created). test.mjs, the check, cannot be changed.",
        input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    },
    {
        name: "run_check",
        description: "Run the task's check, `node test.mjs`, and return its output and exit code. The task is done when it exits 0.",
        input_schema: { type: "object", properties: {} },
    },
];
const PACK_TOOL = {
    name: "pack_context",
    description: "Only the parts of the repository's files that a question needs, ranked and cut to ~1,500 tokens, instead of reading them whole. `paths` limits it to some files.",
    input_schema: { type: "object", properties: { question: { type: "string" }, paths: { type: "array", items: { type: "string" } } }, required: ["question"] },
};
const BASE_SYSTEM = "You are a careful software engineer working in a small JavaScript repository through tools. Make the smallest correct change. " +
    "When you think the task is done, call run_check; once it passes, reply with one sentence saying what you changed.";
const PACK_RULE = "To answer from a big file you won't edit, call pack_context with the question; don't read it whole.";
const GENERIC_COMPACTION = "Your context is being compacted. Write a summary of this session that lets the work continue without it: the request, what you found, " +
    "what you changed, what is still failing, and what remains to do. Reply with the summary only; do not call tools.";
/** The repository path a tool names, or undefined when it leaves the repository. */
function inside(dir, path) {
    if (typeof path !== "string" || path === "" || isAbsolute(path))
        return undefined;
    const full = resolve(dir, path);
    const rel = relative(dir, full);
    return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? undefined : full;
}
function filesUnder(dir, root = dir) {
    return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? filesUnder(full, root) : [relative(root, full).split(sep).join("/")];
    });
}
function runCheck(dir) {
    const r = spawnSync(process.execPath, [CHECK_FILE], { cwd: dir, encoding: "utf8", timeout: 30_000 });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    return { code: r.status ?? 1, output: output.length > 3000 ? "…" + output.slice(-3000) : output };
}
function execute(block, dir, allowPack, counts) {
    const id = String(block.id ?? "");
    const fail = (content) => ({ type: "tool_result", tool_use_id: id, content, is_error: true });
    const input = block.input ?? {};
    try {
        switch (block.name) {
            case "read_file": {
                const path = inside(dir, input.path);
                if (!path)
                    return fail(`not a path inside the repository: ${String(input.path)}`);
                return { type: "tool_result", tool_use_id: id, content: readFileSync(path, "utf8") };
            }
            case "write_file": {
                const path = inside(dir, input.path);
                if (!path)
                    return fail(`not a path inside the repository: ${String(input.path)}`);
                if (relative(dir, path).split(sep).join("/") === CHECK_FILE)
                    return fail("test.mjs is the check and cannot be changed");
                if (typeof input.content !== "string")
                    return fail("content must be a string");
                mkdirSync(dirname(path), { recursive: true });
                writeFileSync(path, input.content);
                return { type: "tool_result", tool_use_id: id, content: `wrote ${Buffer.byteLength(input.content)} bytes to ${String(input.path)}` };
            }
            case "run_check": {
                const r = runCheck(dir);
                return { type: "tool_result", tool_use_id: id, content: `${r.output}\nexit code ${r.code}`, ...(r.code !== 0 ? { is_error: true } : {}) };
            }
            case "pack_context": {
                if (!allowPack)
                    return fail("no such tool");
                counts.pack++;
                const wanted = Array.isArray(input.paths) ? input.paths.map(String) : undefined;
                const sources = filesUnder(dir)
                    .filter((p) => !wanted || wanted.includes(p))
                    .map((p) => ({ name: p, text: readFileSync(join(dir, p), "utf8") }));
                return { type: "tool_result", tool_use_id: id, content: renderPack(packContext(sources, { query: String(input.question ?? ""), budget: 1500 })) };
            }
            default:
                return fail(`no such tool: ${String(block.name)}`);
        }
    }
    catch (e) {
        return fail(e.message);
    }
}
/** Autopilot with every request as if after an idle gap: clearing is allowed on each one. */
class ColdEveryRequest extends AutoClearer {
    clock = 0;
    apply(body, _now, modelHint, account) {
        this.clock += 2 * 3_600_000;
        return super.apply(body, this.clock, modelHint, account);
    }
}
/** The harness's history as a Claude Code transcript, the shape the PreCompact hook reads. */
function asTranscript(messages) {
    const rename = (b) => {
        if (b.type !== "tool_use")
            return b;
        if (b.name === "write_file")
            return { ...b, name: "Write", input: { file_path: b.input?.path } };
        if (b.name === "run_check")
            return { ...b, name: "Bash", input: { command: "npm test" } };
        return b;
    };
    return messages
        .map((m) => JSON.stringify(m.role === "assistant"
        ? { type: "assistant", message: { role: "assistant", content: m.content.map(rename) } }
        : { type: "user", message: { role: "user", content: m.content } }))
        .join("\n") + "\n";
}
function taskPrompt(task) {
    const list = Object.keys(task.files)
        .sort()
        .map((p) => `- ${p} (${(Buffer.byteLength(task.files[p]) / 1024).toFixed(1)} KB)`)
        .join("\n");
    return `Repository files:\n${list}\n\nTask: ${task.prompt}`;
}
function systemFor(arm) {
    if (arm === "rules")
        return `${BASE_SYSTEM}\n\n${SERVER_INSTRUCTIONS}`;
    if (arm === "pack")
        return `${BASE_SYSTEM}\n\n${PACK_RULE}`;
    return BASE_SYSTEM;
}
async function runOne(task, arm, rep, ctx) {
    const started = Date.now();
    const dir = mkdtempSync(join(tmpdir(), `ctxdoc-ab-${task.id}-`));
    for (const [p, text] of Object.entries(task.files)) {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), text);
    }
    const run = { task: task.id, arm, rep, pass: false, stop: "", requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0, wallMs: 0, leverUses: 0, leverTokens: 0 };
    const raw = { messages: { create: (body) => ctx.provider.create(body) } };
    const client = arm === "autoclear" ? withContextDoctor(raw, { clearer: new ColdEveryRequest({ keepRecent: 1, minClearTokens: 1000 }) }) : raw;
    const system = systemFor(arm);
    const tools = arm === "pack" ? [...BASE_TOOLS, PACK_TOOL] : BASE_TOOLS;
    const prompt = taskPrompt(task);
    const counts = { pack: 0 };
    const send = async (messages, extra = {}) => {
        const res = await client.messages.create({ model: ctx.model, max_tokens: 16000, system, tools, messages, cache_control: { type: "ephemeral" }, ...extra });
        run.requests++;
        const u = res.usage ?? {};
        const n = (v) => (typeof v === "number" && v > 0 ? v : 0);
        run.inputTokens += n(u.input_tokens);
        run.cacheReadTokens += n(u.cache_read_input_tokens);
        run.cacheWriteTokens += n(u.cache_creation_input_tokens);
        run.outputTokens += n(u.output_tokens);
        const cost = usageCost(u, ctx.pricing).totalUsd;
        run.costUsd += cost;
        ctx.spent += cost;
        if (!Array.isArray(res.content))
            throw new Error("the response has no content array");
        return res;
    };
    let messages = [{ role: "user", content: prompt }];
    let compacted = false;
    try {
        for (;;) {
            if (run.requests >= ctx.maxTurns) {
                run.stop = "turns";
                break;
            }
            if (ctx.spent >= ctx.budgetUsd) {
                run.stop = "budget";
                break;
            }
            const res = await send(messages);
            messages.push({ role: "assistant", content: res.content });
            if (res.stop_reason !== "tool_use") {
                run.stop = res.stop_reason ?? "end_turn";
                break;
            }
            const results = res.content.filter((b) => b.type === "tool_use").map((b) => execute(b, dir, arm === "pack", counts));
            messages.push({ role: "user", content: results });
            if ((arm === "compact" || arm === "compact-generic") && !compacted && run.requests >= ctx.compactAfter) {
                compacted = true;
                let instructions = "";
                if (arm === "compact") {
                    const transcriptDir = mkdtempSync(join(tmpdir(), "ctxdoc-ab-transcript-"));
                    try {
                        const path = join(transcriptDir, "session.jsonl");
                        writeFileSync(path, asTranscript(messages));
                        instructions = compactInstructions(compactFacts(path));
                    }
                    finally {
                        rmSync(transcriptDir, { recursive: true, force: true });
                    }
                }
                const ask = [...messages.slice(0, -1), { role: "user", content: [...results, { type: "text", text: instructions ? `${GENERIC_COMPACTION}\n\n${instructions}` : GENERIC_COMPACTION }] }];
                if (ctx.spent >= ctx.budgetUsd) {
                    run.stop = "budget";
                    break;
                }
                const summary = (await send(ask, { tool_choice: { type: "none" } })).content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
                run.leverUses++;
                messages = [{ role: "user", content: `${prompt}\n\nThis session was compacted to save context. Summary of the work so far:\n\n${summary}\n\nContinue the task from here.` }];
            }
        }
    }
    catch (e) {
        run.stop = "error";
        run.error = e.message.slice(0, 300);
    }
    // The verdict is the check as shipped: the agent cannot write test.mjs, and it is restored anyway.
    writeFileSync(join(dir, CHECK_FILE), task.files[CHECK_FILE]);
    run.pass = runCheck(dir).code === 0;
    rmSync(dir, { recursive: true, force: true });
    if (arm === "autoclear") {
        const stats = contextDoctorStats(client);
        run.leverUses = stats?.changed ?? 0;
        run.leverTokens = stats?.tokensRemoved ?? 0;
    }
    if (arm === "pack")
        run.leverUses = counts.pack;
    run.wallMs = Date.now() - started;
    return run;
}
// -- The suite ---------------------------------------------------------------
/** The arms a set of levers needs: one shared baseline for rules, autoclear and pack; compact brings its own. */
export function armsFor(levers) {
    const arms = [];
    if (levers.some((l) => l !== "compact"))
        arms.push("none");
    for (const l of levers) {
        if (l === "compact")
            arms.push("compact-generic", "compact");
        else
            arms.push(l);
    }
    return [...new Set(arms)];
}
/**
 * A planning figure, not a quote: six requests a run, the task's files in
 * context from the second request on, ~800 output tokens a request (thinking,
 * tool calls, the files the agent writes).
 */
export function estimateAb(tasks, arms, repeat, pricing) {
    const R = 6;
    const OUT = 800;
    const base = estimateTokens(BASE_SYSTEM + SERVER_INSTRUCTIONS + JSON.stringify([...BASE_TOOLS, PACK_TOOL]), "claude");
    let expected = 0;
    let upper = 0;
    for (const task of tasks) {
        const files = Object.values(task.files).reduce((n, t) => n + estimateTokens(t, "claude"), 0) + estimateTokens(task.prompt, "claude");
        let context = 0;
        for (let i = 1; i <= R; i++) {
            const next = base + (i >= 2 ? files : 0) + (i - 1) * OUT;
            const fresh = next - context;
            expected += (fresh * pricing.inputPerM * CACHE_WRITE_5M + context * pricing.cacheReadPerM + OUT * pricing.outputPerM) / 1e6;
            upper += (next * pricing.inputPerM + OUT * pricing.outputPerM) / 1e6;
            context = next;
        }
    }
    const per = arms.length * repeat;
    return { runs: tasks.length * per, expectedUsd: expected * per, upperUsd: upper * per };
}
export async function runAbSuite(options) {
    const model = options.model ?? DEFAULT_AB_MODEL;
    const pricing = pricingFor(model);
    if (!pricing)
        throw new Error(`no price is known for ${model}: ab needs one to estimate and cap the spend`);
    const tasks = options.tasks ?? AB_TASKS;
    const levers = [...(options.levers ?? AB_LEVERS)];
    const arms = armsFor(levers);
    const repeat = options.repeat ?? 1;
    const ctx = {
        provider: options.provider,
        model,
        pricing,
        maxTurns: options.maxTurns ?? 16,
        budgetUsd: options.budgetUsd ?? Infinity,
        compactAfter: options.compactAfter ?? 2,
        spent: 0,
    };
    const queue = [];
    for (let rep = 1; rep <= repeat; rep++)
        for (const task of tasks)
            for (const arm of arms)
                queue.push({ task, arm, rep });
    const runs = new Array(queue.length);
    let next = 0;
    let done = 0;
    const worker = async () => {
        while (next < queue.length) {
            const i = next++;
            const { task, arm, rep } = queue[i];
            runs[i] = await runOne(task, arm, rep, ctx);
            options.onRun?.(runs[i], ++done, queue.length);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 4, queue.length)) }, worker));
    return { model, provider: options.provider.name, tasks: tasks.map((t) => t.id), levers, arms, repeat, runs, spentUsd: ctx.spent };
}
// -- The report ----------------------------------------------------------------
/** Ends that say nothing about the lever: the API failed or declined, or the harness's own caps cut the run. */
const STOPPED_EARLY = new Set(["error", "budget", "turns", "refusal", "max_tokens"]);
function totals(runs) {
    return runs.reduce((t, r) => ({
        runs: t.runs + 1,
        passed: t.passed + (r.pass ? 1 : 0),
        tokens: t.tokens + r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens + r.outputTokens,
        costUsd: t.costUsd + r.costUsd,
        stoppedEarly: t.stoppedEarly + (STOPPED_EARLY.has(r.stop) ? 1 : 0),
        leverUses: t.leverUses + r.leverUses,
        leverTokens: t.leverTokens + r.leverTokens,
    }), { runs: 0, passed: 0, tokens: 0, costUsd: 0, stoppedEarly: 0, leverUses: 0, leverTokens: 0 });
}
/** Per arm: runs, passes, billed tokens (prompt incl. cache, plus output), cost. */
export function summarizeAb(result) {
    return Object.fromEntries(result.arms.map((arm) => [arm, totals(result.runs.filter((r) => r.arm === arm))]));
}
const pct = (a, b) => (b > 0 ? `${a >= b ? "+" : ""}${(((a - b) / b) * 100).toFixed(0)}%` : "");
export function renderAb(result) {
    const out = [];
    out.push(`A/B quality: ${result.tasks.length} tasks, ${result.model}, ${result.repeat} run${result.repeat === 1 ? "" : "s"} per task and arm; ${formatUsd(result.spentUsd)} spent`);
    const cell = (runs) => {
        const t = totals(runs);
        const verdict = t.runs === 1 ? (runs[0].pass ? "PASS" : runs[0].stop === "error" ? "ERROR" : "FAIL") : `${t.passed}/${t.runs}`;
        return `${verdict.padEnd(6)}${formatTokens(t.runs ? t.tokens / t.runs : 0).padStart(6)} ${formatUsd(t.runs ? t.costUsd / t.runs : 0).padStart(7)}`;
    };
    for (const lever of result.levers) {
        const { base, arm, what } = LEVER_INFO[lever];
        out.push("", `${lever}: ${what}`);
        out.push(`${"task".padEnd(18)}${base.padEnd(23)}${arm}`);
        for (const id of result.tasks) {
            const of = (a) => result.runs.filter((r) => r.task === id && r.arm === a);
            out.push(`${id.padEnd(18)}${cell(of(base)).padEnd(23)}${cell(of(arm))}`);
        }
        const b = totals(result.runs.filter((r) => r.arm === base));
        const l = totals(result.runs.filter((r) => r.arm === arm));
        out.push(`${"passed".padEnd(18)}${`${b.passed}/${b.runs}`.padEnd(23)}${l.passed}/${l.runs}`);
        out.push(`${"tokens per run".padEnd(18)}${formatTokens(b.runs ? b.tokens / b.runs : 0).padEnd(23)}${formatTokens(l.runs ? l.tokens / l.runs : 0)} (${pct(l.tokens / (l.runs || 1), b.tokens / (b.runs || 1))})`);
        out.push(`${"cost".padEnd(18)}${formatUsd(b.costUsd).padEnd(23)}${formatUsd(l.costUsd)} (${pct(l.costUsd, b.costUsd)})`);
        const used = lever === "autoclear" ? `requests autopilot changed: ${l.leverUses}, tokens it kept off the wire: ${formatTokens(l.leverTokens)}`
            : lever === "pack" ? `pack_context calls: ${l.leverUses}`
                : lever === "compact" ? `compactions: ${b.leverUses} generic, ${l.leverUses} with the hook's instructions`
                    : "rules in every request's system prompt";
        out.push(`${"lever".padEnd(18)}${used}`);
        if (b.stoppedEarly + l.stoppedEarly > 0)
            out.push(`${"stopped early".padEnd(18)}${String(b.stoppedEarly).padEnd(23)}${l.stoppedEarly} (API error or refusal, budget, turn or token cap: not a quality result)`);
        const diff = l.passed - b.passed;
        out.push(diff === 0 ? `Same pass count with and without ${lever}.`
            : diff > 0 ? `${diff} more pass${diff === 1 ? "" : "es"} with ${lever}.`
                : `${-diff} fewer pass${diff === -1 ? "" : "es"} with ${lever}: read those runs before trusting the lever.`);
    }
    out.push("", result.repeat < 3 ? "One task's difference is noise at this size: --repeat 3 or more for a figure worth publishing." : `${result.repeat} runs per task and arm.`);
    return out.join("\n");
}
/** `context-doctor ab`: the exit code (1 for a refusal, a bad argument, or a suite where every run errored). */
export async function abCommand(o) {
    const say = (line) => (o.json ? console.error(line) : console.log(line));
    if (o.list) {
        console.log("Tasks (each a tiny repository and its own test):");
        for (const t of AB_TASKS)
            console.log(`  ${t.id.padEnd(16)} ${t.title}${t.bigFile ? ` (big file: ${t.bigFile})` : ""}`);
        console.log("\nLevers (each run against its baseline arm):");
        for (const l of AB_LEVERS)
            console.log(`  ${l.padEnd(10)} ${LEVER_INFO[l].what}`);
        return 0;
    }
    const leverNames = (o.levers ?? []).flatMap((l) => l.split(",")).map((l) => l.trim()).filter(Boolean);
    const unknownLever = leverNames.find((l) => l !== "all" && !AB_LEVERS.includes(l));
    if (unknownLever) {
        console.error(`Unknown lever "${unknownLever}". Levers: ${AB_LEVERS.join(", ")}, or all.`);
        return 1;
    }
    const levers = leverNames.length === 0 || leverNames.includes("all") ? [...AB_LEVERS] : [...new Set(leverNames)];
    const taskIds = (o.tasks ?? []).flatMap((t) => t.split(",")).map((t) => t.trim()).filter(Boolean);
    const unknownTask = taskIds.find((id) => !AB_TASKS.some((t) => t.id === id));
    if (unknownTask) {
        console.error(`Unknown task "${unknownTask}". Tasks: ${AB_TASKS.map((t) => t.id).join(", ")} (context-doctor ab --list).`);
        return 1;
    }
    const tasks = taskIds.length ? AB_TASKS.filter((t) => taskIds.includes(t.id)) : AB_TASKS;
    const model = o.model ?? DEFAULT_AB_MODEL;
    const pricing = pricingFor(model);
    if (!pricing) {
        console.error(`No price is known for ${model}, so ab cannot estimate or cap what it spends. Pick a model in the price table (e.g. ${DEFAULT_AB_MODEL}, claude-sonnet-5-5).`);
        return 1;
    }
    const repeat = o.repeat ?? 1;
    const arms = armsFor(levers);
    const est = estimateAb(tasks, arms, repeat, pricing);
    const budget = o.budgetUsd ?? Math.max(1, Math.ceil(est.upperUsd * 1.25));
    const base = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "");
    say(`A/B quality suite: ${tasks.length} task${tasks.length === 1 ? "" : "s"} x ${arms.length} arms (${arms.join(", ")}) x ${repeat} = ${est.runs} runs on ${model}`);
    say(`Through the Anthropic Messages API at ${base}${process.env.ANTHROPIC_BASE_URL ? " (ANTHROPIC_BASE_URL)" : ""}.`);
    say(`Estimated cost: ~${formatUsd(est.expectedUsd)} with prompt caching, up to ~${formatUsd(est.upperUsd)} if nothing caches. Requests stop once ${formatUsd(budget)} is spent (--budget).`);
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
        console.error("ab sends these runs to the Messages API and bills the key in ANTHROPIC_API_KEY, which is not set. Nothing was sent.");
        return 1;
    }
    if (!o.yes) {
        say(`Nothing was sent. Run again with --yes to spend up to ${formatUsd(budget)}.`);
        return 0;
    }
    const result = await runAbSuite({
        provider: anthropicProvider({ apiKey: key }),
        model,
        tasks,
        levers,
        repeat,
        maxTurns: o.maxTurns,
        budgetUsd: budget,
        concurrency: o.concurrency,
        onRun: (r, done, total) => console.error(`[${done}/${total}] ${r.task} · ${r.arm} · ${r.pass ? "PASS" : "FAIL"} · ${r.requests} requests · ${formatTokens(r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens + r.outputTokens)} tokens · ${formatUsd(r.costUsd)}${r.error ? ` · ${r.error}` : ""}`),
    });
    const json = JSON.stringify({ ...result, summary: summarizeAb(result) }, null, 2);
    if (o.out)
        writeFileSync(o.out, json + "\n");
    if (o.json)
        console.log(json);
    else
        console.log("\n" + renderAb(result) + (o.out ? `\n\nEvery run, as JSON: ${o.out}` : ""));
    return result.runs.length > 0 && result.runs.every((r) => r.stop === "error") ? 1 : 0;
}
