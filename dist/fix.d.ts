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
 *  - autopilot: what the proxy recorded saving since (its own ledger).
 */
import { type CacheTtlReport, type CurrentTtl } from "./cachettl.js";
import { type ProjectPlan } from "./prune.js";
import { readLedger } from "./ledger.js";
export type FixId = "compact-window" | "cache-ttl" | "cache-ttl-subagents" | "autopilot" | "tool-search" | "prune";
export interface Fix {
    id: FixId;
    title: string;
    /** Saved over the measured period, when it can be priced. */
    savedUsd?: number;
    savedShare?: number;
    /** How the figure was measured. */
    basis: string;
    /** What it costs in quality, plainly. */
    quality: string;
    /** What it writes, where. */
    change: string;
    state: "available" | "applied" | "not-here";
    /** Why not here, or what is already applied. */
    note?: string;
    /** The value it writes. */
    value?: number | string;
    /** What would keep it from taking effect (environment, project or managed settings, per-model values). */
    overriddenBy?: string[];
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
    /** The /compact offer at cold returns: advice, not a setting; `hooked` when the every-prompt hook (or the plugin) is there to make it. */
    coldResume?: {
        netUsd: number;
        returns: number;
        hooked: boolean;
    };
}
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
}
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
}): Promise<{
    ok: boolean;
    lines: string[];
}>;
/** Undo what fix applied: every fix, or the ones named. Returns what it did, line by line. */
export declare function undoFixes(ids: FixId[] | undefined, deps?: FixDeps): Promise<string[]>;
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
    ledger?: ReturnType<typeof readLedger>;
}): SinceResult[];
export declare function renderFixPlan(days: number, billedUsd: number, fixes: Fix[], since: SinceResult[], command?: (s: string) => string, coldResume?: FixInputs["coldResume"], recordProblem?: string): string;
export declare function renderFixShare(days: number, billedUsd: number, fixes: Fix[]): string;
export declare function parseFixIds(raw: string, fixes: Fix[]): {
    ids: FixId[];
    unknown: string[];
};
