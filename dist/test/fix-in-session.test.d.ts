/**
 * `fix` run from inside a Claude Code session (the plugin's
 * /context-doctor:fix runs it through the Bash tool). Claude Code copies
 * every settings file's `env` into its process at start, so the process's
 * CLAUDE_CODE_SUBAGENT_MODEL may be a project's value, or fix's own value
 * left from before an undo: neither is "a value you set" in the shell.
 */
export {};
