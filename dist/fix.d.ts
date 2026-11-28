/**
 * `context-doctor fix`: the findings as one plan, applied with consent,
 * undone in one step, and re-measured afterwards.
 *
 * Every lever below already existed as its own command, and on the author's
 * own machine none of the big ones was applied (the compact window unset,
 * $1,423 a month of input it would have saved; the cold-resume offer
 * followed 1 time in 33): a user had to read several reports and type the
 * right command for each. `fix` measures them all on the user's history,
 * ranks them by dollars, says what each changes and what it costs in
 * quality, and applies a fix only on a yes (or an explicit `--apply`).
 *
 * Every fix is one setting Claude Code (or autopilot) reads, written with a
 * backup and recorded in ~/.claude/.context-doctor-fixes.json with its
 * previous value; `fix undo` puts back exactly that. Later runs say what each
 * applied fix saved since, measured on the sessions after it:
 *  - the cache lifetime: the requests since, priced as billed against the
 *    lifetime they had before (the 1-hour share measured when it was set);
 *    the same content either way, so the replay is exact up to prices;
 *  - the compact window: each compaction since that came before the old
 *    window, priced as the context it removed from every later request until
 *    the session would have reached the old window, less the compaction's
 *    own request and summary (an estimate: what the summary dropped is not
 *    priced);
 *  - autopilot: what the proxy recorded saving since (its own ledger);
 *  - the subagents' model: the requests it moved, priced at the model they
 *    ran on before against as billed (the same token counts: an estimate);
 *  - long Bash output: the results moved to a file that the cap before left
 *    inline, priced at the requests that re-read them no more (an estimate:
 *    a file the model opens again is not counted);
 *  - subagent progress summaries: the summaries Claude Code would have
 *    written for the background subagents since (2.1.318+, which read the
 *    variable), estimated as `spend` estimates them (progresssummaries.ts);
 *  - prompt suggestions: the turn ends since that one could have followed,
 *    priced as each would have cost (sidecost.ts), at the share of turn ends
 *    that sent one in the period before (an estimate).
 *
 * The subagents' model is the one lever with a quality cost `fix` cannot
 * measure from history: its quality line quotes the newest `ab --via
 * claude-code` comparison when there is one (abstore.ts), and says so when
 * there is none. It is applied only when named (never by `--apply all`),
 * and never over a value the user set.
 */
