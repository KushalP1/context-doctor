/**
 * Claude Code UserPromptSubmit hook: runs on EVERY query in Claude Code (and
 * Codex, same format), and after every tool call in Cursor (postToolUse).
 *
 * Claude Code pipes hook input as JSON on stdin ({session_id, transcript_path,
 * prompt, ...}). We profile the session transcript; when the context is lean
 * we print nothing (zero noise, near-zero cost). When it crosses thresholds we
 * emit additionalContext with targeted hygiene guidance — so every query in a
 * heavy session gets nudged toward a leaner context automatically.
 *
 * Registered by `context-doctor install` under hooks.UserPromptSubmit in
 * ~/.claude/settings.json; removed by `context-doctor uninstall`.
 */
/** The hook input fields this module reads, as their types: anything else is dropped. */
export interface HookInput {
    session_id?: string;
    transcript_path?: string;
    cwd?: string;
    hook_event_name?: string;
    conversation_id?: string;
    model?: string;
    workspace_roots?: string[];
    cursor_version?: string;
    [key: string]: unknown;
}
/**
 * Hook input with the string fields checked. A number or object where a path
 * belongs reached fs.existsSync, which on current Node prints a
 * DeprecationWarning into the user's session (and will throw on a later one).
 */
export declare function hookInput(raw: unknown): HookInput;
export declare function runHook(): Promise<void>;
