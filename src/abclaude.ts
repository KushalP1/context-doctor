/**
 * `context-doctor ab --via claude-code`: the A/B suite's tasks run through
 * the person's own Claude Code (`claude -p`), on the person's own sign-in,
 * one arm per model. No API key: on a claude.ai plan the runs draw on the
 * plan's usage limits, not dollars. It answers the question the subagent
 * lever (`fix`'s subagent-model) could not: does Sonnet 5.5 do the work Opus
 * 5.5 did, here, on this plan?
 *
 * Each run gets a fresh temporary copy of the task's tiny repository and one
 * `claude -p` in it, with every flag verified on Claude Code 2.1.311, 2.1.321
 * and 2.1.325 against a local mock Messages API (docs/ab.md):
 *
 *   --print, the prompt on stdin       (no positional after a variadic flag)
 *   --model <id>                       the arm
 *   --output-format stream-json --verbose
 *                                      the init event (version, tools, auth
 *                                      source), rate_limit_event, and the
 *                                      result: total_cost_usd, usage, num_turns
 *   --max-turns <n>                    (hidden; result subtype error_max_turns)
 *   --restricted                       file tools confined to the working
 *                                      directory; user, project and local
 *                                      settings ignored (their hooks and
 *                                      permission rules too)
 *   --safe-mode                        no CLAUDE.md, skills, plugins, hooks,
 *                                      MCP servers, agents or output styles
 *   --strict-mcp-config                no MCP server at all
 *   --disable-slash-commands
 *   --no-session-persistence           no transcript in ~/.claude/projects
 *                                      (nothing for the reports to count)
 *   --tools Read,Edit,Write,Glob,Grep,Bash
 *   --allowedTools "Read Edit Write Glob Grep Bash(node test.mjs)"
 *   --disallowedTools "Edit(test.mjs) Write(test.mjs)"
 *   --permission-mode dontAsk --permission-prompts none
 *                                      anything not allowed above is denied,
 *                                      nobody is asked
 *   --settings {"sandbox":{...}}       Claude Code's sandbox on, failing
 *                                      closed: the code `node test.mjs` runs
 *                                      cannot write outside the run folder
 *                                      and temp, or reach the network
 *   --max-budget-usd <usd>             only with --budget
 *
 * The hidden check scores the run as the Messages API arms are scored. The
 * tokens and cost are Claude Code's own (the result's usage and
 * total_cost_usd: on a plan, the list-price equivalent). A run past its time
 * limit is killed with its process group; Ctrl-C kills every run and removes
 * every folder. A usage limit reached mid-run (a rejected rate_limit_event,
 * or a result with API status 429) or a refused sign-in stops the suite: no
 * further run starts.
 *
 * A finished comparison is kept (the newest 20) beside the other state
 * files, so `fix` can quote it on the subagent-model line.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { AB_TASKS, type AbTask } from "./abtasks.js";
import { CHECK_TIMEOUT_MS, DEFAULT_AB_MODEL, estimateAb, killTree, makeRun, outProblem, removeRoot, STOPPED_EARLY, taskPrompt, verifyRun, type AbEstimate, type Live } from "./ab.js";
import { claudeLimitFit, limitsReport } from "./limits.js";
import { abResultsPath, appendAbResult, onPlan, passLine, type AbStoredResult } from "./abstore.js";
import { exactClaudePricingFor, formatUsd } from "./pricing.js";
import { SUBAGENT_CANDIDATE } from "./subagentpay.js";
import { modelName } from "./subagentmodel.js";
import { formatTokens } from "./tokens.js";
import { toolCwd } from "./toolcwd.js";

/** The arms when none are named: the subagent lever's question. */
export const DEFAULT_CC_MODEL = SUBAGENT_CANDIDATE;
export const DEFAULT_CC_COMPARE = DEFAULT_AB_MODEL;
/** Claude Code turns a run may take (it reads, edits and runs the check one tool at a time). */
export const DEFAULT_CC_MAX_TURNS = 30;
/** A run still going after this long is killed. */
export const DEFAULT_CC_TIMEOUT_S = 600;
/** Runs in flight: two, so a plan's limits are not raced. */
const DEFAULT_CC_CONCURRENCY = 2;
/**
 * The estimate's shape for a Claude Code run: its own system prompt, the six
 * tools and the reminders on the first message came to ~29k characters
 * (~9k tokens) on 2.1.325 with these flags, and it takes about ten requests
 * where the Messages API harness takes six.
 */
