/**
 * Where Claude Code keeps its user configuration.
 *
 * `~/.claude` (settings.json, projects/, skills/) and `~/.claude.json` (MCP
 * servers, per-project state), unless CLAUDE_CONFIG_DIR names another
 * folder: then both live there (read from the 2.1.309 binary: the global
 * file is `join(CLAUDE_CONFIG_DIR || home, ".claude.json")`, the settings
 * folder CLAUDE_CONFIG_DIR itself). A caller that passes its own `home`
 * (tests, a throwaway home) gets that home's folders: the variable describes
 * the real user's setup, not someone else's.
 */
/** `~/.claude`, or CLAUDE_CONFIG_DIR. */
export declare function claudeDir(home?: string, env?: NodeJS.ProcessEnv): string;
/** `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`. */
export declare function claudeJsonPath(home?: string, env?: NodeJS.ProcessEnv): string;
/**
 * Is Claude Code on this machine? Its `~/.claude.json`, or a `~/.claude`
 * that is not only context-doctor's own files. A folder of ours alone is
 * not Claude Code: the budget, the ledger and the Codex and Gemini CLI hooks
 * keep their files there, so on a machine with only Codex `budget 50/day`
 * made `install` wire a Claude Code that is not there.
 */
export declare function claudeCodePresent(home?: string, env?: NodeJS.ProcessEnv): boolean;
/**
 * Whether the signed-in account pays past its plan's limit from usage
 * credits ("extra usage"), as Claude Code last cached it in `~/.claude.json`:
 * `oauthAccount.hasExtraUsageEnabled` (from the account's profile) and the
 * top-level `cachedExtraUsageDisabledReason` (the last reply's
 * `anthropic-ratelimit-unified-overage-disabled-reason`, null when it had
 * none: read from the 2.1.311 binary). Undefined when the file has neither
 * (an API key, Bedrock, Vertex, never signed in) or cannot be read.
 */
export interface ExtraUsage {
    enabled?: boolean;
    /** Why the last reply said credits are off ("out_of_credits", "org_level_disabled"...); null: it said nothing against them. */
    disabledReason?: string | null;
}
export declare function readExtraUsage(home?: string, env?: NodeJS.ProcessEnv): ExtraUsage | undefined;
/** A path for messages: the home folder as `~`. */
export declare function tilde(p: string): string;
