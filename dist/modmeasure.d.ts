/**
 * `context-doctor mod measure`: what the plugin's mod hands over after each
 * turn, kept the way the status line keeps it.
 *
 * The status line never runs in the Desktop app's Code tab or the VS Code
 * extension, so there the limit ledger stayed empty and Claude Code's own
 * cost was never compared with ours (ROADMAP K2). A mod runs there: after
 * each main-thread turn Claude Code raises `session.measure` with the
 * rate-limit windows (`kind`, `percentUsed`, `resetsAt` as ISO 8601) and the
 * session's cost (`cost.usd`, as /cost totals it). The mod has no file
 * access of its own worth trusting with our formats, so it runs this command
 * with that reading on stdin, and this:
 *
 *  - appends the windows to the limits ledger in the status line's own
 *    format and with its rules (recordLimits: changes only, at most once a
 *    minute, never a lower figure of the same window from a parallel
 *    session), so `context-doctor limits` reads Desktop's readings too;
 *  - appends Claude Code's cost beside our own price of the same session
 *    (sessionTotal: the transcript and its subagents, as the every-prompt
 *    hook prices it) to a small capped ledger, for `doctor`'s comparison;
 *  - prints what the band needs, as JSON: the cache clock read from the
 *    transcript's tail (coldresume.ts), the re-write's price, the price.
 *
 * Silent like the status line: anything unreadable prints `{}` and exits 0.
 * Off: CONTEXT_DOCTOR_NO_LIMITS_LOG=1 (the limits), CONTEXT_DOCTOR_NO_COST_LOG=1
 * (the cost ledger).
 */
import type { BandData } from "./mod/logic.js";
/** What the mod sends: `session.measure`'s input, and who the session is. All optional. */
export interface ModMeasureInput {
    sessionId?: string;
    cwd?: string;
    model?: string;
    rateLimits?: Array<{
        kind?: unknown;
        percentUsed?: unknown;
        resetsAt?: unknown;
    }>;
    cost?: {
        usd?: unknown;
    };
    context?: {
        tokens?: unknown;
        window?: unknown;
    };
}
/**
 * The mod's windows in the status line's shape, `{ five_hour: { used_percentage,
 * resets_at } }`, resets in epoch seconds: the one shape recordLimits reads.
 * A gateway's `spend_limit` has no place in the ledger and is left out.
 */
export declare function statusLineRateLimits(list: unknown): Record<string, {
    used_percentage: number;
    resets_at?: number;
}> | undefined;
/** A Claude Code session's transcript: in its folder's project, else wherever a project holds the id (a session that moved folders). */
export declare function findTranscript(sessionId: string | undefined, cwd: string | undefined, home?: string): string | undefined;
/** One line: Claude Code's cost of a session and ours, at one moment; or a press of the mod's Compact button. */
export interface CostLine {
    ts: number;
    sid: string;
    /** Claude Code's figure, USD. */
    cc?: number;
    /** context-doctor's, USD. */
    cd?: number;
    model?: string;
    /** Requests with no list price, left out of `cd`. */
    unpriced?: number;
    /** The part of `cd` priced at its family's row. */
    est?: number;
    /** "compact": the mod's Compact first button was pressed (`tokens`: the context it compacted). */
    ev?: string;
    tokens?: number;
}
export declare function costLogPath(): string;
/**
 * Append a session's two figures, unless neither moved since its last line
 * (a second measure of the same turn, a parallel window of the same session).
 * Never throws. True when a line was written.
 */
export declare function recordSessionCost(line: Omit<CostLine, "ev">, path?: string): boolean;
/** A press of one of the mod's buttons that changes nothing on disk (the Compact button), for the follow-through count. */
export declare function recordModEvent(sid: string, ev: string, tokens?: number, now?: number, path?: string): boolean;
/** Every line of the ledger since `since`. */
export declare function readCostLines(since?: number, path?: string): CostLine[];
/** A session's last pair of figures, and how far ours is from Claude Code's. */
export interface CostGap {
    sid: string;
    ts: number;
    cc: number;
    cd: number;
    /** (cd - cc) / cc. */
    gap: number;
    model?: string;
    unpriced?: number;
}
/** The target: within this of Claude Code's figure wherever every model is priced (ROADMAP K2). */
export declare const COST_GAP_TARGET = 0.02;
/** Each session's last pair, where both figures are there and Claude Code's is worth comparing. */
export declare function costGaps(lines: CostLine[]): CostGap[];
/**
 * `doctor`'s line: how close our session price is to Claude Code's own cost,
 * on the sessions the mod measured in the last `days`. Undefined when it
 * measured none (no mod, or no session above $0.50 yet).
 */
export declare function costCheck(days?: number, now?: number, path?: string): {
    label: string;
    status: "ok" | "warn";
    detail: string;
} | undefined;
/**
 * Keep what the mod measured and work out the band's inputs. Never throws;
 * what it cannot read is left out of the answer.
 */
export declare function modMeasure(input: ModMeasureInput, now?: number, env?: NodeJS.ProcessEnv): Partial<BandData> & Pick<BandData, "at" | "coldMinTokens" | "thresholds">;
/**
 * The CLI side: `mod measure` keeps the reading and prints the band's
 * figures; `mod event` records a press (`{ sessionId, ev, tokens }`). Both
 * print JSON and exit 0 whatever happens, as the status line does.
 */
export declare function runMod(sub: "measure" | "event"): Promise<void>;
