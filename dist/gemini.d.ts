/**
 * Gemini CLI chat recordings, read into the same shape as Claude Code and
 * Codex transcripts so `session`, `watch` and the every-prompt hook work on
 * them.
 *
 * Gemini CLI writes ~/.gemini/tmp/<project>/chats/session-*.jsonl: a metadata
 * record, then one record per message (`user`, `gemini`, `info`, `error`).
 * A message written again with the same id replaces the earlier copy (tool
 * results and token counts arrive after the text), `{"$rewindTo": id}` drops
 * that message and everything after it, and `{"$set": …}` updates metadata.
 * Older versions wrote the whole conversation as one JSON document with a
 * `messages` array; both are read.
 *
 * Each `gemini` message records the API's own usage (`tokens.input` is the
 * request's promptTokenCount, cached part included), so the live context size
 * is exact, as it is for Claude Code and Codex.
 */
import { type ParsedSession, type SessionInfo } from "./session.js";
/** True when the file's first record looks like a Gemini CLI chat (cheap: reads 4 KB). */
export declare function isGeminiChat(path: string): boolean;
/** The ordered, de-duplicated, rewind-applied messages of a chat file. */
export declare function readGeminiMessages(path: string): any[];
export declare function parseGeminiChat(path: string): ParsedSession;
/** Gemini CLI chats on this machine: ~/.gemini/tmp/<project>/chats/session-*.json[l]. */
export declare function listGeminiChats(home?: string): SessionInfo[];