const CC_SHAPE = { requests: 10, baseTokens: 9000 };

/** The flags ab needs, as `claude --help` lists them (--max-turns is accepted but not listed). */
export const REQUIRED_FLAGS = ["--print", "--model", "--output-format", "--verbose", "--restricted", "--safe-mode", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands", "--tools", "--allowedTools", "--disallowedTools", "--permission-mode", "--permission-prompts", "--settings", "dontAsk"];

const SMOKE = "test.mjs";
const ALLOWED = ["Read", "Edit", "Write", "Glob", "Grep", `Bash(node ${SMOKE})`];
/** The sandbox, failing closed: no writes outside the working folder and temp, no network, nothing run outside it. */
const SANDBOX_SETTINGS = { sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false } };

/** What the run asks, after the task itself: the Messages API harness's system prompt, in Claude Code's words. */
const INSTRUCTIONS =
  "Make the smallest correct change; the work is judged by a hidden test of the behaviour the request and the repository's documents describe. " +
  `\`node ${SMOKE}\` is the smoke test: it shows the code loads and runs, not that the results are right, and it cannot be changed. ` +
  `When you think the task is done, run \`node ${SMOKE}\`; once it passes, reply with one sentence saying what you changed.`;

/** The arguments of one run's `claude -p` (the prompt goes on stdin). */
export function claudeArgs(model: string, maxTurns: number, maxBudgetUsd?: number): string[] {
  return [
    "-p",
    "--model", model,
    "--output-format", "stream-json", "--verbose",
    "--max-turns", String(maxTurns),
    "--restricted", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
    "--tools", "Read,Edit,Write,Glob,Grep,Bash",
    "--allowedTools", ALLOWED.join(" "),
    "--disallowedTools", `Edit(${SMOKE}) Write(${SMOKE})`,
    "--permission-mode", "dontAsk", "--permission-prompts", "none",
    "--settings", JSON.stringify(SANDBOX_SETTINGS),
    ...(maxBudgetUsd !== undefined ? ["--max-budget-usd", maxBudgetUsd.toFixed(4)] : []),
  ];
}

export function claudeCodePrompt(task: AbTask): string {
  return `${taskPrompt(task)}\n\n${INSTRUCTIONS}`;
}

/** The Claude Code ab runs: CONTEXT_DOCTOR_CLAUDE_BIN, else `claude` on PATH. */
export function claudeBin(): string {
  return process.env.CONTEXT_DOCTOR_CLAUDE_BIN?.trim() || "claude";
}

/** Claude Code's environment: the caller's (its sign-in lives there), without the marker of an enclosing session. */
function claudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return env;
}

// -- What Claude Code is, and who it bills -------------------------------------------

export interface ClaudeCodeInfo {
  bin: string;
  version?: string;
  /** Flags ab needs that this Claude Code does not list. */
  missing: string[];
  loggedIn: boolean;
  /** `claude auth status`: claude.ai, api_key, oauth_token, ... */
  authMethod?: string;
  subscriptionType?: string;
  apiKeySource?: string;
  /** Why it cannot be used at all (not found, not runnable). */
  problem?: string;
}

