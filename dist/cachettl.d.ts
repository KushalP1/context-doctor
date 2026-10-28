/**
 * `context-doctor cache-ttl`: how long Claude Code's prompt cache should
 * live, measured on your own pauses.
 *
 * Every request re-sends the whole conversation; the part the previous
 * request cached is read at 5-10% of the input price, if the cache is still
 * alive. Claude Code writes the cache with a lifetime of 5 minutes (1.25x
 * input per written token) or 1 hour (2x). A pause longer than the lifetime
 * makes the next request write the whole context again. Claude Code 2.1.243+
 * lets the user choose (code.claude.com/docs/en/env-vars):
 *  - `promptCacheTtl` ("5m" | "1h") for the main conversation; unset it is
 *    1 hour on a Claude subscription within its usage limits and 5 minutes on
 *    an API key, Bedrock, Vertex or Foundry (the setting's description in the
 *    2.1.309 binary); interactive sessions wrote 5-minute entries for a while
 *    from 2.1.301 (anthropics/claude-code#103673);
 *  - `subagentPromptCacheTtl` for subagents, workflows and background work;
 *    unset, 5 minutes (unless ENABLE_PROMPT_CACHING_1H=1).
 * The environment variables CLAUDE_CODE_PROMPT_CACHE_TTL and
 * CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL take precedence, and
 * FORCE_PROMPT_CACHING_5M overrides them all. An older Claude Code ignores
 * the keys (2.1.62 still ran the file's hooks with them present; measured),
 * so writing them is safe everywhere and takes effect where supported.
 *
 * The lifetime changes only the price: the same content is sent either way,
 * so there is no quality question. The replay, request by request over each
 * transcript, prices the same requests three ways: as billed, every write at
 * 5 minutes, every write at 1 hour. A request that found the cache cold (its
 * gap from the previous request past that entry's lifetime, and over 60% of
 * the previous context written again) would have read it at a lifetime that
 * covered the gap; a request that read a warm cache would have written it
 * all again at a lifetime its gap exceeded. Compactions and model switches
 * start a new cache in every arm. The main conversation and subagents are
 * replayed apart, since each has its own setting.
 */
import { type ClaudeCodeInstall } from "./modelswitch.js";
/** The first Claude Code with the promptCacheTtl and subagentPromptCacheTtl settings (CHANGELOG). */
export declare const CACHE_TTL_SINCE = "2.1.243";
export type Ttl = "5m" | "1h";
export type TtlKind = "main" | "subagents";
export interface TtlReplay {
    /** Transcripts read (main: sessions with 10+ requests in the period, as `savings` counts them). */
    transcripts: number;
    requests: number;
    /** Input as billed: recorded usage at list price. */
    billedUsd: number;
    /** The same requests with every cache write at 5 minutes. */
    at5mUsd: number;
    /** ... and at 1 hour. */
    at1hUsd: number;
    /** Share of the cache-write tokens written at 1 hour, as billed. */
    oneHourShare: number;
    /** Requests a 1-hour cache would have kept warm (they re-wrote a cold one). */
    keptWarmAt1h: number;
    /** Requests a 5-minute cache would have let go cold (they read a warm one). */
    wentColdAt5m: number;
    /** Requests on models with no known price (not in the dollar figures). */
    unpriced: number;
}
export interface CacheTtlReport {
    days: number;
    main: TtlReplay;
    subagents: TtlReplay;
}
interface Acc extends TtlReplay {
    writes: number;
    writes1h: number;
}
/**
 * Replay one transcript into `acc`, counting requests in [since, until).
 * `sidechains`: a subagent's own transcript, whose rows are all sidechain
 * rows; a main transcript skips them. Returns the requests counted.
 */
export declare function replayTtlTranscript(path: string, acc: Acc, since: number, until?: number, sidechains?: boolean, runRows?: Set<string>, otherIds?: Set<string>): number;
/** Subagent transcripts of the main transcripts under ~/.claude/projects written since `since`. */
export declare function subagentTranscripts(since: number, home?: string): string[];
export interface TtlOptions {
    /** Main transcripts (default: Claude Code transcripts written in the period). */
    paths?: string[];
    /** Subagent transcripts (default: those under the main transcripts' folders). */
    subagentPaths?: string[];
    /** Count only requests before this time (default: now). */
    until?: number;
    /** Replay from this time instead of `days` before now. */
    since?: number;
    /** Main sessions need this many requests in the period to count (savings' rule: 10). */
    minRequests?: number;
    onProgress?: (done: number, total: number) => void;
}
export declare function estimateCacheTtl(days?: number, opts?: TtlOptions): CacheTtlReport;
export interface TtlAdvice {
    ttl: Ttl;
    /** Saved against the input as billed. */
    savedUsd: number;
    savedShare: number;
}
/** The lifetime to set, when one is clearly cheaper than the input as billed; else undefined. */
export declare function adviseTtl(r: TtlReplay): TtlAdvice | undefined;
export declare function claudeSettingsPath(home?: string): string;
export interface CurrentTtl {
    /** The lifetime Claude Code will use, as settings and environment decide it (undefined: its own default). */
    main?: Ttl;
    subagents?: Ttl;
    /** What keeps a value in the user's settings.json from taking effect (both kinds). */
    overrides: string[];
    mainOverrides?: string[];
    subagentOverrides?: string[];
}
/**
 * The lifetimes Claude Code will use as far as its settings and environment
 * decide (managed, project and user settings merged, CLAUDE_CONFIG_DIR
 * honoured), and what overrides a value in the user's settings.json.
 */
export declare function currentTtl(home?: string, env?: NodeJS.ProcessEnv, cwd?: string): CurrentTtl;
export interface SetTtlResult {
    changed: boolean;
    created: boolean;
    backup?: string;
    /** The value before the change, as written (undefined: not set). */
    previous?: unknown;
}
/** Set (or with undefined, remove) promptCacheTtl / subagentPromptCacheTtl in the user's settings.json, editing only that key. */
export declare function setCacheTtl(kind: TtlKind, ttl: Ttl | undefined, home?: string): SetTtlResult;
export declare function settingKey(kind: TtlKind): string;
/** Claude Code installs too old for the setting (it does nothing there). */
export declare function ttlUnsupported(installs: ClaudeCodeInstall[]): ClaudeCodeInstall[];
export declare function renderCacheTtl(r: CacheTtlReport, current: CurrentTtl, installs?: ClaudeCodeInstall[], command?: (s: string) => string): string;
export {};
