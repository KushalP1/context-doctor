/**
 * GitHub Copilot CLI's own record of what it sent: `session.usage_record`
 * events in `~/.copilot/session-state/<session>/events.jsonl` (or
 * `$COPILOT_HOME`), one per model call. Checked 2026-11-15 against the
 * readers that parse them (GitHub's own agent-radar collector in
 * github/awesome-copilot, qualitylayer, tokscale, agentsview) and
 * ccusage#2069 (1,142 records and no shutdown in one user's sessions).
 * GitHub documents none of it; the shape:
 *
 *   {"type":"session.usage_record","id":"…","timestamp":"…","data":{"usage":{
 *     "model":"claude-opus-4.6-1m","inputTokens":…,"outputTokens":…,
 *     "cacheReadTokens":…,"cacheWriteTokens":…,"reasoningTokens":…,
 *     "cost":1,"duration":…,"apiCallId":"…","isByok":false,
 *     "accounting":{"sourceSessionId":"…","usageId":"…"},
 *     "copilotUsage":{"totalNanoAiu":…}}}}
 *
 * - `inputTokens` holds the cached tokens too (read and written): the
 *   uncached input is what is left after both.
 * - `reasoningTokens` is part of `outputTokens`, not added again.
 * - `cost` is the request's premium-request multiplier (1, or 14 for a
 *   premium model), not dollars. `copilotUsage.totalNanoAiu` is the AI
 *   credits it used, in billionths: one credit is $0.01.
 * - The same call can be written twice (Copilot CLI 1.0.108: "count each
 *   newly recorded model call once, even when its usage event is received
 *   again"): one call is its accounting id, else its API call id, else the
 *   event's id.
 * - A compaction (`session.compaction_complete`, `compactionTokensUsed`) is
 *   a model call of its own, unless a usage record already names its
 *   request.
 * - Where it ran: `session.start` (and `session.resume`) carry
 *   `data.context` with `cwd`, `gitRoot`, `branch` and `repository`.
 *
 * Sessions from Copilot CLI versions that write no usage records (only
 * cumulative `session.shutdown` totals) are not read: their per-resume
 * figures cannot be told apart reliably (ccusage's notes on it run a page).
 */
import { type Extractor } from "./scan.js";
/** One Copilot CLI model call, as the session recorded it. */
export interface CopilotCall {
    ts: number;
    session: string;
    /** The model as Copilot named it, less the context-size suffix ("-1m") and a BYOK provider's id. */
    model: string;
    /** Uncached input (inputTokens less both cache counts). */
    input: number;
    read: number;
    write: number;
    output: number;
    /** AI credits it used (totalNanoAiu / 1e9); absent when the record has none. */
    credits?: number;
    /** Premium requests it counted (the legacy `cost` multiplier); absent when the record has none. */
    premium?: number;
    /** Billed to the user's own key (BYOK), not the Copilot plan. */
    byok?: boolean;
    /** Where the session ran, from session.start's context. */
    cwd?: string;
    gitRoot?: string;
    branch?: string;
}
/** Copilot's home: $COPILOT_HOME when set (and `home` is this user's), else <home>/.copilot. */
export declare function copilotDataDir(home?: string): string;
/** "claude-opus-4.6-1m" -> "claude-opus-4.6"; "<provider uuid>/gpt-x" -> "gpt-x". */
export declare function copilotModel(raw: string): string;
/**
 * What `spend` takes from a Copilot CLI session: each usage record's
 * numbers and ids, each compaction's, and each start's context. No message
 * text, no tool call.
 */
export declare const COPILOT_USAGE_ROWS: Extractor<Record<string, never>>;
/** The model calls of one session's events file between `since` and `until`, each once. Throws when it cannot be read. */
export declare function copilotFileCalls(file: string, session: string, since: number, until?: number): CopilotCall[];
/** Each session's events file written since `since`: `session-state/<id>/events.jsonl`, and the flat `session-state/<id>.jsonl` some versions write. */
export declare function copilotSessionFiles(since: number, home?: string): Array<{
    file: string;
    session: string;
}>;
/** Every Copilot CLI model call between `since` and `until`. An unreadable session is skipped. */
export declare function copilotCalls(since: number, until?: number, home?: string): CopilotCall[];
