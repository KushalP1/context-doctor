/**
 * `context-doctor ab`: does a lever cost quality? Each task of a small suite
 * (abtasks.ts) runs with and without the lever, through the Messages API,
 * with a minimal agent loop (read_file, write_file, run_check), and is
 * scored by a hidden check the harness runs after the agent stops. Pass
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
 *   compact-generic  one compaction mid-task with generic instructions; the
 *                    session then continues from the summary alone
 *   compact          the same compaction with the PreCompact hook's
 *                    instructions (files changed, failing checks, the user's
 *                    own instructions) added, as Claude Code merges them
 *
 * The agent's code runs (in the smoke test and the hidden check) with a
 * minimal environment (no API key, a throwaway HOME), in its own process
 * group, under a time limit; whatever it leaves running is killed and every
 * temporary folder is removed, on errors and Ctrl-C too. It is a quality
 * test, not a sandbox: the code runs as the user.
 *
 * It spends the caller's API budget, so the CLI prints the estimate first,
 * needs --yes to send anything, and sends no request whose worst case
 * (prompt as cache writes, max_tokens of output) would pass --budget. The
 * provider is an interface: anthropicProvider() speaks the Messages API over
 * fetch (this package has no runtime dependencies), and tests plug in a
 * local mock server through ANTHROPIC_BASE_URL.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AB_TASKS, abVerifyScript, type AbTask } from "./abtasks.js";
import { AutoClearer, type AutoClearResult } from "./autoclear.js";
import { packContext, renderPack, type PackSource } from "./pack.js";
import { compactFacts, compactInstructions } from "./precompact.js";
import { exactClaudePricingFor, formatUsd, usageCost, CACHE_WRITE_5M, type ModelPricing, type RecordedUsage } from "./pricing.js";
import { SERVER_INSTRUCTIONS } from "./rules.js";
import { estimateTokens, formatTokens } from "./tokens.js";
import { contextDoctorStats, withContextDoctor } from "./wrap.js";

export const AB_LEVERS = ["rules", "autoclear", "pack", "compact"] as const;
export type AbLever = (typeof AB_LEVERS)[number];
export type AbArm = "none" | "rules" | "autoclear" | "pack" | "compact-generic" | "compact";

export const DEFAULT_AB_MODEL = "claude-opus-5-5";
/** The Messages API version the harness sends (sampling parameters are not sent). */
export const AB_API_VERSION = "2026-10-21";
/** Output cap per request; also the output side of each request's worst case for the budget. */
const MAX_TOKENS = 16000;
/** A smoke test or hidden check that runs longer is killed (and fails). */
const CHECK_TIMEOUT_MS = 30_000;

/** What each lever is compared against, and what it is. */
const LEVER_INFO: Record<AbLever, { base: AbArm; arm: AbArm; what: string }> = {
  rules: { base: "none", arm: "rules", what: "the standing context rules in the system prompt (what MCP clients and the Copilot hook add)" },
  autoclear: { base: "none", arm: "autoclear", what: "autopilot in process (withContextDoctor), stale tool output cleared whenever the batch is big enough, as if every request came after an idle gap" },
  pack: { base: "none", arm: "pack", what: "a pack_context tool and the rule to use it for big files instead of reading them whole" },
  compact: { base: "compact-generic", arm: "compact", what: "one compaction mid-task, continued from the summary alone, with the PreCompact hook's instructions vs generic ones" },
};

// -- The provider ------------------------------------------------------------

export interface AbContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  [key: string]: unknown;
}

export interface AbResponse {
  content: AbContentBlock[];
  stop_reason?: string;
  usage?: RecordedUsage;
}

/** Anything that can answer a Messages API request. */
export interface AbProvider {
  readonly name: string;
  /** One request; rejects with an Error carrying `status` on an HTTP error. */
  create(body: Record<string, unknown>): Promise<AbResponse>;
}

/**
 * The Messages API over fetch. Retries what the API asks to be retried
 * (429, 5xx, 529 overloaded) and what the network breaks (a refused
 * connection, a body cut short, a 200 whose body is not the message), with
 * backoff, honouring retry-after. Anything else is the caller's error and
 * is thrown with its status, so the SDK wrapper can recognise a refused
 * history edit and the suite can stop on a refused key.
 */
