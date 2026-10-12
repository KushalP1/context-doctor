/**
 * Claude Code session analyzer: profile the transcripts Claude Code writes to
 * ~/.claude/projects/<project>/<session>.jsonl, answering "where did my
 * tokens go?" for real sessions instead of hand-exported conversations.
 *
 * Transcript lines are JSON objects; the ones that matter here are
 * `{type: "user"|"assistant", message: {role, content}, isSidechain, ...}`
 * where `message` is in Anthropic Messages format. Everything else
 * (titles, mode changes, hook records) is metadata and skipped.
 */
export interface SessionInfo {
    path: string;
    project: string;
    modifiedAt: Date;
    sizeBytes: number;
}
/** Wall-clock spent inside one tool, aggregated across a session. */
export interface ToolTiming {
    tool: string;
    calls: number;
    totalMs: number;
    medianMs: number;
    maxMs: number;
}
/** One API-reported input size, positioned in the message array. */
export interface UsageSample {
    /** Index into the live `messages` array of the assistant message reporting it. */
    index: number;
    /** input + cache-read + cache-creation tokens for that request. */
    input: number;
}
export interface ParsedSession {
    /**
     * The real input size of the most recent request, as reported by the API
     * (input + cache-read + cache-creation tokens). Transcripts do not contain
     * the harness's system prompt, tool schemas or skills, so an estimate over
     * transcript messages alone undercounts badly — measured against these
     * figures, by roughly 60%. When this is present, prefer it: it is ground
     * truth rather than an estimate.
     */
    reportedInputTokens?: number;
    /**
     * Messages dropped because a compaction replaced them. Reporting live
     * context means counting only what the model still sees; this records what
     * was compacted away so the difference can be shown rather than hidden.
     */
    compactedAway?: number;
    /**
     * Every API-reported input size in the transcript, tagged with its position
     * in the live message array. Consecutive samples are what make key-free
     * accuracy measurement possible: the harness's system prompt and tool
     * schemas are constant between two calls, so the DIFFERENCE between two
     * reported figures is the cost of the messages in between — directly
     * comparable to what the heuristic estimates for those same messages.
     */
    usageSamples?: UsageSample[];
    /**
     * Time between each tool_use and its tool_result, per tool, from the
     * timestamps every transcript entry carries. This is the other half of the
     * cost picture: tokens are what a call puts INTO context, this is how long
     * it made you wait. Caveat that must travel with the number: the gap also
     * contains any time spent waiting on a permission prompt, so an
     * unattended run reads cleaner than an interactive one.
     */
    toolTimings?: ToolTiming[];
    /** Conversation JSON string in Anthropic-ish format, ready for parseConversation(). */
    conversationJson: string;
    title?: string;
    model?: string;
    messageCount: number;
    path: string;
}
/** All session transcripts on this machine, newest first. */
export declare function listSessions(limit?: number): SessionInfo[];
/**
 * Read a JSONL transcript line by line without ever materializing the whole
 * file as one string.
 *
 * Agent sessions with large tool results reach hundreds of MB, and those are
 * exactly the sessions that most need analysis — but V8 refuses to build a
 * string past ~512MB, so readFileSync would throw on them (and in the hook,
 * throw *silently*). Streaming has no such ceiling and keeps peak memory at
 * one chunk. StringDecoder carries partial UTF-8 sequences across chunk
 * boundaries so multi-byte characters are never corrupted.
 */
export declare function forEachLine(path: string, onLine: (line: string) => void): void;
/**
 * Has this API reply been counted already? Claude Code writes one reply as
 * several rows (one per content block, ~2.2 on average) carrying the same
 * message id and the same usage, so a row is not a request. And a forked
 * session starts as a verbatim copy of its parent's transcript in a new file
 * (same row uuids, same message ids), so across files one reply can turn up
 * twice. Within a file the message id identifies the reply; across files
 * the uuid of its row does, which unrelated files never share even when they
 * reuse an id (hand-made transcripts do).
 *
 * Make one per file, passing the same `runRows` set to every file of one
 * report. Returns "new" the first time a reply is met in the run, "copy"
 * when its file met it first but an earlier file already counted it, and
 * "repeat" for its later rows in the same file.
 */
export declare function replyCounter(runRows?: Set<string>): (entry: Record<string, any>) => "new" | "copy" | "repeat";
/**
 * A counted reply's output, settled. Subagent transcripts are written as a
 * reply streams, each row with a snapshot of its usage: the input and cache
 * counts are final from the first row, output_tokens only on the last. On
 * the author's machine 5.8k subagent replies changed it, their first rows
 * carrying 1.3M output tokens against a final 6.7M (main-thread rows carry
 * the final usage throughout). Call with `first` on the row a reply is
 * counted at; for its later rows it returns the output tokens not yet
 * charged, and 0 for replies never counted.
 */
export declare function outputSettler(): (entry: Record<string, any>, first: boolean) => number;
/**
 * Text the user typed while the agent was working. Claude Code delivers it
 * mid-turn and records it only as an attachment line (type "attachment",
 * attachment.type "queued_command"), never as a user row: on the author's
 * machine 511 such prompts against ~2.5k typed user rows. Task
 * notifications and subagent hand-backs arrive the same way, so only
 * human-origin prompts count (older lines carry no origin; their prompts
 * were human). Undefined for anything else.
 */
export declare function queuedUserPrompt(entry: Record<string, any>): string | unknown[] | undefined;
export declare function parseSessionFile(path: string): ParsedSession;
