/**
 * The subagents' model: what they cost as billed, and what the same requests
 * would cost on a cheaper model, per agent type. The `subagent-model` lever
 * of `fix`.
 *
 * Claude Code reads `CLAUDE_CODE_SUBAGENT_MODEL` ("inherit" by default: a
 * subagent runs on the main conversation's model). Read from the 2.1.309
 * binary (the function that picks a subagent's model), highest first:
 *  1. the Agent call's own `model` parameter;
 *  2. the agent definition's `model` (an agent file's frontmatter; the
 *     built-ins: Explore, Plan and fork say "inherit", claude-code-guide
 *     "haiku", statusline-setup "sonnet"; general-purpose and claude name
 *     none);
 *  3. CLAUDE_CODE_SUBAGENT_MODEL, unless it is "inherit" or "default";
 *  4. the main conversation's model.
 * So the variable moves only the agents whose definition names no model
 * (general-purpose, claude, agents of your own without `model:`).
 * CLAUDE_CODE_SUBAGENT_MODEL_FORCE makes it win over 1 and 2 as well (forks
 * still inherit). 2.1.62 read the variable too, ahead of everything. Claude
 * Code applies every settings file's `env` block to its own process at
 * start, so the variable can live in ~/.claude/settings.json.
 *
 * The replay prices each subagent request twice: as billed (its recorded
 * usage at its model's list price, cache writes at each TTL's multiplier,
 * output as settled on the reply's last row), and at the candidate model,
 * for the requests the variable would move that ran on a pricier model.
 * The token counts stay as they were: an estimate, since another model
 * tokenizes differently and may take more or fewer steps for the same task.
 * Requests on a model no pricier than the candidate stay as billed.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pick, rowsOf, slimUsage, type Extractor } from "./scan.js";
import { pricingFor, usageCost, type ModelPricing, type RecordedUsage } from "./pricing.js";
import { realModel } from "./tokens.js";
import { claudeDir } from "./claudedir.js";
import { subagentTranscripts } from "./cachettl.js";
import { managedDir } from "./effective.js";
import { SUBAGENT_CANDIDATE, SUBAGENT_CANDIDATE_NAME } from "./subagentpay.js";

export { SUBAGENT_CANDIDATE, SUBAGENT_CANDIDATE_NAME };
/** The environment variable the lever writes. */
export const SUBAGENT_MODEL_ENV = "CLAUDE_CODE_SUBAGENT_MODEL";
export const SUBAGENT_MODEL_FORCE_ENV = "CLAUDE_CODE_SUBAGENT_MODEL_FORCE";
const HAIKU = "claude-haiku-5-5";
/** Haiku 5.5's per-token rates hold for prompts up to this size; longer prompts bill higher. */
const HAIKU_TIER = 100_000;

/** The model each built-in agent's definition names (2.1.309); undefined: none, so the variable applies. */
const BUILT_IN: Record<string, string | undefined> = {
  "general-purpose": undefined,
  claude: undefined,
  Explore: "inherit",
  Plan: "inherit",
  fork: "inherit",
  "claude-code-guide": "haiku",
  "statusline-setup": "sonnet",
};

/** Types that only read (no Edit or Write): the ones a smaller model is most often enough for. */
const READ_ONLY = new Set(["Explore", "Plan"]);

/**
 * One record per reply: its usage, time and model when first met; a top-up
 * of its output count when a later row of the same reply carries more
 * (subagent replies are written as they stream; output is final only on the
 * last row); the working folder once, to find the project's agent files.
 */
