/**
 * Project configuration and context budgets (`.contextdoctorrc`).
 *
 * Discovery walks up from the working directory to the filesystem root, then
 * falls back to ~/.contextdoctorrc — so a repo can set its own budget and a
 * user can set a machine-wide default. First file found wins (no merging:
 * one visible file is easier to reason about than a merge chain).
 *
 * Everything here is optional. With no rc file the tool behaves exactly as
 * it always has.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse as parsePath } from "node:path";
import type { StrategyId } from "./optimize.js";

export const RC_FILENAME = ".contextdoctorrc";

export interface ContextBudget {
  /** Warn once a session/conversation exceeds this many tokens. */
  maxTokens?: number;
  /** Warn once estimated input cost per message exceeds this many USD. */
  maxCostPerMessageUsd?: number;
  /** Warn once the context fills this share of the model window (0-100). */
  maxWindowPct?: number;
}

export interface ContextDoctorConfig {
  budget?: ContextBudget;
  /** Default optimize strategies for this project. */
  strategies?: StrategyId[];
  keepRecent?: number;
  maxToolResultTokens?: number;
  /** Proxy per-model overrides, same shape as `proxy --config`. */
  routes?: Array<{
    modelPrefix: string;
    strategies?: StrategyId[];
    keepRecent?: number;
    maxToolResultTokens?: number;
  }>;
  /** Model used for cost math when a conversation does not name one. */
  model?: string;
}

export interface LoadedConfig {
  config: ContextDoctorConfig;
  /** Absolute path of the rc file, or undefined when none was found. */
  path?: string;
  /** Settings that will be silently ignored, if any. */
  warnings?: string[];
}

/** Candidate rc paths: cwd upwards, then the home directory. */
function candidatePaths(startDir: string): string[] {
  const paths: string[] = [];
  let dir = startDir;
  const { root } = parsePath(dir);
  for (;;) {
    paths.push(join(dir, RC_FILENAME));
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const home = join(homedir(), RC_FILENAME);
  if (!paths.includes(home)) paths.push(home);
  return paths;
}

/**
 * Load the nearest config. Malformed rc files are reported (so a typo is not
 * silently ignored) but never throw — the tool keeps working with defaults.
 */
/** Strategy ids the optimizer actually implements. */
const KNOWN_STRATEGIES = new Set(["dedupe", "trim-tool-results", "trim-tool-calls", "strip-base64", "prune-history"]);
const KNOWN_KEYS = new Set(["budget", "strategies", "keepRecent", "maxToolResultTokens", "routes", "model"]);
const KNOWN_BUDGET_KEYS = new Set(["maxTokens", "maxCostPerMessageUsd", "maxWindowPct"]);

/**
 * Report anything in an rc file that will be silently ignored.
 *
 * Every invalid value here fails quietly and looks like the feature not
 * working: `"trim-tool-result"` (missing s) trims nothing, a negative
 * keepRecent disables trimming entirely, and a budget written as a string is
 * never compared against. For a tool whose whole job is measurement, silently
 * doing nothing is the worst available behaviour.
 */
export function validateConfig(config: unknown, path: string): string[] {
  const warnings: string[] = [];
  const where = (key: string): string => `${path}: ${key}`;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return [`${path}: expected a JSON object`];
  }
  const c = config as Record<string, unknown>;

  for (const key of Object.keys(c)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(`${where(key)} is not a known setting — ignored (known: ${[...KNOWN_KEYS].join(", ")})`);
    }
  }

  if (c.budget !== undefined) {
    if (typeof c.budget !== "object" || c.budget === null || Array.isArray(c.budget)) {
      warnings.push(`${where("budget")} must be an object — ignored`);
    } else {
      const budget = c.budget as Record<string, unknown>;
      for (const [key, value] of Object.entries(budget)) {
        if (!KNOWN_BUDGET_KEYS.has(key)) {
          warnings.push(`${where(`budget.${key}`)} is not a known budget limit — ignored`);
        } else if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
          warnings.push(`${where(`budget.${key}`)} must be a positive number, got ${JSON.stringify(value)} — this limit will never trigger`);
        }
      }
      if (typeof budget.maxWindowPct === "number" && budget.maxWindowPct > 100) {
        warnings.push(`${where("budget.maxWindowPct")} is above 100 — a percentage of the context window cannot exceed 100`);
      }
    }
  }

  if (c.strategies !== undefined) {
    if (!Array.isArray(c.strategies)) {
      warnings.push(`${where("strategies")} must be an array — ignored`);
    } else {
      for (const id of c.strategies) {
        if (!KNOWN_STRATEGIES.has(String(id))) {
          warnings.push(`${where("strategies")}: "${id}" is not a strategy — ignored (known: ${[...KNOWN_STRATEGIES].join(", ")})`);
        }
      }
    }
  }

  for (const key of ["keepRecent", "maxToolResultTokens"] as const) {
    const value = c[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      warnings.push(`${where(key)} must be a positive whole number, got ${JSON.stringify(value)} — ignored`);
    }
  }

  if (c.routes !== undefined && !Array.isArray(c.routes)) {
    warnings.push(`${where("routes")} must be an array — ignored`);
  }
  return warnings;
}

