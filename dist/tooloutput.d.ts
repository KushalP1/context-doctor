/**
 * Long tool output: what it costs to keep in the context, and what a lower
 * cap would save. The `tool-output` lever of `fix`.
 *
 * A tool result stays in the conversation, and every later request re-reads
 * it (at the cache-read rate, or the write rate when the cache went cold)
 * until a compaction. Claude Code caps it when it arrives. Read from the
 * 2.1.309 binary and its docs (code.claude.com/docs/en/tools-reference,
 * settings-reference, mcp, env-vars):
 *  - a successful Bash or PowerShell result over `bashOutputMaxChars`
 *    (settings, any scope; default 30,000 characters, clamped to
 *    4,000-128,000; Claude Code 2.1.261+) is saved to a file, and the model
 *    receives the path and a preview of the first 2,000 characters
 *    (`<persisted-output>`). Set, it also replaces BASH_MAX_OUTPUT_LENGTH,
 *    which on its own sizes only the read-back window, not what the model
 *    receives. A failed command gets a head-and-tail excerpt of ~10,000
 *    characters instead, with no file, whatever the setting;
 *  - an MCP text result over MAX_MCP_OUTPUT_TOKENS (environment; default
 *    25,000 tokens) is saved to a file and replaced by a message naming the
 *    path, with no preview; one over 50,000 characters is saved to a file
 *    whatever the variable says (with the same 2,000-character preview as
 *    Bash), unless the tool raises its own limit.
 * Anthropic can also set a tool's threshold server-side (a remote flag the
 * binary reads per tool name); that is not visible here.
 *
 * The replay reads each transcript's requests and its Bash and MCP results
 * in order. For a candidate cap, a successful text result longer than the
 * cap would have been the preview instead: the tokens past it are priced at
 * the first request after the result (the cache write, at the session's own
 * write price) and at every later request until a compaction (a cache read,
 * or a write when that request found the cache cold: over 60% of its context
 * written again). Token counts are estimates from the text's length, at the
 * ratio measured on the growth of the billed prompt between consecutive
 * calls (tokens.ts). Not counted: the model opening the file afterwards, or
 * running the command again. Each such request costs about the context it
 * re-reads, so the replay prices one per moved result and reports how many
 * of them the saving still covers.
 */
import { type Extractor } from "./scan.js";
/** The settings key the lever writes. */
export declare const BASH_OUTPUT_KEY = "bashOutputMaxChars";
/** The environment variable the setting replaces (a value the user set there is theirs). */
export declare const BASH_OUTPUT_ENV = "BASH_MAX_OUTPUT_LENGTH";
/** Claude Code's inline ceiling for a successful command, unset. */
export declare const BASH_OUTPUT_DEFAULT = 30000;
/** What Claude Code clamps the setting to. */
export declare const BASH_OUTPUT_MIN = 4000;
export declare const BASH_OUTPUT_MAX = 128000;
/** The caps the replay tries, smallest first; under 8,000 the 2,000-character preview is most of the output. */
export declare const BASH_OUTPUT_CAPS: number[];
/** The MCP cap the replay tries, in tokens: the size at which Claude Code already warns. */
export declare const MCP_OUTPUT_CAP = 10000;
export declare const TOOL_OUTPUT_ROWS: Extractor<{
    ids: Record<string, number>;
    calls: Record<string, string>;
}>;
/** A result: its length (or the size Claude Code saved), as code or prose, the model's tokenizer. */
interface Res {
    k: "b" | "m";
    n: number;
    c: number;
    p?: number;
    model?: string;
}
/** Which results a cap moves to a file, and the tokens the model would no longer carry. */
type Mover = (r: Res) => number;
/** A candidate cap for Bash: a successful result longer than it, still inline, becomes the preview. */
export declare const bashCap: (cap: number) => Mover;
/** Since a cap was set: the results Claude Code moved that the cap before would have left inline. */
export declare const bashMovedSince: (previous: number) => Mover;
/** MAX_MCP_OUTPUT_TOKENS at `tokens`: a longer text result becomes a message naming the file. */
export declare const mcpCap: (tokens: number) => Mover;
export interface CapReplay {
    /** Results the cap moves to a file, of the ones it applies to. */
    moved: number;
    results: number;
    /** Tokens it keeps out of the context, summed over the requests that re-read them. */
    tokens: number;
    savedUsd: number;
    /** One more request at each moved result's context: what opening the file (or running the command again) costs a time. */
    openUsd: number;
}
export interface ToolOutputReplay {
    /** Transcripts read (main conversations and subagents). */
    transcripts: number;
    requests: number;
    /** Input billed over the same requests (prompt only), the share's base. */
    billedUsd: number;
    /** Successful Bash results Claude Code already saved to a file (over 30,000 characters or the cap set). */
    alreadyMoved: number;
    bash: Array<CapReplay & {
        cap: number;
    }>;
    /** MAX_MCP_OUTPUT_TOKENS at MCP_OUTPUT_CAP: measured, not offered (the model gets no preview). */
    mcp: CapReplay & {
        cap: number;
    };
    /** The cap `fix` offers: the most saved among those that cover the model opening at least half the files. */
    recommended?: number;
}
/** The share of moved results the model could open before the cap stops paying (each opening costs openUsd / moved and loses that result's saving). */
export declare function breakEven(r: CapReplay): number;
export interface ToolOutputOptions {
    since: number;
    until?: number;
    /** Transcripts (default: Claude Code's main conversations and subagents written since `since`). */
    paths?: string[];
    caps?: number[];
}
/** Claude Code transcripts written since `since`, subagents included: every place a tool result is re-read. */
export declare function toolOutputTranscripts(since: number): string[];
/** Replay every Bash and MCP result in [since, until) at each candidate cap. */
export declare function replayToolOutput(opts: ToolOutputOptions): ToolOutputReplay;
/** What a cap set at `since` saved: the results it moved that the cap before (`previous`) left inline, re-read no more. */
export declare function toolOutputSavedSince(since: number, previous: number, paths?: string[]): CapReplay;
/** The lines under the lever in `fix`: each cap tried, and MCP's. */
export declare function renderToolOutputCaps(r: ToolOutputReplay): string[];
export {};