/** `claude --version`, `--help` and `auth status --json`: all local, nothing sent to a model. */
export function inspectClaudeCode(bin = claudeBin()): ClaudeCodeInfo {
  const run = (args: string[]) => spawnSync(bin, args, { cwd: toolCwd(), env: claudeEnv(), encoding: "utf8", timeout: 30_000, windowsHide: true });
  const v = run(["--version"]);
  if (v.error || v.status !== 0) {
    const why = (v.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ? "not found" : (v.error?.message ?? `exit ${v.status}: ${(v.stderr ?? "").trim().slice(0, 200)}`);
    return { bin, missing: [], loggedIn: false, problem: `Claude Code (${bin}) could not be run: ${why}` };
  }
  const version = /(\d+\.\d+\.\d+)/.exec(v.stdout ?? "")?.[1];
  const help = run(["--help"]).stdout ?? "";
  const missing = REQUIRED_FLAGS.filter((f) => !help.includes(f));
  const a = run(["auth", "status", "--json"]);
  let auth: Record<string, unknown> = {};
  try { auth = JSON.parse(a.stdout ?? "") ?? {}; } catch { /* an older Claude Code, or none */ }
  const str = (k: string) => (typeof auth[k] === "string" ? (auth[k] as string) : undefined);
  return { bin, version, missing, loggedIn: auth.loggedIn === true, authMethod: str("authMethod"), subscriptionType: str("subscriptionType"), apiKeySource: str("apiKeySource") };
}

function whoPays(info: ClaudeCodeInfo): string {
  if (onPlan(info)) return `signed in to claude.ai${info.subscriptionType ? ` (${info.subscriptionType} plan)` : ""}: this draws on your plan's usage limits (the 5-hour and weekly windows), not dollars`;
  if (info.authMethod === "api_key") return `on an API key (${info.apiKeySource ?? "API key"}): this bills that key, in dollars`;
  return `signed in as ${info.authMethod ?? "unknown"}: billed as your Claude Code is set up`;
}

// -- One run ---------------------------------------------------------------------------

export interface AbModelRun {
  task: string;
  model: string;
  rep: number;
  /** The hidden check, run by the harness after Claude Code stopped. */
  pass: boolean;
  /** end_turn, turns (--max-turns), budget, limit (the plan's usage limit), timeout, or error. */
  stop: string;
  error?: string;
  /** Claude Code's num_turns. */
  turns: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** Claude Code's total_cost_usd: on a plan, what the run would cost at list prices. */
  costUsd: number;
  wallMs: number;
  /** Tool calls Claude Code's permissions refused (outside the folder, the smoke test, other commands). */
  denied: number;
}

interface CcShared {
  bin: string;
  maxTurns: number;
  timeoutMs: number;
  budgetUsd: number;
  concurrency: number;
  inFlight: number;
  spent: number;
  /** --max-budget-usd of the runs in flight, held against the budget until they end. */
  reserved: number;
  /** A usage limit, a refused sign-in or a Claude Code that would not start: no further run starts. */
  fatal?: string;
  live: Live;
}

interface StreamState {
  init?: Record<string, any>;
  result?: Record<string, any>;
  /** A rejected rate_limit_event: the plan's limit was reached. */
  limit?: Record<string, any>;
  /** An assistant message's `error` (authentication_failed, rate_limit, ...). */
  assistantError?: string;
}

function readEvent(line: string, s: StreamState): void {
  let e: any;
  try { e = JSON.parse(line); } catch { return; }
  if (!e || typeof e !== "object") return;
  if (e.type === "system" && e.subtype === "init") s.init = e;
  else if (e.type === "result") s.result = e;
  else if (e.type === "rate_limit_event" && e.rate_limit_info?.status === "rejected") s.limit = e.rate_limit_info;
  else if (e.type === "assistant" && typeof e.error === "string") s.assistantError ??= e.error;
}

async function runOne(task: AbTask, model: string, rep: number, ctx: CcShared): Promise<AbModelRun> {
  const started = Date.now();
  const run: AbModelRun = { task: task.id, model, rep, pass: false, stop: "", turns: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0, wallMs: 0, denied: 0 };
  // Under --budget: this run's share of what is left, split over the free slots, passed as --max-budget-usd.
  let cap: number | undefined;
  if (Number.isFinite(ctx.budgetUsd)) {
    cap = (ctx.budgetUsd - ctx.spent - ctx.reserved) / Math.max(1, ctx.concurrency - ctx.inFlight);
    if (cap < 0.01) {
      run.stop = "budget";
      return run;
    }
    ctx.reserved += cap;
  }
  ctx.inFlight++;
  const paths = makeRun(task, ctx.live);
  try {
    const s: StreamState = {};
    let stderr = "";
    let timedOut = false;
    const code = await new Promise<number>((resolveRun) => {
      let child: ChildProcess;
      try {
        child = spawn(ctx.bin, claudeArgs(model, ctx.maxTurns, cap), { cwd: paths.repo, env: claudeEnv(), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
      } catch (e) {
        stderr = (e as Error).message;
        resolveRun(1);
        return;
      }
      ctx.live.children.add(child);
      let buf = "";
      child.stdout!.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          readEvent(buf.slice(0, nl), s);
          buf = buf.slice(nl + 1);
        }
      });
      child.stderr!.on("data", (d: Buffer) => { stderr = (stderr + d.toString("utf8")).slice(-2000); });
      child.stdin!.on("error", () => { /* it exited before reading the prompt */ });
      child.stdin!.end(claudeCodePrompt(task));
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, ctx.timeoutMs);
      let done = false;
      const finish = (c: number) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (buf.trim()) readEvent(buf, s);
        killTree(child); // whatever it started and left in its group
        ctx.live.children.delete(child);
        resolveRun(c);
      };
      child.on("error", (e) => { stderr += `\n${e.message}`; finish(1); });
      child.on("close", (c) => finish(c ?? 1));
    });
    const r = s.result;
    if (r) {
      const u = r.usage ?? {};
      const n = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);
      run.turns = n(r.num_turns);
      run.inputTokens = n(u.input_tokens);
      run.cacheReadTokens = n(u.cache_read_input_tokens);
      run.cacheWriteTokens = n(u.cache_creation_input_tokens);
      run.outputTokens = n(u.output_tokens);
      run.costUsd = n(r.total_cost_usd);
      run.denied = Array.isArray(r.permission_denials) ? r.permission_denials.length : 0;
      ctx.spent += run.costUsd;
    }
    const said = (r && typeof r.result === "string" ? r.result : "").slice(0, 300);
    if (timedOut) {
      run.stop = "timeout";
      run.error = `killed after ${Math.round(ctx.timeoutMs / 1000)} s`;
    } else if (s.limit || s.assistantError === "rate_limit" || r?.api_error_status === 429 || r?.api_error === "usage_limit_reached") {
      run.stop = "limit";
      run.error = said || `usage limit reached${s.limit?.resetsAt ? `, resets ${new Date(Number(s.limit.resetsAt) * 1000).toISOString()}` : ""}`;
      ctx.fatal ??= `your plan's usage limit was reached (${run.error})`;
    } else if (!r) {
      run.stop = "error";
      run.error = `Claude Code ended (exit ${code}) without a result${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ""}`;
      // It never started a session (an unknown flag, the sandbox unavailable): every run would end the same way.
      if (!s.init) ctx.fatal ??= run.error;
    } else if (r.subtype === "error_max_turns") {
      run.stop = "turns";
    } else if (r.subtype === "error_max_budget_usd") {
      run.stop = "budget";
    } else if (r.is_error) {
      run.stop = "error";
      run.error = said || String(r.subtype ?? "error");
      if (s.assistantError === "authentication_failed" || r.api_error_status === 401 || r.api_error_status === 403) ctx.fatal ??= `Claude Code's sign-in was refused (${run.error})`;
    } else {
      run.stop = typeof r.stop_reason === "string" && r.stop_reason !== "stop_sequence" ? r.stop_reason : "end_turn";
    }
    run.pass = await verifyRun(task, paths, ctx.live);
  } finally {
    ctx.inFlight--;
    if (cap !== undefined) ctx.reserved -= cap;
    removeRoot(paths.root, ctx.live);
  }
  run.wallMs = Date.now() - started;
  return run;
}