export function loadConfig(startDir: string = process.cwd(), onWarn?: (msg: string) => void): LoadedConfig {
  for (const path of candidatePaths(startDir)) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as ContextDoctorConfig;
      // Arrays are objects too, hence the explicit check.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const warnings = validateConfig(parsed, path);
        for (const warning of warnings) onWarn?.(warning);
        return { config: parsed, path, warnings };
      }
      onWarn?.(`${path}: expected a JSON object — ignoring`);
    } catch (e) {
      onWarn?.(`${path}: ${(e as Error).message} — ignoring`);
    }
    return { config: {} };
  }
  return { config: {} };
}

export interface BudgetVerdict {
  /** True when any configured limit is exceeded. */
  overBudget: boolean;
  /** Human-readable lines, one per breached limit. */
  breaches: string[];
  /** The token limit in force, when one is configured. */
  maxTokens?: number;
}

/** Compare a profile against the configured budget. */
export function checkBudget(
  budget: ContextBudget | undefined,
  profile: { totalTokens: number; usagePct?: number; cost?: { perCallUsd: number } }
): BudgetVerdict {
  const breaches: string[] = [];
  if (!budget) return { overBudget: false, breaches };

  if (budget.maxTokens !== undefined && profile.totalTokens > budget.maxTokens) {
    breaches.push(`context is ${profile.totalTokens} tokens, over the ${budget.maxTokens} budget`);
  }
  if (
    budget.maxCostPerMessageUsd !== undefined &&
    profile.cost !== undefined &&
    profile.cost.perCallUsd > budget.maxCostPerMessageUsd
  ) {
    breaches.push(
      `input cost is $${profile.cost.perCallUsd.toFixed(3)} per message, over the $${budget.maxCostPerMessageUsd.toFixed(3)} budget`
    );
  }
  if (budget.maxWindowPct !== undefined && profile.usagePct !== undefined && profile.usagePct > budget.maxWindowPct) {
    breaches.push(`context fills ${profile.usagePct.toFixed(0)}% of the window, over the ${budget.maxWindowPct}% budget`);
  }
  return { overBudget: breaches.length > 0, breaches, maxTokens: budget.maxTokens };
}

/**
 * Starting points for `.contextdoctorrc`.
 *
 * An empty rc file is technically valid and completely useless: nobody knows
 * what a reasonable token budget is for their kind of work until they have
 * blown through one. These encode the three shapes that actually differ —
 * a chat product, a coding agent, and a batch pipeline — so a budget can be
 * adopted in one command and tuned later.
 */
export interface Preset {
  id: string;
  summary: string;
  config: ContextDoctorConfig;
}

export const PRESETS: Preset[] = [
  {
    id: "chat",
    summary: "Interactive chat product — short contexts, latency matters most",
    config: {
      // Chat turns are small; a context this large means history is not being
      // summarized, and every extra token is felt directly as time-to-first-token.
      budget: { maxTokens: 30_000, maxWindowPct: 40, maxCostPerMessageUsd: 0.15 },
      strategies: ["dedupe", "strip-base64"],
      keepRecent: 10,
    },
  },
  {
    id: "agent",
    summary: "Coding or tool-using agent — long runs, tool output dominates",
    config: {
      // Agents legitimately hold a lot of context, so the budget is generous;
      // the tight controls go on tool traffic, which is where the waste is.
      budget: { maxTokens: 150_000, maxWindowPct: 70, maxCostPerMessageUsd: 1.5 },
      strategies: ["dedupe", "trim-tool-results", "strip-base64"],
      keepRecent: 6,
      maxToolResultTokens: 300,
    },
  },
  {
    id: "batch",
    summary: "Batch or pipeline jobs — cost per call is the whole story",
    config: {
      // Nothing is interactive, so aggressive trimming costs nothing in feel
      // and everything is multiplied by the number of items in the run.
      budget: { maxTokens: 60_000, maxCostPerMessageUsd: 0.05 },
      strategies: ["dedupe", "trim-tool-results", "trim-tool-calls", "strip-base64"],
      keepRecent: 4,
      maxToolResultTokens: 150,
    },
  },
];

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
