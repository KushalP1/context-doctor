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
/** A path for messages: the home folder as `~`. */
export declare function tilde(p: string): string;
