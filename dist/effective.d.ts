/**
 * The value Claude Code will actually use for a setting `fix` writes, and
 * what would override the user-level value `fix` writes.
 *
 * Claude Code merges settings from several files, highest first: managed
 * (policy) settings, the project's `.claude/settings.local.json`, its
 * `.claude/settings.json`, then the user's `settings.json` (in
 * CLAUDE_CONFIG_DIR when set). Read from the 2.1.309 binary:
 *  - the prompt cache lifetime: FORCE_PROMPT_CACHING_5M wins, then
 *    CLAUDE_CODE_PROMPT_CACHE_TTL (CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL for
 *    subagents), then the merged `promptCacheTtl` / `subagentPromptCacheTtl`,
 *    then an agent's own frontmatter, then ENABLE_PROMPT_CACHING_1H; and
 *    CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL=5m turns the main conversation's
 *    1 hour into 5 minutes;
 *  - the auto-compact window: CLAUDE_CODE_AUTO_COMPACT_WINDOW, else, from the
 *    highest file down, `modelSettings.<model>.autoCompactWindow` (what
 *    /autocompact writes) before that file's `autoCompactWindow` ("auto"
 *    meaning the model's own window).
 * Environment variables count from the process and from every settings
 * file's `env` block (Claude Code applies those at start).
 */
export type SourceName = "managed" | "project local" | "project" | "user";
export interface SettingsSource {
    name: SourceName;
    path: string;
    settings: Record<string, any>;
}
/** Managed (policy) settings files: CLAUDE_CODE_MANAGED_SETTINGS_PATH, else the platform's place and its drop-in folder. */
export declare function managedSettingsPaths(env?: NodeJS.ProcessEnv): string[];
/** The settings files that apply in `cwd`, highest precedence first; unreadable ones are skipped. */
export declare function settingsSources(opts?: {
    home?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}): SettingsSource[];
/** An environment variable as Claude Code sees it: a settings file's `env` (highest first), else the process. */
export declare function effectiveEnv(name: string, sources: SettingsSource[], env?: NodeJS.ProcessEnv): {
    value: string;
    where: string;
} | undefined;
export interface Effective<T> {
    value?: T;
    /** Where the value comes from, for messages. */
    where?: string;
    /** The value comes from the user's settings.json (what fix and cache-ttl write). */
    fromUser: boolean;
}
/** The prompt cache lifetime Claude Code will use, as far as settings and environment decide it. */
export declare function effectiveTtl(kind: "main" | "subagents", sources: SettingsSource[], env?: NodeJS.ProcessEnv): Effective<string>;
/** What keeps a user-level promptCacheTtl / subagentPromptCacheTtl from taking effect. */
export declare function ttlOverrides(kind: "main" | "subagents", sources: SettingsSource[], env?: NodeJS.ProcessEnv): string[];
/** The auto-compact window Claude Code will use (for `model`, when given). */
export declare function effectiveCompactWindow(sources: SettingsSource[], env?: NodeJS.ProcessEnv, model?: string): Effective<number | string>;
/** What keeps a user-level autoCompactWindow from taking effect (everywhere, or for some models). */
export declare function compactWindowOverrides(sources: SettingsSource[], env?: NodeJS.ProcessEnv): string[];