import { type CacheTtlReport, type CurrentTtl } from "./cachettl.js";
import { type ClaudeCodeInstall } from "./modelswitch.js";
import type { SessionHost } from "./starts.js";
import { type ProjectPlan } from "./prune.js";
import { type DeferEntry } from "./mcpdefer.js";
import { type ToolsLine } from "./apptools.js";
import { readLedger } from "./ledger.js";
import { type AbStoredResult } from "./abstore.js";
import { type SubagentModelReplay } from "./subagentmodel.js";
import { type ToolOutputReplay } from "./tooloutput.js";
import { type ProgressSummaryEstimate, type SummaryRoute } from "./progresssummaries.js";
import { type CodexCompactReport } from "./codexcompact.js";
export type FixId = "compact-window" | "cache-ttl" | "cache-ttl-subagents" | "autopilot" | "tool-search" | "prune" | "subagent-model" | "tool-output" | "codex-compact" | "progress-summaries" | "mcp-defer" | "desktop-tools-defer" | "prompt-suggestions";
export interface Fix {
    id: FixId;
    title: string;
    /** Saved over the measured period, when it can be priced. */
    savedUsd?: number;
    savedShare?: number;
    /** What the share is of, when it is not the input the plan's first line names ("of subagents"). */
    shareOf?: string;
    /** How the figure was measured. */
    basis: string;
    /** What it costs in quality, plainly. */
    quality: string;
    /**
     * The quality line is "none": the model sees the same content, or the same
     * content moved where it can still open it, and runs on the same model. A
     * bare `context-doctor` offers these together under one question (firstfix.ts).
     */
    qualityFree?: boolean;
    /** What it writes, where. */
    change: string;
    state: "available" | "applied" | "not-here";
    /** Why not here, or what is already applied. */
    note?: string;
    /** The value it writes. */
    value?: number | string | boolean;
    /** What would keep it from taking effect (environment, project or managed settings, per-model values). */
    overriddenBy?: string[];
    /** Installed Claude Code versions older than the setting: they ignore it (named, not blocked). */
    tooOld?: string;
    /** More lines under it in the plan (the subagents' model: per agent type). */
    detail?: string[];
    /**
     * desktop-tools-defer: the tool loads compactions would have cost with the
     * servers behind tool search (#111915: loaded tools are deferred again after
     * a compaction). `reloads` counts each server once per compaction, over
     * `compactions` of the period's `ofCompactions`; `usd` is already taken off
     * `savedUsd`.
     */
    reloadsAfterCompaction?: {
        reloads: number;
        compactions: number;
        ofCompactions: number;
        usd: number;
        unpriced?: number;
    };
}
/** The measurements a plan is made from (so the plan itself is testable without a machine's history). */
export interface FixInputs {
    days: number;
    /** Input billed over the period, the sessions `savings` counts. */
    billedUsd: number;
    compactWindow?: {
        window: number;
        savedUsd: number;
        savedShare: number;
        compactionsPerWeek: number;
        nowPerWeek: number;
        current?: number;
        /**
         * The Desktop app's own window offer and the server's windows (appwindow.ts), when any is on file:
         * what to say under the lever, the models answered (by name), and the sessions on them left as they ran.
         */
        app?: {
            lines: string[];
            answered: string[];
            leftSessions: number;
        };
    };
    ttl?: CacheTtlReport;
    currentTtl?: CurrentTtl;
    autopilot?: {
        on: boolean;
        reachableUsd: number;
        reachableShare: number;
        unreachableSessions: number;
        sessions: number;
    };
    /** ENABLE_TOOL_SEARCH in Claude Code's settings env, when it switches tool search off. */
    toolSearchOff?: string;
    /** MCP servers configured for Claude Code (user and this project), for the tool-search fix. */
    mcpServers?: number;
    /** This folder's project, when `overhead prune` finds unused servers or skills in it. */
    prune?: ProjectPlan;
    /** Per fix, what would keep the value fix writes from taking effect. */
    overrides?: Partial<Record<FixId, string[]>>;
    /** The record of applied fixes could not be read. */
    recordProblem?: string;
    /** Every subagent request replayed at Sonnet 5.5 (subagentmodel.ts). */
    subagentModel?: SubagentModelReplay;
    /** The newest kept `ab --via claude-code` comparison of the candidate with another model (abstore.ts): the subagent-model line quotes it. */
    abComparison?: AbStoredResult;
    /** CLAUDE_CODE_SUBAGENT_MODEL as the user set it (their settings.json env, or the environment fix runs in): never overwritten. */
    subagentModelSet?: {
        value: string;
        where: string;
    };
    /** The /compact offer at cold returns: advice, not a setting; `hooked` when the every-prompt hook (or the plugin) is there to make it. */
    coldResume?: {
        netUsd: number;
        returns: number;
        hooked: boolean;
    };
    /** Keeping the cache warm while away, at the cap that nets most on this history (coldreturns.ts): a per-session command of the plugin's mod, not a setting. */
    keepWarm?: {
        hours: number;
        netUsd: number;
        pingUsd: number;
        keptWarm: number;
        returns: number;
    };
    /** Every Bash and MCP result replayed at lower caps (tooloutput.ts). */
    toolOutput?: ToolOutputReplay;
    /** bashOutputMaxChars in the user's settings.json, or BASH_MAX_OUTPUT_LENGTH as the user set it (the setting would replace it): never overwritten. */
    toolOutputSet?: {
        name: string;
        value: string | number;
        where: string;
    };
    /** Codex's rollouts replayed at earlier auto-compact limits (codexcompact.ts). */
    codexCompact?: CodexCompactReport;
    /** The Claude Code installs found here (CLI and desktop app), to name the ones a setting is too new for. */
    claudeCodeInstalls?: ClaudeCodeInstall[];
    /**
     * The entrypoints and versions the period's sessions ran on (starts.ts
     * sessionHosts): an install too old for a setting that ran none of them is
     * still named, with "no session ran there".
     */
    sessionHosts?: SessionHost[];
    /** model_auto_compact_token_limit at the top of the user's config.toml, as written: never overwritten. */
    codexCompactSet?: {
        raw: string;
        where: string;
    };
    /** The subagents' progress summaries Claude Code wrote, estimated (progresssummaries.ts). */
    progressSummaries?: ProgressSummaryEstimate;
    /** CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES where it is set (progressSummariesState): never overwritten. */
    progressSummariesSet?: {
        value: string;
        where: string;
    };
    /**
     * MCP servers in the user's own config whose tool definitions went whole
     * into session and subagent starts (starts.ts), each with its share of what
     * re-reading them cost over the period.
     */
    mcpDefer?: {
        servers: Array<{
            name: string;
            scope: string;
            tokens: number;
            usd: number;
        }>;
        days: number;
    };
    /**
     * The Desktop app's own MCP servers whose tools went whole into starts
     * (starts.ts deferrableApp): per server, its starts, the ones whose session
     * or subagent called it, its share of the starts' cost as `overhead` lists
     * it, the part from starts that never called it, and (counted the same way)
     * the part from starts that did.
     */
    desktopTools?: {
        servers: Array<{
            name: string;
            tools: number;
            tokens: number;
            starts: number;
            calledStarts: number;
            usd: number;
            unusedUsd: number;
            calledUsd?: number;
        }>;
        days: number;
        /** The period's compactions and, per compaction, each server called after it with what loading it again would cost (starts.ts; #111915). */
        compactions?: {
            total: number;
            after: Array<Array<{
                server: string;
                usd: number;
                unpriced?: true;
            }>>;
        };
    };
    /** CONTEXT_DOCTOR_DEFER_MCP where the user (or fix) set it: applied, never overwritten. */
    desktopToolsSet?: {
        value: string;
        where: string;
    };
    /**
     * The MCP servers context-doctor's mod saw Claude Code hand over, one line
     * per session (apptools.ts): whether the lever reaches the app's servers
     * here, and after applying, the sessions it moved them in.
     */
    appToolsSeen?: ToolsLine[];
    /**
     * The context-doctor plugin Claude Code downloaded (installed_plugins.json),
     * when it is enabled: a lever waiting on a ledger that plugin is too old to
     * write says so, not "run fix again after one" (I4).
     */
    pluginVersion?: string;
    /** Claude Code's prompt suggestions over the period, counted from its cost-state (measurePromptSuggestions). */
    promptSuggestions?: PromptSuggestionEstimate;
    /** promptSuggestionEnabled in the user's settings.json, or CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION off (promptSuggestionsState): never overwritten. */
    promptSuggestionsSet?: {
        value: string;
        where: string;
        off: boolean;
    };
}
/**
 * Prompt suggestions: after a main-thread turn ends, Claude Code asks the
 * session's model for the grey "what you might type next" line, a request
 * that re-reads the whole conversation from the cache (sidecost.ts). No
 * transcript row records one; Claude Code's own cost record (`cost-state`)
 * counts each, so the count is what its input beyond ours has room for, at
 * ~506 input tokens apiece (ccost.ts suggestionsInGap): an estimate, and only
 * on sessions that wrote such a record.
 *
 * Read from the 2.1.332 binary (the same in 2.1.311 and 2.1.331, the oldest
 * and newest others here): `promptSuggestionEnabled: false` in settings.json
 * turns them off ("When false, prompt suggestions are disabled. When absent
 * or true, prompt suggestions are enabled"; /config's "Prompt suggestions"
 * row writes the same key), in a terminal and in the Desktop app and SDK
 * hosts alike. CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, read as true or false,
 * wins over the setting either way. The changelog has the /config toggle from
 * 2.0.71 and names the settings key from 2.1.325; when the key itself came is
 * not said, so no version is named as too old for it.
 */
