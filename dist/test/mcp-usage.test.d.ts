/**
 * MCP usage counts what the transcripts really hold: calls made by
 * subagents (in <session>/subagents/agent-*.jsonl) count, a forked session's
 * copy of its parent's calls counts once, and --days applies to each call's
 * own time, not to whichever file was last touched.
 */
export {};
