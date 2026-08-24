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
import type { StrategyId } from "./optimize.js";
export declare const RC_FILENAME = ".contextdoctorrc";
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
/**
 * Load the nearest config. Malformed rc files are reported (so a typo is not
 * silently ignored) but never throw — the tool keeps working with defaults.
 */
export declare function loadConfig(startDir?: string, onWarn?: (msg: string) => void): LoadedConfig;
export interface BudgetVerdict {
    /** True when any configured limit is exceeded. */
    overBudget: boolean;
    /** Human-readable lines, one per breached limit. */
    breaches: string[];
    /** The token limit in force, when one is configured. */
    maxTokens?: number;
}
/** Compare a profile against the configured budget. */
export declare function checkBudget(budget: ContextBudget | undefined, profile: {
    totalTokens: number;
    usagePct?: number;
    cost?: {
        perCallUsd: number;
    };
}): BudgetVerdict;
