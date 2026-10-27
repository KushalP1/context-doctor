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
/** The folders Antigravity creates: the shared config, and the app's, the IDE's and the CLI's data. */
export declare function antigravityDirs(): string[];
export declare function antigravityPresent(): boolean;
/** The app's own MCP file: before the shared config folder, the only one. */
export declare function antigravityLegacyMcpConfigPath(): string;
/**
 * The MCP file to write: the shared one, unless this install predates it
 * (no config folder, and the app's file is a real file, not the symlink the
 * migration leaves).
 */
export declare function antigravityMcpConfigPath(): string;
/**
 * Where our skill goes: the shared skills folder (app and IDE) when the
 * shared config folder exists, else the IDE's legacy one, which it still
 * reads; and the CLI's own when the CLI is here. No folder of Antigravity's
 * is created that it did not have.
 */
export declare function antigravitySkillDirs(): string[];
/** Every place a skill of ours may be, for uninstall and doctor. */
export declare function antigravityAllSkillDirs(): string[];
