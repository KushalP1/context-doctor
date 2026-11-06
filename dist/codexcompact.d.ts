/**
 * Codex's auto-compact limit: what an earlier compaction would have saved on
 * the user's Codex rollouts, and the `codex-compact` lever of `fix`.
 *
 * Verified 2026-11-04 against codex-cli 0.153.4 (the ChatGPT app's binary)
 * and openai/codex main (config.schema.json, protocol/src/openai_models.rs,
 * models-manager/src/model_info.rs) and the config reference at
 * developers.openai.com/codex/config-reference:
 *  - `model_auto_compact_token_limit`, a top-level integer in
 *    ~/.codex/config.toml (CODEX_HOME), is the token count that triggers an
 *    automatic compaction. Unset, it is 90% of the model's context window
 *    (244,800 on a 272k window: gpt-5.5, gpt-6); set, the smaller of the two,
 *    so it can only bring compaction earlier. `..._scope` ("total", the
 *    default, or "body_after_prefix") says what it counts.
 *  - A rollout records each request as a `token_count` event (the last
 *    request's input, cached input and output, and `model_context_window`,
 *    95% of the window), and a compaction as a `compacted` item (its
 *    replacement history) followed by a `context_compacted` event. On the
 *    author's one compaction the next request's input fell from 243,893 to
 *    22,507 tokens. The compaction's own request is not recorded.
 *
 * The replay walks each rollout's requests twice: as billed, and compacting
 * whenever the context reaches the candidate limit. Context a simulated
 * compaction removed is priced at each later request as that request billed
 * it (cached tokens at the cached rate, the rest at the input rate), until a
 * real compaction; the request after a simulated one pays the input rate on
 * its whole (now small) context, and each simulated compaction pays one
 * request reading the context and a summary at the output rate (an estimate:
 * Codex does not record it). What the summary dropped, and the model reading
 * files again because of it, is not priced.
 */
import { type Extractor } from "./scan.js";
/** The config.toml key the lever writes. */
export declare const CODEX_COMPACT_KEY = "model_auto_compact_token_limit";
/** The limit `fix` offers, and the others the replay shows. */
export declare const CODEX_COMPACT_LIMIT = 150000;
export declare const CODEX_COMPACT_LIMITS: number[];
/**
 * What the replay takes from a rollout: each model change, every request's
 * usage (token_count: time, running total, the fork key, the window), and
 * each compaction. No text.
 */
export declare const CODEX_COMPACT_ROWS: Extractor<null>;
export interface CodexCompactEstimate {
    limit: number;
    savedUsd: number;
    /** Of the input billed over the same requests. */
    savedShare: number;
    /** Compactions there would be over the period at this limit. */
    compactions: number;
}
export interface CodexCompactReport {
    days: number;
    rollouts: number;
    requests: number;
    /** Input billed (prompt only) over the period's requests, forks' copies once. */
    billedUsd: number;
    /** Requests on a model with no price (left out of the dollars). */
    unpriced: number;
    /** Compactions that happened over the period. */
    actualCompactions: number;
    /** Context right after a compaction: the median of the user's own, or 25k. */
    afterCompact: number;
    estimates: CodexCompactEstimate[];
}
/** Codex rollouts written since `since`: the live ones and the archived. */
export declare function codexRollouts(since: number, home?: string): string[];
/** Replay Codex's rollouts of the last `days` at each limit. */
export declare function replayCodexCompact(opts: {
    days: number;
    paths?: string[];
    limits?: number[];
    home?: string;
    now?: number;
}): CodexCompactReport;
/**
 * What a limit set at `since` saved: each compaction since that came before
 * the old trigger (`previous`, or Codex's own), priced as the context it took
 * off every later request until the session would have reached the old
 * trigger, less the compaction's request and summary (an estimate, as in
 * the replay).
 */
export declare function codexCompactSavedSince(since: number, previous: number | undefined, paths?: string[]): {
    usd: number;
    compactions: number;
};
/** The top-level value of `key` (before the first [table]): as written, and as a number when it is one. */
export declare function topLevelValue(toml: string, key?: string): {
    raw: string;
    value?: number;
} | undefined;
/**
 * Set (or with undefined, remove) a top-level integer key, touching no other
 * byte: a line replaced keeps its line end; a new line goes after the last
 * top-level statement (or at the top, after a byte order mark), with the
 * file's own line ends, never inside a multi-line string or array. A
 * missing file (undefined) becomes the one line.
 */
export declare function setTopLevelInt(toml: string | undefined, key: string, value: number | undefined): string;
/**
 * Profiles that set `key`, and the profile the file selects by default:
 * `[profiles.<name>]` tables, a `[profiles]` table's `<name>.key`, and a
 * top-level `profiles.<name>.key`.
 */
export declare function profileValues(toml: string, key?: string): Array<{
    profile: string;
    raw: string;
    selected: boolean;
}>;
/** ~/.codex/config.toml (CODEX_HOME honoured for this user). */
export declare function codexConfigPath(home?: string): string;
/** The limit the user set at the top of config.toml, as written. */
export declare function currentCodexCompact(home?: string): {
    raw: string;
    value?: number;
    where: string;
} | undefined;
/** What would keep a top-level limit from applying: a profile's own, a project's config.toml. */
export declare function codexCompactOverrides(home?: string, cwd?: string): string[];
/** The lines under the lever in `fix`: each limit tried. */
export declare function renderCodexLimits(r: CodexCompactReport, offered: number): string[];