export interface PromptSuggestionEstimate {
    /** Suggestions counted, and their price. */
    n: number;
    usd: number;
    /** Turn ends one could have followed, in the sessions compared. */
    turnEnds: number;
    /** Sessions that sent any, and sessions with a cost record compared. */
    sessions: number;
    compared: number;
}
export declare const PROMPT_SUGGESTION_KEY = "promptSuggestionEnabled";
export declare const PROMPT_SUGGESTION_ENV = "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION";
/** Prompt suggestions over the last `days`, from Claude Code's cost-state against our price of the same sessions (as `doctor` compares them). */
export declare function measurePromptSuggestions(days: number, now?: number): PromptSuggestionEstimate;
/**
 * Whether prompt suggestions are already settled by someone: the variable
 * read as false anywhere Claude Code reads it (off: applied), or the setting
 * in the user's settings.json (false: applied; true: theirs, left alone). A
 * project's or managed value, or the variable read as true, is an override
 * (fixOverrides), not the user's choice here.
 */
export declare function promptSuggestionsState(deps?: {
    home?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}): {
    set?: {
        value: string;
        where: string;
        off: boolean;
    };
};
/** Turn ends since `at` in the main transcripts (`paths`, else those written since), priced as a suggestion after each, at `share` of them (the share that sent one before). */
export declare function promptSuggestionsSavedSince(at: number, share: number, paths?: string[]): {
    turnEnds: number;
    usd: number;
};
/** The Claude Code version whose `tool.describe` names a tool's MCP server and lets a mod answer `isDeferred`. */
export declare const DESKTOP_TOOLS_DEFER_SINCE = "2.1.326";
export declare const money: (n: number) => string;
/** " (48%)", or " (37% of subagents)" for a share of something else. */
export declare const share: (f: Fix) => string;
export declare function planFixes(i: FixInputs): Fix[];
export interface FixRecord {
    id: FixId;
    /** When it was first applied (ms). */
    at: number;
    /** The value it wrote. */
    value?: unknown;
    /** The setting's value before context-doctor first changed it, as written (any JSON). */
    previous?: unknown;
    /** Whether the setting existed before (`previous` may itself be null). */
    hadPrevious?: boolean;
    /** The settings file and key path it wrote. */
    file?: string;
    key?: string[];
    /** The whole file before its first change (null: there was no file), and as fix left it: undo puts `before` back when the file is still exactly `after`. */
    before?: string | null;
    after?: string;
    /** For cache-ttl: the share of writes at 1 hour before the change, the baseline "since" compares against. */
    oneHourShareBefore?: number;
    /** For prune: the project folder. */
    cwd?: string;
    /** For mcp-defer: each alwaysLoad key it set in ~/.claude.json, and what was there before. */
    entries?: DeferEntry[];
    /** For prompt-suggestions: the share of turn ends that sent a suggestion in the period before, the baseline "since" prices at. */
    suggestedShare?: number;
    /** For subagent-model: the models the moved types' subagents ran on before the change, each one's share of their tokens (Sonnet-or-cheaper ones included): the baseline "since" compares against. */
    modelsBefore?: Record<string, number>;
}
/**
 * ~/.claude/.context-doctor-fixes.json, as always. On a machine with no
 * ~/.claude (Codex only), the state folder the ledger falls back to: `fix`
 * must not make a ~/.claude there. Once records are in that folder they stay
 * there, so a Claude Code installed later does not strand them.
 */