export const SUBAGENT_ROWS: Extractor<{ out: Record<string, number>; cwd: boolean }> = {
  id: "subagent-requests.1",
  init: () => ({ out: {}, cwd: false }),
  line(raw, row, out, st) {
    const usage = raw.includes('"usage"');
    if (!usage && (st.cwd || !raw.includes('"cwd"'))) return;
    let e: any;
    try { e = row(); } catch { return; }
    if (!e || typeof e !== "object") return;
    if (!st.cwd && typeof e.cwd === "string") {
      st.cwd = true;
      out.push({ t: "c", cwd: e.cwd });
    }
    const m = e.message;
    if (e.type !== "assistant" || !m || typeof m !== "object" || !m.usage) return;
    const o = Number(m.usage.output_tokens);
    const output = Number.isFinite(o) && o > 0 ? o : 0;
    const id = typeof m.id === "string" ? m.id : undefined;
    if (id && st.out[id] !== undefined) {
      if (output > st.out[id]) {
        out.push({ t: "o", id, more: output - st.out[id] });
        st.out[id] = output;
      }
      return;
    }
    if (id) st.out[id] = output;
    out.push({ t: "r", ...pick(e, ["uuid", "timestamp"]), id, model: m.model, usage: slimUsage(m.usage) });
  },
};

/** An agent's definition as far as the model goes: undefined when it names none. */
export interface AgentDefinition { model?: string; where: string }

/** The `.md` files under `dir`, subfolders included (Claude Code reads agent folders recursively). */
function markdownUnder(dir: string, out: string[] = [], seen = new Set<string>()): string[] {
  let real: string;
  try { real = realpathSync(dir); } catch { return out; }
  if (seen.has(real)) return out;
  seen.add(real);
  let entries: string[];
  try { entries = readdirSync(dir).sort(); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) markdownUnder(p, out, seen);
    else if (st.isFile() && e.endsWith(".md")) out.push(p);
  }
  return out;
}

/**
 * `name:` and `model:` from the frontmatter of the agent files under `dir`,
 * over what `into` holds (a later folder wins). Like Claude Code, a file
 * without a `name` or a `description` is not an agent.
 */
