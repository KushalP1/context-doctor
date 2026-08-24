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
export function loadConfig(startDir: string = process.cwd(), onWarn?: (msg: string) => void): LoadedConfig {
  for (const path of candidatePaths(startDir)) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as ContextDoctorConfig;
      if (parsed && typeof parsed === "object") return { config: parsed, path };
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
