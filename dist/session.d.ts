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
    /** Conversation JSON string in Anthropic-ish format, ready for parseConversation(). */
    conversationJson: string;
    title?: string;
    model?: string;
    messageCount: number;
    path: string;
}
/** All session transcripts on this machine, newest first. */
export declare function listSessions(limit?: number): SessionInfo[];
export declare function parseSessionFile(path: string): ParsedSession;