// -- The suite ---------------------------------------------------------------------------

export interface AbModelOptions {
  models: string[];
  tasks?: AbTask[];
  repeat?: number;
  maxTurns?: number;
  /** Per run, ms. */
  timeoutMs?: number;
  /** No run starts once Claude Code's own costs reach this (each run gets its share as --max-budget-usd). */
  budgetUsd?: number;
  concurrency?: number;
  bin?: string;
  onRun?: (run: AbModelRun, done: number, total: number) => void;
}

export interface AbModelResult {
  via: "claude-code";
  /** ISO time the suite finished. */
  at: string;
  claudeCode: { version?: string; authMethod?: string; subscriptionType?: string };
  models: string[];
  tasks: string[];
  repeat: number;
  runs: AbModelRun[];
  /** Claude Code's own total_cost_usd, summed: on a plan, list-price equivalent. */
  costUsd: number;
  /** Why the suite stopped before every run (a usage limit, a refused sign-in, Claude Code not starting). */
  aborted?: string;
}

export async function runClaudeCodeAb(options: AbModelOptions, info: Pick<ClaudeCodeInfo, "version" | "authMethod" | "subscriptionType"> = {}): Promise<AbModelResult> {
  const tasks = options.tasks ?? AB_TASKS;
  const repeat = options.repeat ?? 1;
  const models = [...new Set(options.models)];
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CC_CONCURRENCY);
  const ctx: CcShared = {
    bin: options.bin ?? claudeBin(),
    maxTurns: options.maxTurns ?? DEFAULT_CC_MAX_TURNS,
    timeoutMs: options.timeoutMs ?? DEFAULT_CC_TIMEOUT_S * 1000,
    budgetUsd: options.budgetUsd ?? Infinity,
    concurrency,
    inFlight: 0,
    spent: 0,
    reserved: 0,
    live: { children: new Set(), roots: new Set(), timeoutMs: CHECK_TIMEOUT_MS },
  };
  // Ctrl-C: every Claude Code and everything it started is killed, no run folder stays behind.
  const interrupt = (signal: NodeJS.Signals) => {
    for (const child of ctx.live.children) killTree(child);
    for (const root of [...ctx.live.roots]) removeRoot(root, ctx.live);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  // Models alternate within each task, so a limit reached halfway leaves both arms with the same tasks.
  const queue: Array<{ task: AbTask; model: string; rep: number }> = [];
  for (let rep = 1; rep <= repeat; rep++) for (const task of tasks) for (const model of models) queue.push({ task, model, rep });
  const runs: AbModelRun[] = [];
  let next = 0;
  const worker = async () => {
    while (next < queue.length && !ctx.fatal) {
      const { task, model, rep } = queue[next++];
      const run = await runOne(task, model, rep, ctx);
      runs.push(run);
      options.onRun?.(run, runs.length, queue.length);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  const order = (r: AbModelRun) => queue.findIndex((q) => q.task.id === r.task && q.model === r.model && q.rep === r.rep);
  runs.sort((a, b) => order(a) - order(b));
  return {
    via: "claude-code",
    at: new Date().toISOString(),
    claudeCode: { version: info.version, authMethod: info.authMethod, subscriptionType: info.subscriptionType },
    models,
    tasks: tasks.map((t) => t.id),
    repeat,
    runs,
    costUsd: ctx.spent,
    ...(ctx.fatal ? { aborted: ctx.fatal } : {}),
  };
}

// -- The report ----------------------------------------------------------------------------

export interface ModelTotals {
  model: string;
  runs: number;
  /** Runs that ended on their own: the ones a pass rate is about. */
  completed: number;
  passed: number;
  stoppedEarly: number;
  tokens: number;
  costUsd: number;
}

export function modelTotals(result: Pick<AbModelResult, "models" | "runs">): ModelTotals[] {
  return result.models.map((model) =>
    result.runs.filter((r) => r.model === model).reduce<ModelTotals>(
      (t, r) => {
        const stopped = STOPPED_EARLY.has(r.stop);
        return {
          model,
          runs: t.runs + 1,
          completed: t.completed + (stopped ? 0 : 1),
          passed: t.passed + (!stopped && r.pass ? 1 : 0),
          stoppedEarly: t.stoppedEarly + (stopped ? 1 : 0),
          tokens: t.tokens + r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens + r.outputTokens,
          costUsd: t.costUsd + r.costUsd,
        };
      },
      { model, runs: 0, completed: 0, passed: 0, stoppedEarly: 0, tokens: 0, costUsd: 0 }
    )
  );
}

export function renderClaudeCodeAb(result: AbModelResult): string {
  const plan = onPlan(result.claudeCode);
  const out: string[] = [];
  out.push(`A/B quality through Claude Code${result.claudeCode.version ? ` ${result.claudeCode.version}` : ""}: ${result.tasks.length} tasks, ${result.models.map(modelName).join(" vs ")}, ${result.repeat} run${result.repeat === 1 ? "" : "s"} per task and model`);
  out.push(plan ? `On your plan: ${formatUsd(result.costUsd)} at list prices, drawn from your usage limits, not billed.` : `Claude Code's cost: ${formatUsd(result.costUsd)}.`);
  if (result.aborted) out.push(`Stopped early: ${result.aborted}. Runs not started are not in the table.`);
  const cell = (runs: AbModelRun[]) => {
    if (!runs.length) return "–";
    const t = modelTotals({ models: [runs[0].model], runs })[0];
    const verdict = t.runs === 1 ? (STOPPED_EARLY.has(runs[0].stop) ? runs[0].stop.toUpperCase().slice(0, 7) : runs[0].pass ? "PASS" : "FAIL") : `${t.passed}/${t.completed}${t.stoppedEarly ? "*" : ""}`;
    return `${verdict.padEnd(8)}${formatTokens(t.tokens / t.runs).padStart(6)} ${formatUsd(t.costUsd / t.runs).padStart(8)}`;
  };
  const W = 26;
  out.push("", `${"task".padEnd(18)}${result.models.map((m) => modelName(m).padEnd(W)).join("")}`);
  for (const id of result.tasks) out.push(`${id.padEnd(18)}${result.models.map((m) => cell(result.runs.filter((r) => r.task === id && r.model === m)).padEnd(W)).join("")}`);
  const totals = modelTotals(result);
  out.push(`${"passed".padEnd(18)}${totals.map((t) => `${t.passed}/${t.completed} completed`.padEnd(W)).join("")}`);
  if (totals.some((t) => t.stoppedEarly)) out.push(`${"stopped early".padEnd(18)}${totals.map((t) => String(t.stoppedEarly).padEnd(W)).join("")}(usage limit, time or turn limit, budget, an error: left out of the pass counts)`);
  out.push(`${"tokens per run".padEnd(18)}${totals.map((t) => formatTokens(t.runs ? t.tokens / t.runs : 0).padEnd(W)).join("")}`);
  out.push(`${(plan ? "list-price cost" : "cost").padEnd(18)}${totals.map((t) => formatUsd(t.costUsd).padEnd(W)).join("")}`);
  const denied = result.runs.reduce((n, r) => n + r.denied, 0);
  if (denied) out.push(`${"refused calls".padEnd(18)}${denied} (outside the run folder, the smoke test, or another command: Claude Code's permissions said no)`);
  const done = totals.filter((t) => t.completed > 0);
  out.push("");
  if (done.length < 2) out.push("Fewer than two models completed a run: nothing to compare.");
  else out.push(`${passLine(totals)}.`);
  out.push(result.repeat < 3 ? "One task's difference is noise at this size: --repeat 3 or more for a figure worth quoting." : `${result.repeat} runs per task and model.`);
  return out.join("\n");
}

// -- The stored results, for fix --------------------------------------------------------------

/** Keep a finished comparison for fix (the newest 20). */
export function storeAbResult(result: AbModelResult, path = abResultsPath()): AbStoredResult {
  const entry: AbStoredResult = {
    at: result.at,
    via: "claude-code",
    claudeCodeVersion: result.claudeCode.version,
    authMethod: result.claudeCode.authMethod,
    subscriptionType: result.claudeCode.subscriptionType,
    repeat: result.repeat,
    tasks: result.tasks.length,
    models: modelTotals(result).map((t) => ({ model: t.model, passed: t.passed, completed: t.completed, runs: t.runs, costUsd: Math.round(t.costUsd * 1e4) / 1e4 })),
  };
  appendAbResult(entry, path);
  return entry;
}

// -- The command ----------------------------------------------------------------------------

export interface AbClaudeCodeCommandOptions {
  model?: string;
  compare?: string[];
  tasks: AbTask[];
  repeat?: number;
  maxTurns?: number;
  timeoutS?: number;
  concurrency?: number;
  budgetUsd?: number;
  yes: boolean;
  json: boolean;
  out?: string;
}

/** The arms: --model (default Sonnet 5.5), then each --compare (default Opus 5.5; "none" for none). */
export function modelsFor(model: string | undefined, compare: string[] | undefined): string[] {
  const named = (compare ?? []).flatMap((c) => c.split(",")).map((c) => c.trim()).filter(Boolean);
  const others = named.length ? named.filter((c) => c !== "none") : [DEFAULT_CC_COMPARE];
  return [...new Set([model ?? DEFAULT_CC_MODEL, ...others])];
}

/** `context-doctor ab --via claude-code`: the exit code. */
export async function abClaudeCodeCommand(o: AbClaudeCodeCommandOptions): Promise<number> {
  const say = (line: string) => (o.json ? console.error(line) : console.log(line));
  if (process.platform === "win32") {
    console.error("ab --via claude-code runs each task under Claude Code's sandbox, which Claude Code offers on macOS and Linux (WSL included), not on Windows. Nothing was run.");
    return 1;
  }
  const models = modelsFor(o.model, o.compare);
  const noPrice = models.find((m) => !exactClaudePricingFor(m));
  if (noPrice) {
    console.error(`No price is known for ${noPrice} itself, so ab cannot estimate the runs. Name a Claude model in the price table by its full id (e.g. ${DEFAULT_CC_MODEL}, ${DEFAULT_CC_COMPARE}), not an alias.`);
    return 1;
  }
  if (o.out) {
    const problem = outProblem(o.out);
    if (problem) {
      console.error(`${problem}. Nothing was run.`);
      return 1;
    }
  }
  const info = inspectClaudeCode();
  if (info.problem) {
    console.error(`${info.problem}. Install Claude Code, or point CONTEXT_DOCTOR_CLAUDE_BIN at it. Nothing was run.`);
    return 1;
  }
  if (info.missing.length) {
    console.error(`Claude Code ${info.version ?? ""} (${info.bin}) does not list ${info.missing.join(", ")} in --help: ab needs them to confine each run. Update Claude Code (2.1.311 or later). Nothing was run.`);
    return 1;
  }
  if (!info.loggedIn) {
    console.error(`Claude Code (${info.bin}) is not signed in: run \`claude\` and /login, then try again. Nothing was run.`);
    return 1;
  }
  const repeat = o.repeat ?? 1;
  const maxTurns = o.maxTurns ?? DEFAULT_CC_MAX_TURNS;
  const timeoutS = o.timeoutS ?? DEFAULT_CC_TIMEOUT_S;
  const ests: AbEstimate[] = models.map((m) => estimateAb(o.tasks, ["arm"], repeat, exactClaudePricingFor(m)!, CC_SHAPE));
  const expected = ests.reduce((s, e) => s + e.expectedUsd, 0);
  const upper = ests.reduce((s, e) => s + e.upperUsd, 0);
  const runs = o.tasks.length * models.length * repeat;
  const plan = onPlan(info);
  // On a plan the limits are the cap; on a key, as ab does on the Messages API: the upper estimate plus 25%.
  const budget = o.budgetUsd ?? (plan ? undefined : Math.max(1, Math.ceil(upper * 1.25)));
  say(`A/B quality suite through Claude Code: ${o.tasks.length} task${o.tasks.length === 1 ? "" : "s"} x ${models.length} model${models.length === 1 ? "" : "s"} (${models.join(", ")}) x ${repeat} = ${runs} runs`);
  say(`Claude Code ${info.version ?? "(version unknown)"} (${info.bin}), ${whoPays(info)}.`);
  if (plan) {
    say(`At API list prices the runs come to ~${formatUsd(expected)} (up to ~${formatUsd(upper)} if nothing caches); Claude Code reports each run's own figure.`);
    let share: string | undefined;
    try {
      const fit = claudeLimitFit(limitsReport(30, { claudeOnly: true }));
      if (fit?.usable && fit.pctPerUsd !== undefined) {
        const pct = fit.pctPerUsd * expected;
        const round = (v: number) => (v >= 10 ? Math.round(v).toString() : v.toFixed(1));
        share = fit.window === "seven_day" ? `≈ ${round(pct)}% of your weekly limit` : `≈ ${round(pct)}% of a 5-hour window`;
      }
    } catch { /* no readings */ }
    say(share ? `That is ${share}, from your limit readings (context-doctor limits).` : "What share of your limits that is cannot be said here yet: there are no fitted limit readings (context-doctor limits).");
  } else {
    say(`Estimated cost: ~${formatUsd(expected)} with prompt caching, up to ~${formatUsd(upper)} if nothing caches.`);
  }
  if (budget !== undefined) say(`No run starts once Claude Code's own costs reach ${formatUsd(budget)} (--budget); each gets its share as --max-budget-usd.`);
  say(`Each run: a fresh temporary copy of the task's repository; Claude Code with its file tools confined to it, only \`node ${SMOKE}\` allowed in Bash, under Claude Code's sandbox (no writes outside the run folder and temp, no network); no MCP servers, plugins, hooks, settings files or CLAUDE.md; no session saved; up to ${maxTurns} turns and ${timeoutS} s.`);
  if (!o.yes) {
    say(`Nothing was run. Run again with --yes to start${plan ? " (it uses your plan's limits)" : budget !== undefined ? `, spending up to ${formatUsd(budget)}` : ""}.`);
    return 0;
  }
  const result = await runClaudeCodeAb(
    {
      models,
      tasks: o.tasks,
      repeat,
      maxTurns,
      timeoutMs: timeoutS * 1000,
      budgetUsd: budget,
      concurrency: o.concurrency,
      bin: info.bin,
      onRun: (r, done, total) =>
        console.error(`[${done}/${total}] ${r.task} · ${r.model} · ${STOPPED_EARLY.has(r.stop) ? `stopped (${r.stop})` : r.pass ? "PASS" : "FAIL"} · ${r.turns} turns · ${formatTokens(r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens + r.outputTokens)} tokens · ${formatUsd(r.costUsd)}${r.error ? ` · ${r.error}` : ""}`),
    },
    info
  );
  const json = JSON.stringify({ ...result, summary: modelTotals(result) }, null, 2);
  if (o.out) writeFileSync(o.out, json + "\n");
  let stored: string | undefined;
  if (!result.aborted && modelTotals(result).filter((t) => t.completed > 0).length >= 2) {
    try {
      storeAbResult(result);
      stored = abResultsPath();
    } catch (e) {
      console.error(`The result could not be kept for fix: ${(e as Error).message}`);
    }
  }
  if (o.json) console.log(json);
  else console.log("\n" + renderClaudeCodeAb(result) + (o.out ? `\n\nEvery run, as JSON: ${o.out}` : "") + (stored ? `\nKept for context-doctor fix (its subagent-model line quotes it): ${stored}` : ""));
  if (result.aborted) console.error(`Stopped: ${result.aborted}.`);
  const dead = models.filter((m) => {
    const rs = result.runs.filter((r) => r.model === m);
    return rs.length > 0 && rs.every((r) => r.stop === "error");
  });
  return result.aborted || dead.length > 0 ? 1 : 0;
}