export function anthropicProvider(options: { apiKey: string; baseUrl?: string; retries?: number; timeoutMs?: number }): AbProvider {
  const base = (options.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const retries = options.retries ?? 4;
  return {
    name: `Anthropic Messages API (${base})`,
    async create(body) {
      for (let attempt = 0; ; attempt++) {
        let status = 0;
        let text = "";
        let retryAfter: string | null = null;
        let broken: unknown; // the network or the body failed, not the API
        try {
          const res = await fetch(`${base}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": options.apiKey, "anthropic-version": AB_API_VERSION },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(options.timeoutMs ?? 600_000),
          });
          status = res.status;
          retryAfter = res.headers.get("retry-after");
          text = await res.text();
          if (res.ok) {
            const parsed = JSON.parse(text) as AbResponse;
            if (Array.isArray(parsed?.content)) return parsed;
            broken = new Error("the response has no content array");
          }
        } catch (e) {
          broken = e;
        }
        const retryable = broken !== undefined || status === 429 || status === 529 || status >= 500;
        if (!retryable || attempt >= retries) {
          if (broken !== undefined && (status === 0 || status === 200)) {
            throw Object.assign(new Error(`${status ? "HTTP 200 with an unusable body" : "no response"}: ${(broken as Error).message ?? broken}`), { status });
          }
          let message = text.slice(0, 500);
          let error: unknown = text;
          try {
            error = JSON.parse(text);
            message = (error as { error?: { message?: string } })?.error?.message ?? message;
          } catch { /* not JSON */ }
          throw Object.assign(new Error(`HTTP ${status}: ${message}`), { status, error });
        }
        const wait = retryAfter && Number(retryAfter) >= 0 ? Number(retryAfter) * 1000 : 1000 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, Math.min(wait, 60_000)));
      }
    },
  };
}

// -- Running the agent's code --------------------------------------------------

/** Children in flight and run folders on disk, for Ctrl-C. */
interface Live {
  children: Set<ChildProcess>;
  roots: Set<string>;
  /** A smoke test or hidden check running longer is killed. */
  timeoutMs: number;
}

/** PATH and a throwaway home: no API key or other secret reaches code the model wrote. */
function minimalEnv(home: string): NodeJS.ProcessEnv {
  const tmp = join(home, "tmp");
  mkdirSync(tmp, { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? process.env.Path ?? "", HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  // Windows cannot start processes without these.
  for (const k of ["SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "PATHEXT"]) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

/** Kill a child and everything in its process group (the child leads one). */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch { /* the group is gone */ }
}

/**
 * Processes still working inside a run folder: a child that left its process
 * group (detached) is still found by its working directory, through /proc
 * on Linux and lsof elsewhere, and killed. Best effort: without either, the
 * minimal environment is what limits it.
 */
function killLeftovers(root: string): void {
  if (process.platform === "win32") return;
  const pids = new Set<number>();
  try {
    if (existsSync("/proc/self/cwd")) {
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const cwd = readlinkSync(`/proc/${name}/cwd`);
          if (cwd === root || cwd.startsWith(root + sep)) pids.add(Number(name));
        } catch { /* gone, or not ours to read */ }
      }
    } else {
      const r = spawnSync("lsof", ["-t", "+D", root], { encoding: "utf8", timeout: 5000 });
      for (const line of (r.stdout ?? "").split("\n")) if (/^\d+$/.test(line.trim())) pids.add(Number(line.trim()));
    }
  } catch { /* best effort */ }
  pids.delete(process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch { /* already gone */ }
  }
}

/** Make a tree removable (the agent's code may have made it read-only), without following links. */
function makeWritable(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;
  try {
    chmodSync(path, st.isDirectory() ? 0o700 : 0o600);
  } catch { /* best effort */ }
  if (st.isDirectory()) for (const name of readdirSync(path)) makeWritable(join(path, name));
}

function removeRoot(root: string, live: Live): void {
  killLeftovers(root);
  makeWritable(root);
  try {
    rmSync(root, { recursive: true, force: true });
  } catch { /* reported by nothing: a temp folder the OS clears */ }
  live.roots.delete(root);
}

/**
 * Run `node <args>` in `cwd` with the minimal environment, in its own
 * process group, killed with its group at `timeoutMs` and again when it
 * exits (whatever it started and left behind). Output is kept to its last
 * 3,000 characters however much is written.
 */
function runNode(args: string[], cwd: string, home: string, live: Live): Promise<{ code: number; output: string; timedOut: boolean }> {
  const timeoutMs = live.timeoutMs;
  return new Promise((resolveRun) => {
    let tail = "";
    let timedOut = false;
    const child = spawn(process.execPath, args, { cwd, env: minimalEnv(home), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    live.children.add(child);
    const keep = (d: Buffer) => {
      tail = (tail + d.toString("utf8")).slice(-3000);
    };
    child.stdout!.on("data", keep);
    child.stderr!.on("data", keep);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    let finished = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      killTree(child);
      live.children.delete(child);
      resolveRun({ code: timedOut ? 1 : code, output: timedOut ? `${tail}\n[killed after ${timeoutMs / 1000} s]` : tail, timedOut });
    };
    child.on("error", (e) => {
      tail += `\n${e.message}`;
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

// -- The agent's tools ---------------------------------------------------------

const SMOKE_FILE = "test.mjs";

const BASE_TOOLS = [
  {
    name: "read_file",
    description: "Read one file of the repository, whole. `path` is relative to the repository root.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "write_file",
    description: "Write one whole file of the repository, replacing what is there (folders are created). test.mjs cannot be changed.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
  {
    name: "run_check",
    description: "Run the repository's smoke test, `node test.mjs`, and return its output and exit code. It shows the code loads and runs, not that the results are right.",
    input_schema: { type: "object", properties: {} },
  },
];

const PACK_TOOL = {
  name: "pack_context",
  description: "Only the parts of the repository's files that a question needs, ranked and cut to ~1,500 tokens, instead of reading them whole. `paths` limits it to some files.",
  input_schema: { type: "object", properties: { question: { type: "string" }, paths: { type: "array", items: { type: "string" } } }, required: ["question"] },
};

const BASE_SYSTEM =
  "You are a careful software engineer working in a small JavaScript repository through tools. Make the smallest correct change; " +
  "the work is judged by a hidden test of the behaviour the request and the repository's documents describe. " +
  "When you think the task is done, call run_check; once it passes, reply with one sentence saying what you changed.";

const PACK_RULE = "To answer from a big file you won't edit, call pack_context with the question; don't read it whole.";

const GENERIC_COMPACTION =
  "Your context is being compacted: the session will continue from your summary alone. Write a summary that lets the work continue without it: " +
  "the request in full, what you found (with the exact facts the work depends on), what you changed, what is still failing, and what remains to do. " +
  "Reply with the summary only; do not call tools.";

/**
 * The repository file a tool names, or why not: a path outside the
 * repository, or one through a symbolic link (the agent's own code can
 * make links when the smoke test runs it, and reads or writes through one
 * would reach outside).
 */
function repoPath(repo: string, path: unknown): { full: string; rel: string } | { error: string } {
  if (typeof path !== "string" || path.trim() === "" || isAbsolute(path)) return { error: `not a path inside the repository: ${String(path)}` };
  const full = resolve(repo, path);
  const rel = relative(repo, full);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return { error: `not a path inside the repository: ${path}` };
  let at = repo;
  for (const part of rel.split(sep)) {
    at = join(at, part);
    try {
      if (lstatSync(at).isSymbolicLink()) return { error: `${path} goes through a symbolic link, which is not followed` };
    } catch {
      break; // the rest does not exist yet
    }
  }
  return { full, rel: rel.split(sep).join("/") };
}

function filesUnder(dir: string, root = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) return [];
    return st.isDirectory() ? filesUnder(full, root) : [relative(root, full).split(sep).join("/")];
  });
}

/**
 * Put the shipped smoke test back: whatever stands at test.mjs (a changed
 * file, a folder, a link to anywhere) is removed without following it, and
 * the file is created anew, never written through.
 */
function restoreSmoke(repo: string, task: AbTask): void {
  makeWritable(repo);
  const path = join(repo, SMOKE_FILE);
  try {
    const st = lstatSync(path);
    if (st.isDirectory() && !st.isSymbolicLink()) rmSync(path, { recursive: true, force: true });
    else unlinkSync(path);
  } catch { /* nothing there */ }
  writeFileSync(path, task.files[SMOKE_FILE], { flag: "wx" });
}

interface ToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

async function execute(block: AbContentBlock, run: RunPaths, task: AbTask, allowPack: boolean, counts: { pack: number }, live: Live): Promise<ToolResult> {
  const id = String(block.id ?? "");
  const fail = (content: string): ToolResult => ({ type: "tool_result", tool_use_id: id, content, is_error: true });
  const input = block.input ?? {};
  try {
    switch (block.name) {
      case "read_file": {
        const p = repoPath(run.repo, input.path);
        if ("error" in p) return fail(p.error);
        return { type: "tool_result", tool_use_id: id, content: readFileSync(p.full, "utf8") };
      }
      case "write_file": {
        const p = repoPath(run.repo, input.path);
        if ("error" in p) return fail(p.error);
        // Windows drops trailing dots and spaces: "test.mjs " is test.mjs there.
        if (p.rel.replace(/[. ]+$/, "").toLowerCase() === SMOKE_FILE) return fail("test.mjs is the smoke test and cannot be changed");
        if (typeof input.content !== "string") return fail("content must be a string");
        mkdirSync(dirname(p.full), { recursive: true });
        if (existsSync(p.full) && !statSync(p.full).isFile()) return fail(`${String(input.path)} is not a file`);
        writeFileSync(p.full, input.content);
        return { type: "tool_result", tool_use_id: id, content: `wrote ${Buffer.byteLength(input.content)} bytes to ${String(input.path)}` };
      }
      case "run_check": {
        restoreSmoke(run.repo, task);
        const r = await runNode([SMOKE_FILE], run.repo, run.home, live);
        return { type: "tool_result", tool_use_id: id, content: `${r.output}\nexit code ${r.code}`, ...(r.code !== 0 ? { is_error: true } : {}) };
      }
      case "pack_context": {
        if (!allowPack) return fail("no such tool");
        counts.pack++;
        const wanted = Array.isArray(input.paths) ? input.paths.map(String) : undefined;
        const sources: PackSource[] = filesUnder(run.repo)
          .filter((p) => !wanted || wanted.includes(p))
          .map((p) => ({ name: p, text: readFileSync(join(run.repo, p), "utf8") }));
        return { type: "tool_result", tool_use_id: id, content: renderPack(packContext(sources, { query: String(input.question ?? ""), budget: 1500 })) };
      }
      default:
        return fail(`no such tool: ${String(block.name)}`);
    }
  } catch (e) {
    return fail((e as Error).message);
  }
}

// -- One run -------------------------------------------------------------------

export interface AbRun {
  task: string;
  arm: AbArm;
  rep: number;
  /** The hidden check, run by the harness after the agent stopped. */
  pass: boolean;
  /** Why the loop ended: end_turn, turns (the cap), budget, error, or the API's stop_reason. */
  stop: string;
  error?: string;
  requests: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number;
  wallMs: number;
  /** What the lever did: requests autopilot changed, pack_context calls, or compactions. */
  leverUses: number;
  /** autoclear: tokens it kept off the wire, over all requests. */
  leverTokens: number;
}

/** Ends that say nothing about the lever: the API failed or declined, or the harness's own caps cut the run. */
export const STOPPED_EARLY = new Set(["error", "budget", "turns", "refusal", "max_tokens"]);

/** Autopilot with every request as if after an idle gap: clearing is allowed on each one. */
class ColdEveryRequest extends AutoClearer {
  private clock = 0;
  override apply(body: Record<string, unknown>, _now?: number, modelHint?: string, account?: string): AutoClearResult {
    this.clock += 2 * 3_600_000;
    return super.apply(body, this.clock, modelHint, account);
  }
}

/** The harness's history as a Claude Code transcript, the shape the PreCompact hook reads. */
function asTranscript(messages: Array<{ role: string; content: unknown }>): string {
  const rename = (b: AbContentBlock): AbContentBlock => {
    if (b.type !== "tool_use") return b;
    if (b.name === "write_file") return { ...b, name: "Write", input: { file_path: b.input?.path } };
    if (b.name === "run_check") return { ...b, name: "Bash", input: { command: "npm test" } };
    return b;
  };
  return messages
    .map((m) =>
      JSON.stringify(
        m.role === "assistant"
          ? { type: "assistant", message: { role: "assistant", content: (m.content as AbContentBlock[]).map(rename) } }
          : { type: "user", message: { role: "user", content: m.content } }
      )
    )
    .join("\n") + "\n";
}

export interface AbOptions {
  provider: AbProvider;
  model?: string;
  tasks?: AbTask[];
  levers?: readonly AbLever[];
  repeat?: number;
  /** Requests per run, the compaction's included, before the loop is stopped (default 16). */
  maxTurns?: number;
  /** No request is sent whose worst case would take the spend past this, USD. */
  budgetUsd?: number;
  /** Runs in flight at once (default 4). */
  concurrency?: number;
  /** compact arms: compact after this many requests (default 2). */
  compactAfter?: number;
  /** Time limit for each smoke test and hidden check, ms (default 30,000). */
  checkTimeoutMs?: number;
  /** Called as each run finishes. */
  onRun?: (run: AbRun, done: number, total: number) => void;
}

interface Shared {
  provider: AbProvider;
  model: string;
  pricing: ModelPricing;
  maxTurns: number;
  budgetUsd: number;
  compactAfter: number;
  spent: number;
  /** Worst cases of the requests in flight, held against the budget until they answer. */
  reserved: number;
  /** Set when the API refuses the key: no further run starts. */
  fatal?: string;
  live: Live;
}

interface RunPaths {
  root: string;
  repo: string;
  home: string;
}

function taskPrompt(task: AbTask): string {
  const list = Object.keys(task.files)
    .sort()
    .map((p) => `- ${p} (${(Buffer.byteLength(task.files[p]) / 1024).toFixed(1)} KB)`)
    .join("\n");
  return `Repository files:\n${list}\n\nTask: ${task.prompt}`;
}

function systemFor(arm: AbArm): string {
  if (arm === "rules") return `${BASE_SYSTEM}\n\n${SERVER_INSTRUCTIONS}`;
  if (arm === "pack") return `${BASE_SYSTEM}\n\n${PACK_RULE}`;
  return BASE_SYSTEM;
}

/** The most a request can cost: its prompt written to the cache, and max_tokens of output. */
function worstCaseUsd(body: Record<string, unknown>, pricing: ModelPricing): number {
  const prompt = estimateTokens(JSON.stringify([body.system, body.tools, body.messages]), "claude") * 1.25; // the estimate's margin
  return (prompt * pricing.inputPerM * CACHE_WRITE_5M + MAX_TOKENS * pricing.outputPerM) / 1e6;
}

/** The hidden check: written outside the repository, run with it as the working directory. */
async function verifyRun(task: AbTask, run: RunPaths, live: Live): Promise<boolean> {
  try {
    makeWritable(run.root); // the agent's code may have locked its folders
    const script = join(run.root, "verify.mjs");
    rmSync(script, { force: true, recursive: true });
    writeFileSync(script, abVerifyScript(task), { flag: "wx" });
    const nonce = randomBytes(12).toString("hex");
    const r = await runNode([script, nonce], run.repo, run.home, live);
    return r.code === 0 && r.output.includes(`ab-verify-ok ${nonce}`);
  } catch {
    return false; // a repository the check cannot even run in has not passed it
  }
}

/** A fresh run folder: the repository, and a home for the code it runs. */
function makeRun(task: AbTask, live: Live): RunPaths {
  const root = mkdtempSync(join(tmpdir(), `ctxdoc-ab-${task.id}-`));
  live.roots.add(root);
  const repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  for (const [p, text] of Object.entries(task.files)) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), text);
  }
  return { root, repo, home };
}

/**
 * The verdict on files as they stand, for the tests and the self-check:
 * a fresh run folder with `files`, the hidden check, everything removed.
 */
export async function abVerify(task: AbTask, files: Record<string, string> = task.files): Promise<boolean> {
  const live: Live = { children: new Set(), roots: new Set(), timeoutMs: CHECK_TIMEOUT_MS };
  const run = makeRun({ ...task, files }, live);
  try {
    return await verifyRun(task, run, live);
  } finally {
    removeRoot(run.root, live);
  }
}

async function runOne(task: AbTask, arm: AbArm, rep: number, ctx: Shared): Promise<AbRun> {
  const started = Date.now();
  const run: AbRun = { task: task.id, arm, rep, pass: false, stop: "", requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0, wallMs: 0, leverUses: 0, leverTokens: 0 };
  const paths = makeRun(task, ctx.live);
  const raw = { messages: { create: (body: Record<string, unknown>) => ctx.provider.create(body) } };
  const client = arm === "autoclear" ? withContextDoctor(raw, { clearer: new ColdEveryRequest({ keepRecent: 1, minClearTokens: 1000 }) }) : raw;
  const system = systemFor(arm);
  const tools = arm === "pack" ? [...BASE_TOOLS, PACK_TOOL] : BASE_TOOLS;
  const counts = { pack: 0 };

  /** One request, or undefined when the turn cap or the budget says not to send it. */
  const send = async (messages: unknown[], extra: Record<string, unknown> = {}): Promise<AbResponse | undefined> => {
    if (run.requests >= ctx.maxTurns) { run.stop = "turns"; return undefined; }
    const body = { model: ctx.model, max_tokens: MAX_TOKENS, system, tools, messages, cache_control: { type: "ephemeral" }, ...extra };
    const worst = worstCaseUsd(body, ctx.pricing);
    if (ctx.fatal || ctx.spent + ctx.reserved + worst > ctx.budgetUsd) { run.stop = ctx.fatal ? "error" : "budget"; return undefined; }
    ctx.reserved += worst;
    let res: AbResponse;
    try {
      res = await client.messages.create(body);
    } finally {
      ctx.reserved -= worst;
    }
    run.requests++;
    const u = res.usage ?? {};
    const n = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);
    run.inputTokens += n(u.input_tokens);
    run.cacheReadTokens += n(u.cache_read_input_tokens);
    run.cacheWriteTokens += n(u.cache_creation_input_tokens);
    run.outputTokens += n(u.output_tokens);
    const cost = usageCost(u, ctx.pricing).totalUsd;
    run.costUsd += cost;
    ctx.spent += cost;
    if (!Array.isArray(res.content)) throw new Error("the response has no content array");
    return res;
  };

  let messages: Array<{ role: string; content: unknown }> = [{ role: "user", content: taskPrompt(task) }];
  let compacted = false;
  try {
    try {
      for (;;) {
        const res = await send(messages);
        if (!res) break;
        messages.push({ role: "assistant", content: res.content });
        if (res.stop_reason !== "tool_use") { run.stop = res.stop_reason ?? "end_turn"; break; }
        const results: ToolResult[] = [];
        for (const b of res.content.filter((x) => x.type === "tool_use")) results.push(await execute(b, paths, task, arm === "pack", counts, ctx.live));
        messages.push({ role: "user", content: results });

        if ((arm === "compact" || arm === "compact-generic") && !compacted && run.requests >= ctx.compactAfter) {
          compacted = true;
          let instructions = "";
          if (arm === "compact") {
            const transcript = join(paths.root, "session.jsonl");
            writeFileSync(transcript, asTranscript(messages));
            instructions = compactInstructions(compactFacts(transcript));
          }
          const ask = [...messages.slice(0, -1), { role: "user", content: [...results, { type: "text", text: instructions ? `${GENERIC_COMPACTION}\n\n${instructions}` : GENERIC_COMPACTION }] }];
          const summary = await send(ask, { tool_choice: { type: "none" } });
          if (!summary) break;
          run.leverUses++;
          const text = summary.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
          // The session goes on from the summary alone, as after a real compaction.
          messages = [{ role: "user", content: `This session was compacted to save context. Your summary of it:\n\n${text}\n\nContinue the work from here.` }];
        }
      }
    } catch (e) {
      run.stop = "error";
      run.error = (e as Error).message.slice(0, 300);
      const status = (e as { status?: unknown }).status;
      if (status === 401 || status === 403) ctx.fatal ??= run.error;
    }
    run.pass = await verifyRun(task, paths, ctx.live);
  } finally {
    removeRoot(paths.root, ctx.live);
  }
  if (arm === "autoclear") {
    const stats = contextDoctorStats(client);
    run.leverUses = stats?.changed ?? 0;
    run.leverTokens = stats?.tokensRemoved ?? 0;
  }
  if (arm === "pack") run.leverUses = counts.pack;
  run.wallMs = Date.now() - started;
  return run;
}

// -- The suite ---------------------------------------------------------------

/** The arms a set of levers needs: one shared baseline for rules, autoclear and pack; compact brings its own. */
export function armsFor(levers: readonly AbLever[]): AbArm[] {
  const arms: AbArm[] = [];
  if (levers.some((l) => l !== "compact")) arms.push("none");
  for (const l of levers) {
    if (l === "compact") arms.push("compact-generic", "compact");
    else arms.push(l);
  }
  return [...new Set(arms)];
}

export interface AbEstimate {
  runs: number;
  /** With prompt caching: each token written once, then read at the cache rate. */
  expectedUsd: number;
  /** As if nothing cached: every request's whole prompt at the input rate. */
  upperUsd: number;
}

/**
 * A planning figure, not a quote: six requests a run, the task's files in
 * context from the second request on, ~800 output tokens a request (thinking,
 * tool calls, the files the agent writes).
 */
export function estimateAb(tasks: AbTask[], arms: AbArm[], repeat: number, pricing: ModelPricing): AbEstimate {
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

export interface AbResult {
  model: string;
  provider: string;
  tasks: string[];
  levers: AbLever[];
  arms: AbArm[];
  repeat: number;
  runs: AbRun[];
  spentUsd: number;
  /** Why the suite stopped before every run (the API refused the key). */
  aborted?: string;
}

export async function runAbSuite(options: AbOptions): Promise<AbResult> {
  const model = options.model ?? DEFAULT_AB_MODEL;
  const pricing = exactClaudePricingFor(model);
  if (!pricing) throw new Error(`no price is known for ${model} itself: ab needs one to estimate and cap the spend`);
  const tasks = options.tasks ?? AB_TASKS;
  const levers = [...(options.levers ?? AB_LEVERS)];
  const arms = armsFor(levers);
  const repeat = options.repeat ?? 1;
  const ctx: Shared = {
    provider: options.provider,
    model,
    pricing,
    maxTurns: options.maxTurns ?? 16,
    budgetUsd: options.budgetUsd ?? Infinity,
    compactAfter: options.compactAfter ?? 2,
    spent: 0,
    reserved: 0,
    live: { children: new Set(), roots: new Set(), timeoutMs: options.checkTimeoutMs ?? CHECK_TIMEOUT_MS },
  };
  // Ctrl-C: nothing of the agent's keeps running, no run folder stays behind.
  const interrupt = (signal: NodeJS.Signals) => {
    for (const child of ctx.live.children) killTree(child);
    for (const root of [...ctx.live.roots]) removeRoot(root, ctx.live);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const queue: Array<{ task: AbTask; arm: AbArm; rep: number }> = [];
  for (let rep = 1; rep <= repeat; rep++) for (const task of tasks) for (const arm of arms) queue.push({ task, arm, rep });
  const runs: AbRun[] = [];
  let next = 0;
  const worker = async () => {
    while (next < queue.length && !ctx.fatal) {
      const { task, arm, rep } = queue[next++];
      const run = await runOne(task, arm, rep, ctx);
      runs.push(run);
      options.onRun?.(run, runs.length, queue.length);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 4, queue.length)) }, worker));
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  const order = (r: AbRun) => queue.findIndex((q) => q.task.id === r.task && q.arm === r.arm && q.rep === r.rep);
  runs.sort((a, b) => order(a) - order(b));
  return { model, provider: options.provider.name, tasks: tasks.map((t) => t.id), levers, arms, repeat, runs, spentUsd: ctx.spent, ...(ctx.fatal ? { aborted: `the API refused the key (${ctx.fatal})` } : {}) };
}

// -- The report ----------------------------------------------------------------

export interface ArmTotals {
  runs: number;
  /** Runs that ended on their own: the ones a pass rate is about. */
  completed: number;
  passed: number;
  stoppedEarly: number;
  tokens: number;
  costUsd: number;
  leverUses: number;
  leverTokens: number;
}

function totals(runs: AbRun[]): ArmTotals {
  return runs.reduce<ArmTotals>(
    (t, r) => {
      const stopped = STOPPED_EARLY.has(r.stop);
      return {
        runs: t.runs + 1,
        completed: t.completed + (stopped ? 0 : 1),
        passed: t.passed + (!stopped && r.pass ? 1 : 0),
        stoppedEarly: t.stoppedEarly + (stopped ? 1 : 0),
        tokens: t.tokens + r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens + r.outputTokens,
        costUsd: t.costUsd + r.costUsd,
        leverUses: t.leverUses + r.leverUses,
        leverTokens: t.leverTokens + r.leverTokens,
      };
    },
    { runs: 0, completed: 0, passed: 0, stoppedEarly: 0, tokens: 0, costUsd: 0, leverUses: 0, leverTokens: 0 }
  );
}

/** Per arm: runs, completed runs and their passes, runs stopped early, billed tokens, cost. */
export function summarizeAb(result: AbResult): Record<string, ArmTotals> {
  return Object.fromEntries(result.arms.map((arm) => [arm, totals(result.runs.filter((r) => r.arm === arm))]));
}

/** Arms every one of whose runs ended on an API error: nothing was measured there. */
export function erroredArms(result: AbResult): AbArm[] {
  return result.arms.filter((arm) => {
    const runs = result.runs.filter((r) => r.arm === arm);
    return runs.length > 0 && runs.every((r) => r.stop === "error");
  });
}

const pct = (a: number, b: number) => (b > 0 ? `${a >= b ? "+" : ""}${(((a - b) / b) * 100).toFixed(0)}%` : "");

export function renderAb(result: AbResult): string {
  const out: string[] = [];
  out.push(`A/B quality: ${result.tasks.length} tasks, ${result.model}, ${result.repeat} run${result.repeat === 1 ? "" : "s"} per task and arm; ${formatUsd(result.spentUsd)} spent`);
  if (result.aborted) out.push(`Stopped early: ${result.aborted}. Runs not started are not in the tables.`);
  const cell = (runs: AbRun[]) => {
    const t = totals(runs);
    if (t.runs === 0) return "–";
    const verdict = t.runs === 1 ? (STOPPED_EARLY.has(runs[0].stop) ? runs[0].stop.toUpperCase().slice(0, 6) : runs[0].pass ? "PASS" : "FAIL") : `${t.passed}/${t.completed}${t.stoppedEarly ? "*" : ""}`;
    return `${verdict.padEnd(7)}${formatTokens(t.tokens / t.runs).padStart(6)} ${formatUsd(t.costUsd / t.runs).padStart(7)}`;
  };
  const rate = (t: ArmTotals) => (t.completed ? t.passed / t.completed : 0);
  for (const lever of result.levers) {
    const { base, arm, what } = LEVER_INFO[lever];
    out.push("", `${lever}: ${what}`);
    out.push(`${"task".padEnd(18)}${base.padEnd(24)}${arm}`);
    for (const id of result.tasks) {
      const of = (a: AbArm) => result.runs.filter((r) => r.task === id && r.arm === a);
      out.push(`${id.padEnd(18)}${cell(of(base)).padEnd(24)}${cell(of(arm))}`);
    }
    const b = totals(result.runs.filter((r) => r.arm === base));
    const l = totals(result.runs.filter((r) => r.arm === arm));
    out.push(`${"passed".padEnd(18)}${`${b.passed}/${b.completed} completed`.padEnd(24)}${l.passed}/${l.completed} completed`);
    if (b.stoppedEarly + l.stoppedEarly > 0) out.push(`${"stopped early".padEnd(18)}${String(b.stoppedEarly).padEnd(24)}${l.stoppedEarly}   (API error or refusal, budget, turn or token cap: left out of the pass counts)`);
    out.push(`${"tokens per run".padEnd(18)}${formatTokens(b.runs ? b.tokens / b.runs : 0).padEnd(24)}${formatTokens(l.runs ? l.tokens / l.runs : 0)} (${pct(l.tokens / (l.runs || 1), b.tokens / (b.runs || 1))})`);
    out.push(`${"cost".padEnd(18)}${formatUsd(b.costUsd).padEnd(24)}${formatUsd(l.costUsd)} (${pct(l.costUsd, b.costUsd)})`);
    const used =
      lever === "autoclear" ? `requests autopilot changed: ${l.leverUses}, tokens it kept off the wire: ${formatTokens(l.leverTokens)}`
      : lever === "pack" ? `pack_context calls: ${l.leverUses}`
      : lever === "compact" ? `compactions: ${b.leverUses} generic, ${l.leverUses} with the hook's instructions`
      : "rules in every request's system prompt";
    out.push(`${"lever".padEnd(18)}${used}`);
    if (b.completed === 0 || l.completed === 0) {
      out.push(`No completed runs on ${b.completed === 0 ? base : arm}: nothing to compare.`);
    } else if (b.completed === l.completed) {
      const diff = l.passed - b.passed;
      out.push(
        diff === 0 ? `Same pass count with and without ${lever} (${l.passed}/${l.completed}).`
        : diff > 0 ? `${diff} more pass${diff === 1 ? "" : "es"} with ${lever} (${l.passed}/${l.completed} vs ${b.passed}/${b.completed}).`
        : `${-diff} fewer pass${diff === -1 ? "" : "es"} with ${lever} (${l.passed}/${l.completed} vs ${b.passed}/${b.completed}): read those runs before trusting the lever.`
      );
    } else {
      const d = rate(l) - rate(b);
      out.push(
        Math.abs(d) < 1e-9 ? `Same pass rate with and without ${lever} over the completed runs (${l.passed}/${l.completed} vs ${b.passed}/${b.completed}).`
        : `${d > 0 ? "Higher" : "Lower"} pass rate with ${lever} over the completed runs (${l.passed}/${l.completed} vs ${b.passed}/${b.completed})${d < 0 ? ": read those runs before trusting the lever" : ""}.`
      );
    }
  }
  const dead = erroredArms(result);
  if (dead.length) out.push("", `Every run of ${dead.join(", ")} ended on an API error: nothing was measured there.`);
  out.push("", result.repeat < 3 ? "One task's difference is noise at this size: --repeat 3 or more for a figure worth publishing." : `${result.repeat} runs per task and arm.`);
  return out.join("\n");
}

// -- The command -----------------------------------------------------------------

export interface AbCommandOptions {
  levers?: string[];
  tasks?: string[];
  model?: string;
  repeat?: number;
  maxTurns?: number;
  concurrency?: number;
  budgetUsd?: number;
  /** Spend: without it the plan and estimate are printed and nothing is sent. */
  yes: boolean;
  json: boolean;
  out?: string;
  list: boolean;
}

/** Why `--out` cannot be written, checked before anything is spent; undefined when it can. */
function outProblem(out: string): string | undefined {
  const path = resolve(out);
  try {
    if (statSync(path).isDirectory()) return `--out ${out} is a folder`;
    accessSync(path, fsConstants.W_OK);
    return undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return `--out ${out} cannot be written (${(e as Error).message})`;
  }
  try {
    if (!statSync(dirname(path)).isDirectory()) return `--out ${out}: ${dirname(path)} is not a folder`;
    accessSync(dirname(path), fsConstants.W_OK);
    return undefined;
  } catch (e) {
    return `--out ${out} cannot be written (${(e as Error).message})`;
  }
}

/**
 * `context-doctor ab`: the exit code. 1 for a refusal, a bad argument, a key
 * the API refused, or an arm all of whose runs ended on an API error.
 */
export async function abCommand(o: AbCommandOptions): Promise<number> {
  const say = (line: string) => (o.json ? console.error(line) : console.log(line));
  if (o.list) {
    console.log("Tasks (each a tiny repository, a smoke test the agent can run, and a hidden check):");
    for (const t of AB_TASKS) console.log(`  ${t.id.padEnd(16)} ${t.title}${t.bigFile ? ` (big file: ${t.bigFile})` : ""}`);
    console.log("\nLevers (each run against its baseline arm):");
    for (const l of AB_LEVERS) console.log(`  ${l.padEnd(10)} ${LEVER_INFO[l].what}`);
    return 0;
  }
  const leverNames = (o.levers ?? []).flatMap((l) => l.split(",")).map((l) => l.trim()).filter(Boolean);
  const unknownLever = leverNames.find((l) => l !== "all" && !(AB_LEVERS as readonly string[]).includes(l));
  if (unknownLever) {
    console.error(`Unknown lever "${unknownLever}". Levers: ${AB_LEVERS.join(", ")}, or all.`);
    return 1;
  }
  const levers: AbLever[] = leverNames.length === 0 || leverNames.includes("all") ? [...AB_LEVERS] : [...new Set(leverNames as AbLever[])];
  const taskIds = (o.tasks ?? []).flatMap((t) => t.split(",")).map((t) => t.trim()).filter(Boolean);
  const unknownTask = taskIds.find((id) => !AB_TASKS.some((t) => t.id === id));
  if (unknownTask) {
    console.error(`Unknown task "${unknownTask}". Tasks: ${AB_TASKS.map((t) => t.id).join(", ")} (context-doctor ab --list).`);
    return 1;
  }
  const tasks = taskIds.length ? AB_TASKS.filter((t) => taskIds.includes(t.id)) : AB_TASKS;
  const model = o.model ?? DEFAULT_AB_MODEL;
  const pricing = exactClaudePricingFor(model);
  if (!pricing) {
    console.error(`No price is known for ${model} itself (only a guess from its family, or none), so ab cannot estimate or cap what it spends. Pick a Claude model in the price table (e.g. ${DEFAULT_AB_MODEL}, claude-sonnet-5-5).`);
    return 1;
  }
  if (o.out) {
    const problem = outProblem(o.out);
    if (problem) {
      console.error(`${problem}. Nothing was sent.`);
      return 1;
    }
  }
  const repeat = o.repeat ?? 1;
  const arms = armsFor(levers);
  const est = estimateAb(tasks, arms, repeat, pricing);
  const budget = o.budgetUsd ?? Math.max(1, Math.ceil(est.upperUsd * 1.25));
  const base = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "");
  say(`A/B quality suite: ${tasks.length} task${tasks.length === 1 ? "" : "s"} x ${arms.length} arms (${arms.join(", ")}) x ${repeat} = ${est.runs} runs on ${model}`);
  say(`Through the Anthropic Messages API at ${base}${process.env.ANTHROPIC_BASE_URL ? " (ANTHROPIC_BASE_URL)" : ""}.`);
  say(`Estimated cost: ~${formatUsd(est.expectedUsd)} with prompt caching, up to ~${formatUsd(est.upperUsd)} if nothing caches. No request is sent whose worst case would pass ${formatUsd(budget)} (--budget).`);
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
    onRun: (r, done, total) =>
      console.error(`[${done}/${total}] ${r.task} · ${r.arm} · ${STOPPED_EARLY.has(r.stop) ? `stopped (${r.stop})` : r.pass ? "PASS" : "FAIL"} · ${r.requests} requests · ${formatTokens(r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens + r.outputTokens)} tokens · ${formatUsd(r.costUsd)}${r.error ? ` · ${r.error}` : ""}`),
  });
  const json = JSON.stringify({ ...result, summary: summarizeAb(result) }, null, 2);
  if (o.out) writeFileSync(o.out, json + "\n");
  if (o.json) console.log(json);
  else console.log("\n" + renderAb(result) + (o.out ? `\n\nEvery run, as JSON: ${o.out}` : ""));
  if (result.aborted) console.error(`Stopped: ${result.aborted}.`);
  return result.aborted || erroredArms(result).length > 0 ? 1 : 0;
}
