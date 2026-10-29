/**
 * `context-doctor doctor` — self-check for a local installation.
 *
 * Verifies every integration point end to end and prints one ✓/✗/– line per
 * check, so "it doesn't work" becomes a single pasteable diagnosis. Exits 1
 * when any check fails (✗), so a script can tell; an app that is absent, or
 * that nothing was installed into, is a note (–), not a failure.
 */
interface Check {
    label: string;
    status: "ok" | "warn" | "fail" | "skip";
    detail: string;
}
/**
 * Installed copies of the Agent Skill against the SKILL.md this version
 * ships. Install copies the file once and nothing updates it, so after an
 * upgrade the model kept reading the old instructions under a ✓. A copy
 * that differs is out of date or was edited by hand; either way install
 * replaces it with the current one. Line ends are not a difference.
 */
export declare function skillCheck(label: string, files: string[], okDetail?: string): Check;
/**
 * The prompt cache lifetime (`cache-ttl`), only when one is set: the value,
 * an environment variable that overrides it, and a Claude Code too old to
 * read it (it ignores the key; nothing else in the file is affected).
 */
export declare function cacheTtlCheck(home?: string, env?: NodeJS.ProcessEnv): Check | undefined;
/**
 * Devin (Cognition): the Devin CLI, and Devin Desktop (formerly Windsurf).
 * Checked against docs.devin.ai (2026-10-20): the CLI runs hooks from
 * ~/.claude/settings.json in Claude Code's format while its
 * `read_config_from.claude` is on (the default), with session_id and
 * prompt_id but no transcript_path in the input; the desktop app's Cascade
 * hooks (~/.codeium/windsurf/hooks.json) pass a transcript only to
 * post_cascade_response_with_transcript. So in Devin our hook runs (CLI) or
 * does not (Desktop) and has no transcript to measure either way: say that,
 * rather than nothing or a false "ok".
 */
export declare function devinCheck(home?: string): Check;
export declare function runDoctor(): Promise<void>;
/**
 * The Cursor version here: the newest one that ran the hook (its input
 * carries cursor_version, on every platform), else the macOS app bundle.
 */
export declare function cursorVersion(): string | undefined;
export {};
