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
import { homedir } from "node:os";
import { join, resolve } from "node:path";
function configDirEnv(home, env) {
    if (home !== undefined && home !== homedir())
        return undefined;
    const v = env.CLAUDE_CONFIG_DIR?.trim();
    return v ? resolve(v) : undefined;
}
/** `~/.claude`, or CLAUDE_CONFIG_DIR. */
export function claudeDir(home, env = process.env) {
    return configDirEnv(home, env) ?? join(home ?? homedir(), ".claude");
}
/** `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`. */
export function claudeJsonPath(home, env = process.env) {
    return join(configDirEnv(home, env) ?? home ?? homedir(), ".claude.json");
}
/** A path for messages: the home folder as `~`. */
export function tilde(p) {
    const h = homedir();
    return p.startsWith(h) ? "~" + p.slice(h.length) : p;
}
