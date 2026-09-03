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
export const RC_FILENAME = ".contextdoctorrc";
/** Candidate rc paths: cwd upwards, then the home directory. */
function candidatePaths(startDir) {
    const paths = [];
    let dir = startDir;
    const { root } = parsePath(dir);
    for (;;) {
        paths.push(join(dir, RC_FILENAME));
        if (dir === root)
            break;
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    const home = join(homedir(), RC_FILENAME);
    if (!paths.includes(home))
        paths.push(home);
    return paths;
}
/**
 * Load the nearest config. Malformed rc files are reported (so a typo is not
 * silently ignored) but never throw — the tool keeps working with defaults.
 */
export function loadConfig(startDir = process.cwd(), onWarn) {
    for (const path of candidatePaths(startDir)) {
        if (!existsSync(path))
            continue;
        try {
            const parsed = JSON.parse(readFileSync(path, "utf8"));
            if (parsed && typeof parsed === "object")
                return { config: parsed, path };
            onWarn?.(`${path}: expected a JSON object — ignoring`);
        }
        catch (e) {
            onWarn?.(`${path}: ${e.message} — ignoring`);
        }
        return { config: {} };
    }
    return { config: {} };
}
/** Compare a profile against the configured budget. */
export function checkBudget(budget, profile) {
    const breaches = [];
    if (!budget)
        return { overBudget: false, breaches };
    if (budget.maxTokens !== undefined && profile.totalTokens > budget.maxTokens) {
        breaches.push(`context is ${profile.totalTokens} tokens, over the ${budget.maxTokens} budget`);
    }
    if (budget.maxCostPerMessageUsd !== undefined &&
        profile.cost !== undefined &&
        profile.cost.perCallUsd > budget.maxCostPerMessageUsd) {
        breaches.push(`input cost is $${profile.cost.perCallUsd.toFixed(3)} per message, over the $${budget.maxCostPerMessageUsd.toFixed(3)} budget`);
    }
    if (budget.maxWindowPct !== undefined && profile.usagePct !== undefined && profile.usagePct > budget.maxWindowPct) {
        breaches.push(`context fills ${profile.usagePct.toFixed(0)}% of the window, over the ${budget.maxWindowPct}% budget`);
    }
    return { overBudget: breaches.length > 0, breaches, maxTokens: budget.maxTokens };
}
export const PRESETS = [
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
export function findPreset(id) {
    return PRESETS.find((p) => p.id === id);
}