export declare function fixRecordPath(home?: string): string;
/**
 * The records, strictly: an absent file is none; a file that is not ours to
 * read (corrupt, the wrong shape) is refused, never treated as empty and
 * overwritten: it lists what `fix undo` would put back.
 */
export declare function loadFixRecords(home?: string): FixRecord[];
/** The records for reporting: a damaged file reads as none (the plan says so). */
export declare function readFixRecords(home?: string): FixRecord[];
export interface FixDeps {
    home?: string;
    now?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Autopilot's own commands (injected in tests: they start and stop a service). */
    autopilotOn?: () => Promise<{
        ok: boolean;
        lines: string[];
    }>;
    autopilotOff?: () => Promise<string[]>;
}
/** What would keep this fix's value from taking effect, as Claude Code merges settings. */
export declare function fixOverrides(id: FixId, deps?: {
    home?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}): string[];
/** Apply one fix; record it unless it changed nothing. Refusals (a damaged settings file, a damaged record) change nothing. */
export declare function applyFix(fix: Fix, deps?: FixDeps, context?: {
    oneHourShare?: number;
    prune?: ProjectPlan;
    modelsBefore?: Record<string, number>;
    mcpDefer?: FixInputs["mcpDefer"];
    suggestedShare?: number;
}): Promise<{
    ok: boolean;
    lines: string[];
}>;
/** Undo what fix applied: every fix, or the ones named. Returns what it did, line by line. */
export declare function undoFixes(ids: FixId[] | undefined, deps?: FixDeps): Promise<string[]>;
/**
 * Where CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES is set, as Claude Code
 * sees it: the highest settings file whose env names it (managed, local,
 * project, user: each applied over the one before and over the shell), else
 * the shell's own value. A project's or managed value that keeps them is not
 * the user's (fixOverrides names it); the user's own one is never
 * overwritten. `offSince`: when fix turned them off (its record).
 * `forkGateOff`: CLAUDE_CODE_FORK_SUBAGENT off, which in a terminal session
 * also keeps ordinary background subagents from getting summaries.
 */
