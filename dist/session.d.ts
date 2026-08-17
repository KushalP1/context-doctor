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
export interface ParsedSession {
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
