/**
 * The cost of a model switch, said before it happens.
 *
 * Each model has its own prompt cache. Switching models mid-session (/model,
 * the picker, Option+P, an SDK's set_model) sends the whole context to the new
 * model, which writes all of it to its cache at 1.25x input (2x at the 1-hour
 * TTL), where the next request on the old model would have read it at
 * 5-10%. On a 600k-token session that is dollars per switch; `cache-misses`
 * finds them in the transcripts after the fact (8 of the 390 misses on the
 * author's history).
 *
 * Claude Code 2.1.251 and later run PreModelSwitch hooks before a switch
 * (verified in the 2.1.295 and 2.1.299 binaries and the hooks docs). Input:
 * session_id, transcript_path, cwd, hook_event_name, from_model, to_model,
 * requested_model, source ("command", "picker" or "sdk"), context_tokens,
 * prompt_cache_warm, cache_ttl ("5m" or "1h"), estimated_cache_write_usd and
 * pricing. A `systemMessage` in the output is shown to the user whether the
 * switch goes ahead or not; `permissionDecision` deny/ask, `decision: "block"`
 * or exit code 2 would stop it, and so does a hook that times out or crashes.
 * This hook only ever answers with a systemMessage and exit 0: it informs,
 * it never blocks, and it does no more than read the transcript's tail.
 *
 * Installing it has a trap, measured: Claude Code before 2.1.251 validates
 * ~/.claude/settings.json's hooks against the events it knows, and a file
 * with an unknown event is skipped ENTIRELY ("Files with errors are skipped
 * entirely, not just the invalid settings"): with a PreModelSwitch entry,
 * 2.1.62 ran none of the user's settings, hooks included. A plugin's inline
 * hooks fail the same way, while a plugin's separate hooks/hooks.json is
 * dropped alone. So `install` writes the hook only when every Claude Code it
 * can find on the machine is 2.1.251 or later, and the plugin carries it in a
 * file of its own.
 */
/** The first Claude Code that runs PreModelSwitch hooks (hooks docs). */
export declare const PRE_MODEL_SWITCH_SINCE = "2.1.251";
export interface ModelSwitchInput {
    transcript_path?: string;
    from_model?: unknown;
    to_model?: unknown;
    context_tokens?: unknown;
    prompt_cache_warm?: unknown;
    cache_ttl?: unknown;
}
/**
 * What switching costs, in one or two lines for the user, or undefined when
 * there is nothing worth saying: the cache is already cold (staying would
 * re-write it too), no real switch, or a small context.
 */
export declare function modelSwitchMessage(input: ModelSwitchInput): string | undefined;
export interface ClaudeCodeInstall {
    path: string;
    version: string;
    /** Where it was found: a CLI on PATH or a known install location, or the desktop app's bundled Claude Code. */
    source: "cli" | "desktop app";
}
/** Compare dotted versions numerically: -1, 0 or 1. */
export declare function compareVersions(a: string, b: string): number;
/**
 * Every Claude Code this machine has that reads ~/.claude/settings.json: the
 * CLIs on PATH and in the usual install places, and the newest Claude Code
 * the desktop app has downloaded (the app runs the newest).
 */
export declare function claudeCodeInstalls(opts?: {
    home?: string;
    pathEnv?: string;
    runVersion?: boolean;
}): ClaudeCodeInstall[];
export interface ModelSwitchReadiness {
    /** Safe to put a PreModelSwitch hook in ~/.claude/settings.json. */
    ok: boolean;
    /** Claude Code versions found that predate the event (and would skip the whole file). */
    old: ClaudeCodeInstall[];
    installs: ClaudeCodeInstall[];
}
export declare function modelSwitchReadiness(installs?: ClaudeCodeInstall[]): ModelSwitchReadiness;
/** "Claude Code 2.1.62 (/opt/homebrew/bin/claude)" for messages. */
export declare function describeInstalls(list: ClaudeCodeInstall[]): string;
