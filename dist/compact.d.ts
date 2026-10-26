/**
 * Compact tool results: a short text, the detail as `structuredContent`, and
 * presentation-only data in `_meta`.
 *
 * Why: every byte of a tool result is re-read on every later turn of the chat.
 * profile_context's full report (bars, message previews) and pack_context's
 * outline (one line per chunk, the heading path repeated on each) are mostly
 * presentation. ChatGPT surfaces `content` and `structuredContent` to the
 * model and keeps `_meta` for the widget only (developers.openai.com/apps-sdk
 * reference, "Tool results"), so the compact form puts one line of text and
 * the decision-relevant fields in front of the model, and the rest where only
 * a widget would read it.
 *
 * Not the default: a client that ignores `structuredContent` would lose the
 * detail. The server sends this form to ChatGPT (recognised by the `openai/*`
 * request metadata it attaches to every tool call) or when
 * CONTEXT_DOCTOR_RESULTS=compact; everything else gets the full text, as
 * before. Measured sizes are in ROADMAP.md ("Desktop chat apps").
 */
import type { ContextProfile } from "./profile.js";
import type { SketchProfile } from "./sketch.js";
import type { PackResult } from "./pack.js";
export type ResultMode = "full" | "compact";
export interface CompactResult {
    text: string;
    structured: Record<string, unknown>;
    meta: Record<string, unknown>;
}
/**
 * Which form a tool call gets. `requestMeta` is the request's `_meta`: ChatGPT
 * sends `openai/session`, `openai/subject`, `openai/locale` and the like on
 * every call. An explicit CONTEXT_DOCTOR_RESULTS (full or compact) wins.
 */
export declare function resultMode(requestMeta: unknown, env?: NodeJS.ProcessEnv): ResultMode;
/** profile_context on a conversation. */
export declare function compactProfile(p: ContextProfile, fullText: string): CompactResult;
/** profile_context on a chat-app sketch. */
export declare function compactSketch(p: SketchProfile, fullText: string): CompactResult;
/** pack_context with no query: sections instead of one line per chunk. */
export declare function compactOutline(r: PackResult, fullText: string, maxSections?: number): CompactResult;