function definitionsIn(dir: string, into: Map<string, AgentDefinition>): void {
  for (const path of markdownUnder(dir)) {
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch { continue; }
    const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
    if (fm === undefined) continue;
    const field = (k: string) => new RegExp(`^${k}:[ \\t]*(.*)$`, "m").exec(fm)?.[1].trim().replace(/^["']|["']$/g, "") || undefined;
    const name = field("name");
    if (!name || !field("description")) continue;
    into.set(name, { model: field("model"), where: path });
  }
}

/**
 * The project folders whose `.claude/agents` apply in `cwd`, outermost
 * first: `cwd` and its parents up to the git root, never the home folder
 * or above it (the 2.1.309 binary: closer folders win over outer ones).
 */
function projectAgentDirs(cwd: string, home: string): string[] {
  const dirs: string[] = [];
  let d = resolve(cwd);
  const h = resolve(home);
  for (;;) {
    if (d === h) break;
    dirs.push(join(d, ".claude", "agents"));
    if (existsSync(join(d, ".git"))) break;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return dirs.reverse();
}

/**
 * The agent definitions Claude Code uses in `cwd`, as 2.1.309 merges them,
 * lowest first: the user's (~/.claude/agents), the project's (outer folders
 * first), then managed. Plugin agents are not read.
 */
export function agentDefinitions(cwd: string | undefined, home = homedir(), env: NodeJS.ProcessEnv = process.env): Map<string, AgentDefinition> {
  const defs = new Map<string, AgentDefinition>();
  definitionsIn(join(claudeDir(home, env), "agents"), defs);
  if (cwd) for (const d of projectAgentDirs(cwd, home)) definitionsIn(d, defs);
  const managed = managedDir(env);
  if (managed) definitionsIn(join(managed, ".claude", "agents"), defs);
  return defs;
}

/** How a type's model is chosen: whether CLAUDE_CODE_SUBAGENT_MODEL moves it, and why not. */
export function variableMoves(type: string, defs: Map<string, AgentDefinition>, force = false): { moves: boolean; why?: string } {
  if (type === "fork") return { moves: false, why: "a fork runs on the main conversation's model" };
  if (force) return { moves: true };
  if (type in BUILT_IN && !defs.has(type)) {
    const m = BUILT_IN[type];
    return m === undefined ? { moves: true } : { moves: false, why: m === "inherit" ? "built in, on the main conversation's model" : `built in, on ${m}` };
  }
  const d = defs.get(type);
  if (!d) return { moves: false, why: type === "unknown" ? "no agent type recorded beside it (an older Claude Code)" : "its agent file was not found here" };
  if (!d.model) return { moves: true };
  return { moves: false, why: `its file says model: ${d.model}` };
}

export interface TypeReplay {
  type: string;
  agents: number;
  requests: number;
  billedUsd: number;
  /** The same requests with the ones the variable moves at the candidate model. */
  atCandidateUsd: number;
  /** Every request of this type at Haiku 5.5's base rates (a floor: see over100k). */
  atHaikuUsd: number;
  /** Requests whose prompt was over 100k tokens, which Haiku 5.5 bills at a higher rate not priced here. */
  over100k: number;
  moves: boolean;
  why?: string;
  readOnly: boolean;
}

export interface SubagentModelReplay {
  candidate: string;
  agents: number;
  requests: number;
  billedUsd: number;
  atCandidateUsd: number;
  /** billed - at candidate. */
  savedUsd: number;
  /** The moved requests' bill by the model they ran on (the names in the plan's title). */
  movedFrom: Record<string, number>;
  /**
   * Every request of the types the variable moves, Sonnet-or-cheaper ones
   * included, by the model it ran on, weighted by its tokens (priced at the
   * candidate's rates): the mix "saved since" prices those types at after
   * the change, when every one of them is on the candidate.
   */
  before: Record<string, number>;
  /** Requests on models with no price (left out of the dollars). */
  unpriced: number;
  byType: TypeReplay[];
}

export interface SubagentModelOptions {
  since: number;
  until?: number;
  /** Subagent transcripts (default: those written since `since`). */
  paths?: string[];
  candidate?: string;
  /** CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on: the variable moves every type but forks. */
  force?: boolean;
  /** Agent definitions for every subagent (default: per subagent's folder, as agentDefinitions merges them). */
  definitions?: Map<string, AgentDefinition>;
  home?: string;
  /** Price every moved request at this mix of models (shares adding to 1) instead of the candidate: "saved since". */
  baseline?: Record<string, number>;
}

/** The agent type Claude Code recorded beside a subagent's transcript ("unknown" for an older one without it). */
export function agentTypeOf(transcript: string): string {
  try {
    const meta = JSON.parse(readFileSync(transcript.replace(/\.jsonl$/, ".meta.json"), "utf8"));
    if (typeof meta?.agentType === "string" && meta.agentType) return meta.agentType;
  } catch {
    /* older Claude Code: no meta */
  }
  return "unknown";
}

const tokens = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const promptTokens = (u: RecordedUsage) => tokens(u?.input_tokens) + tokens(u?.cache_read_input_tokens) + tokens(u?.cache_creation_input_tokens);
/** The rates of a mix of models (shares adding to 1); undefined when none has a price. */
function blend(mix: Record<string, number>): ModelPricing | undefined {
  const parts = Object.entries(mix).map(([m, w]) => [pricingFor(m), w] as const).filter((x): x is readonly [ModelPricing, number] => !!x[0] && x[1] > 0);
  const total = parts.reduce((s, [, w]) => s + w, 0);
  if (!(total > 0)) return undefined;
  const rate = (k: keyof ModelPricing) => parts.reduce((s, [p, w]) => s + (p[k] * w) / total, 0);
  return { inputPerM: rate("inputPerM"), outputPerM: rate("outputPerM"), cacheReadPerM: rate("cacheReadPerM") };
}

const cheaper = (a: ModelPricing, b: ModelPricing) => a.inputPerM < b.inputPerM || (a.inputPerM === b.inputPerM && a.outputPerM < b.outputPerM);

/**
 * Replay every subagent request in [since, until): as billed, and with the
 * requests CLAUDE_CODE_SUBAGENT_MODEL would move at the candidate model.
 * With `baseline`, the other arm prices the moved requests at the mix of
 * models they ran on before the change (prices are linear in each rate, so
 * a request at the blended rates costs the blend of its costs).
 */
export function replaySubagentModels(opts: SubagentModelOptions): SubagentModelReplay {
  const candidate = opts.candidate ?? SUBAGENT_CANDIDATE;
  const cand = pricingFor(candidate)!;
  const haiku = pricingFor(HAIKU)!;
  const base = opts.baseline ? blend(opts.baseline) : undefined;
  const until = opts.until ?? Infinity;
  const home = opts.home ?? homedir();
  const paths = opts.paths ?? subagentTranscripts(opts.since, home);
  // Each project's agents, read the first time a subagent of that folder is met.
  const defsByCwd = new Map<string, Map<string, AgentDefinition>>();
  const defsFor = (cwd: unknown): Map<string, AgentDefinition> => {
    if (opts.definitions) return opts.definitions;
    const key = typeof cwd === "string" ? cwd : "";
    let d = defsByCwd.get(key);
    if (!d) defsByCwd.set(key, (d = agentDefinitions(key || undefined, home)));
    return d;
  };
  const types = new Map<string, TypeReplay>();
  const movedBy = new Map<string, number>();
  const beforeBy = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  const seen = new Set<string>();
  let unpriced = 0;
  for (const p of paths) {
    let rows: any[];
    try { rows = rowsOf(p, SUBAGENT_ROWS); } catch { continue; }
    const type = agentTypeOf(p);
    const how = variableMoves(type, defsFor(rows.find((r) => r?.t === "c")?.cwd), opts.force);
    const t = types.get(type) ?? types.set(type, { type, agents: 0, requests: 0, billedUsd: 0, atCandidateUsd: 0, atHaikuUsd: 0, over100k: 0, moves: how.moves, why: how.why, readOnly: READ_ONLY.has(type) }).get(type)!;
    // One project's file may name a model where another's does not: the type moves where any of its runs does.
    if (how.moves) t.moves = true;
    // Per reply of this file: the prices its output top-ups are charged at.
    const priced = new Map<string, { billed: ModelPricing; other: ModelPricing; model: string }>();
    let counted = false;
    for (const r of rows) {
      if (r?.t === "o") {
        const q = priced.get(r.id);
        if (!q) continue;
        t.billedUsd += (r.more * q.billed.outputPerM) / 1e6;
        t.atCandidateUsd += (r.more * q.other.outputPerM) / 1e6;
        t.atHaikuUsd += (r.more * haiku.outputPerM) / 1e6;
        if (how.moves) add(beforeBy, q.model, (r.more * cand.outputPerM) / 1e6);
        continue;
      }
      if (r?.t !== "r") continue;
      const model = realModel(r.model);
      if (!model) continue;
      const at = Date.parse(String(r.timestamp ?? ""));
      if (!Number.isFinite(at) || at < opts.since || at >= until) continue;
      // The same reply in another subagent file (a copied or resumed transcript): billed once.
      if (r.id) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
      }
      const price = pricingFor(model);
      if (!price) { unpriced++; continue; }
      const u = r.usage as RecordedUsage;
      const billed = usageCost(u, price).totalUsd;
      const target = base ?? cand;
      const move = how.moves && (base ? true : cheaper(cand, price));
      const other = move ? target : price;
      t.requests++;
      counted = true;
      t.billedUsd += billed;
      t.atCandidateUsd += move ? usageCost(u, other).totalUsd : billed;
      t.atHaikuUsd += usageCost(u, haiku).totalUsd;
      if (promptTokens(u) > HAIKU_TIER) t.over100k++;
      if (move) add(movedBy, model, billed);
      if (how.moves) add(beforeBy, model, usageCost(u, cand).totalUsd);
      if (r.id) priced.set(r.id, { billed: price, other, model });
    }
    if (counted) t.agents++;
  }
  const byType = [...types.values()].filter((t) => t.requests > 0).sort((a, b) => b.billedUsd - a.billedUsd);
  const sum = (k: "agents" | "requests" | "billedUsd" | "atCandidateUsd") => byType.reduce((s, t) => s + t[k], 0);
  const sorted = (m: Map<string, number>) => Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
  return { candidate, agents: sum("agents"), requests: sum("requests"), billedUsd: sum("billedUsd"), atCandidateUsd: sum("atCandidateUsd"), savedUsd: sum("billedUsd") - sum("atCandidateUsd"), movedFrom: sorted(movedBy), before: sorted(beforeBy), unpriced, byType };
}

/** The models the moved requests ran on, for people: the one or two that carry 10%+ of the bill ("Fable 5.1 or Opus 5.5"). */
export function movedFromNames(movedFrom: Record<string, number>): string | undefined {
  const all = Object.entries(movedFrom);
  const total = all.reduce((s, [, v]) => s + v, 0);
  const names = [...new Set(all.filter(([, v]) => v >= 0.1 * total).slice(0, 2).map(([m]) => modelName(m)))];
  return names.length ? names.join(" or ") : undefined;
}

/** Each model's share of a total by model (a fix record keeps the shares of `before` as the baseline). */
export function shares(byModel: Record<string, number>): Record<string, number> {
  const total = Object.values(byModel).reduce((s, v) => s + v, 0);
  return total > 0 ? Object.fromEntries(Object.entries(byModel).map(([m, v]) => [m, v / total])) : {};
}

/** A model id for people: "claude-opus-5-5" as "Opus 5.5". */
export function modelName(model: string | undefined): string {
  const m = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(model ?? "");
  if (!m) return model ?? "their model";
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

const usd = (n: number): string => (Math.abs(n) >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);

/** The per-type lines under the lever in `fix`. */
export function renderSubagentTypes(r: SubagentModelReplay): string[] {
  const name = r.candidate === SUBAGENT_CANDIDATE ? SUBAGENT_CANDIDATE_NAME : modelName(r.candidate);
  const col = `at ${name}`;
  const out = [`${"by type".padEnd(20)}${"runs".padStart(6)}${"as billed".padStart(11)}${col.padStart(col.length + 3)}`];
  for (const t of r.byType) {
    const head = `${t.type.slice(0, 19).padEnd(20)}${String(t.agents).padStart(6)}${usd(t.billedUsd).padStart(11)}`;
    out.push(head + (t.moves ? usd(t.atCandidateUsd).padStart(col.length + 3) : `   unchanged: ${t.why}`));
  }
  const ro = r.byType.filter((t) => t.readOnly);
  if (ro.length) {
    const billed = ro.reduce((s, t) => s + t.billedUsd, 0);
    const haiku = ro.reduce((s, t) => s + t.atHaikuUsd, 0);
    const over = ro.reduce((s, t) => s + t.over100k, 0);
    const reqs = ro.reduce((s, t) => s + t.requests, 0);
    const what = `Read-only work (${ro.map((t) => t.type).join(", ")}, ${usd(billed)}) at Haiku 5.5`;
    // Haiku 5.5's rates hold to 100k-token prompts; above that it bills a tier the price table does not hold.
    if (over === 0) out.push(`${what}: ~${usd(haiku)}.`);
    else if (over <= 0.1 * reqs) out.push(`${what}: over ~${usd(haiku)} (${over} of ${reqs} requests had prompts over 100k tokens, which Haiku bills higher).`);
    else out.push(`${what}: not priced, ${over} of ${reqs} requests had prompts over 100k tokens, where Haiku bills a higher rate.`);
    out.push("Only an agent of your own runs there (`model: haiku` in its file); the built-ins keep the main conversation's model.");
  }
  return out;
}

/**
 * What the change saved since `since`: the moved types' requests priced at
 * the model they ran on before it, against as billed (an estimate, the same
 * token counts either way).
 */
export function subagentModelSavedSince(since: number, before: Record<string, number> | undefined, paths?: string[]): { usd: number; requests: number } {
  if (!before || !blend(before)) return { usd: 0, requests: 0 };
  const r = replaySubagentModels({ since, paths, baseline: before });
  return { usd: r.atCandidateUsd - r.billedUsd, requests: r.byType.filter((t) => t.moves).reduce((s, t) => s + t.requests, 0) };
}
