/**
 * Two Claude Code costs no transcript row records the usage of (ROADMAP F1,
 * the gap to Claude Code's own `cost-state`): one estimated from what the
 * rows do record and counted, one only named in the gap.
 *
 * Prompt suggestions. When a main-thread turn ends, Claude Code asks the
 * session's model for the grey "what you might type next" line: a one-turn
 * fork of the conversation (`querySource: "prompt_suggestion"`, made with
 * `skipTranscript`), so it is billed and counted in Claude Code's cost, and
 * no row has it. Read from the 2.1.325 binary: it sends the conversation as
 * the turn's last request did plus that reply and a ~500-token instruction,
 * and skips the turn when that last reply wrote more than about 10,000 tokens
 * with its input and output (`cache_cold`), as well as in plan mode, at a
 * rate limit, after an API error, and early in a conversation. Measured on
 * the author's machine, on the stretches between two of Claude Code's
 * cost-state records that hold one turn: each added exactly the last
 * request's prompt read from the cache, its reply's output written to it
 * (at the main thread's cache lifetime), 506 input tokens and 12-17 output
 * tokens. On one 199-turn session the input Claude Code counted beyond ours
 * was 198 times 506 tokens. `claude -p` and other SDK hosts get none unless
 * they ask (their entrypoint starts "sdk"). Not counted in any total: on the
 * author's last 30 days whole Desktop sessions sent none (every turn typed by
 * a person), so whether one was sent is in no file; ccost.ts names them in
 * the gap, as many as Claude Code's input beyond ours has room for.
 *
 * Unsettled subagent output. Claude Code 2.1.284 to 2.1.299 wrote a
 * subagent's reply rows as it streamed and never wrote the last one: no row
 * of the reply has a `stop_reason`, and `output_tokens` stays at the first
 * few tokens (20,082 of 23,262 subagent replies on 2.1.295 on the author's
 * machine). Counted, wherever usage is read.
 * The reply's content is all there: its output is estimated from it, the
 * text and tool calls by their length and the thinking (redacted to a
 * signature) by the signature's length, a fit on the author's 23,000 settled
 * replies (Opus 5.5, Opus 4.8, Fable 5.2: within 3% in total, 8 replies in
 * 10 within -15% to +28%). On the session that showed it, the estimate came to
 * 1.14M output tokens where Claude Code counted 1.12M beyond ours.
 */
import { type RecordedUsage } from "./pricing.js";
/** A suggestion's own instruction, in input tokens (measured: 506). */
export declare const SUGGESTION_PROMPT_TOKENS = 506;
/** A suggestion's output (measured: 12-17). */
export declare const SUGGESTION_OUTPUT_TOKENS = 15;
/** Claude Code skips a suggestion after a reply whose input, output and cache write come to more than this (2.1.325's `cache_cold`). */
export declare const SUGGESTION_MAX_LAST_TOKENS = 10000;
/**
 * The prompt suggestion a reply row's turn ended with, as the usage Claude
 * Code was billed for it; undefined when the row ends no main-thread turn or
 * Claude Code would have skipped it.
 */
export declare function suggestionUsage(e: any): RecordedUsage | undefined;
/** A reply row's suggestion priced at its model and time; undefined as suggestionUsage, or when its model has no price. */
export declare function suggestionCost(e: any): {
    usage: RecordedUsage;
    cost: import("./pricing.js").RequestCost;
} | undefined;
/** The Claude Code versions that left subagent replies unsettled (seen on the author's machine: 2.1.284 to 2.1.299; 2.1.308 settles them). */
export declare const UNSETTLED_FROM = "2.1.284";
export declare const UNSETTLED_UNTIL = "2.1.299";
/** Whether a row's Claude Code version is one that left replies unsettled. */
export declare function unsettledVersion(v: unknown): boolean;
/** Output tokens per character of text and tool input, and per character of a redacted thinking block's signature (the fit above). */
export declare const OUTPUT_PER_CHAR = 0.4;
export declare const OUTPUT_PER_SIGNATURE_CHAR = 0.26;
/** One reply row's content, as the output tokens it took to write (the fit above); 0 for none. */
export declare function contentOutputTokens(content: unknown): number;
