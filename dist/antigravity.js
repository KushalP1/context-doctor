/**
 * Google Antigravity: the app, the IDE and the CLI. Checked 2026-10-27
 * against antigravity.google/docs (mcp, skills, hooks) and the 2.12.0 app on
 * the author's machine:
 *
 * - MCP: `~/.gemini/config/mcp_config.json` for the IDE and the CLI, the
 *   same `{"mcpServers": {name: {command, args, env, disabled, ...}}}` shape
 *   as Claude Desktop's. The app manages it in its settings; on the author's
 *   machine its own `~/.gemini/antigravity/mcp_config.json` is a symlink to
 *   that file, with a `.migrated` marker beside it. An install from before
 *   that move has only the app's file, so that one is used when the shared
 *   folder does not exist yet.
 * - Skills: `~/.gemini/config/skills/<name>/SKILL.md` for the app and the
 *   IDE, `~/.gemini/antigravity-cli/skills/<name>/` for the CLI; the same
 *   SKILL.md format as Claude Code (`description` required).
 * - Hooks (`~/.gemini/config/hooks.json`, `injectSteps`) are not installed.
 *   They pass a `transcriptPath`, but its format is undocumented and no
 *   transcript exists on the author's machine (the 13 `brain/` folders have
 *   empty `logs/`), so the every-prompt size check has nothing it can read;
 *   and the standing rules already arrive with the MCP server.
 *
 * `~/.gemini` alone is not Antigravity: Gemini CLI creates it too. Its own
 * folders are what count.
 */
import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function gemini() {
    return join(homedir(), ".gemini");
}
/** The folders Antigravity creates: the shared config, and the app's, the IDE's and the CLI's data. */
export function antigravityDirs() {
    return ["config", "antigravity", "antigravity-ide", "antigravity-cli"].map((d) => join(gemini(), d));
}
export function antigravityPresent() {
    return antigravityDirs().some((d) => existsSync(d));
}
/** The app's own MCP file: before the shared config folder, the only one. */
export function antigravityLegacyMcpConfigPath() {
    return join(gemini(), "antigravity", "mcp_config.json");
}
/**
 * The MCP file to write: the shared one, unless this install predates it
 * (no config folder, and the app's file is a real file, not the symlink the
 * migration leaves).
 */
export function antigravityMcpConfigPath() {
    const shared = join(gemini(), "config", "mcp_config.json");
    if (existsSync(join(gemini(), "config")))
        return shared;
    const legacy = antigravityLegacyMcpConfigPath();
    try {
        if (lstatSync(legacy).isFile())
            return legacy;
    }
    catch {
        /* absent */
    }
    return shared;
}
/**
 * Where our skill goes: the shared skills folder (app and IDE) when the
 * shared config folder exists, else the IDE's legacy one, which it still
 * reads; and the CLI's own when the CLI is here. No folder of Antigravity's
 * is created that it did not have.
 */
export function antigravitySkillDirs() {
    const dirs = [];
    if (existsSync(join(gemini(), "config")))
        dirs.push(join(gemini(), "config", "skills", "context-doctor"));
    else if (existsSync(join(gemini(), "antigravity")))
        dirs.push(join(gemini(), "antigravity", "skills", "context-doctor"));
    if (existsSync(join(gemini(), "antigravity-cli")))
        dirs.push(join(gemini(), "antigravity-cli", "skills", "context-doctor"));
    return dirs;
}
/** Every place a skill of ours may be, for uninstall and doctor. */
export function antigravityAllSkillDirs() {
    return [join(gemini(), "config", "skills", "context-doctor"), join(gemini(), "antigravity", "skills", "context-doctor"), join(gemini(), "antigravity-cli", "skills", "context-doctor")];
}