export declare function progressSummariesState(deps?: {
    home?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}): {
    set?: {
        value: string;
        where: string;
    };
    offSince?: number;
    forkGateOff: boolean;
    route: SummaryRoute;
};
/** The summaries fix's variable stopped since `at`: the background subagents on Claude Code 2.1.318+ since, estimated as if it were not set. */
export declare function progressSummariesSavedSince(at: number, subagentPaths?: string[], forkGateOff?: boolean, route?: SummaryRoute): ProgressSummaryEstimate;
export interface SinceResult {
    id: FixId;
    at: number;
    /** Saved since it was applied; undefined when not priced. */
    savedUsd?: number;
    detail: string;
}
/**
 * Compactions since `since` that came before the old window, priced: every
 * later request in that session re-read less context, until the session
 * would have reached the old window and compacted anyway; less each
 * compaction's own request and a 20k-token summary at the output rate.
 */
export declare function compactWindowSavingsSince(since: number, previousWindow: number | undefined, paths?: string[]): {
    usd: number;
    compactions: number;
};
export declare function savedSince(records: FixRecord[], opts?: {
    paths?: string[];
    subagentPaths?: string[];
    codexPaths?: string[];
    ledger?: ReturnType<typeof readLedger>;
    progressRoute?: SummaryRoute;
}): SinceResult[];
/** The overlap lines for the priced fixes in a plan, "a and b: why;" each. */
export declare function overlaps(fixes: Fix[]): string[];
export declare function renderFixPlan(days: number, billedUsd: number, fixes: Fix[], since: SinceResult[], command?: (s: string) => string, coldResume?: FixInputs["coldResume"], recordProblem?: string, codexBilledUsd?: number, keepWarm?: FixInputs["keepWarm"]): string;
export declare function renderFixShare(days: number, billedUsd: number, fixes: Fix[], codexBilledUsd?: number): string;
export declare function parseFixIds(raw: string, fixes: Fix[]): {
    ids: FixId[];
    unknown: string[];
};
