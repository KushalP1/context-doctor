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
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { claudeDir, tilde } from "./claudedir.js";
import { readSettings } from "./settingsedit.js";
/** Managed (policy) settings files: CLAUDE_CODE_MANAGED_SETTINGS_PATH, else the platform's place and its drop-in folder. */
export function managedSettingsPaths(env = process.env) {
    if (env.CONTEXT_DOCTOR_NO_MANAGED_SETTINGS)
        return [];
    if (env.CLAUDE_CODE_MANAGED_SETTINGS_PATH)
        return [env.CLAUDE_CODE_MANAGED_SETTINGS_PATH];
    const dir = process.platform === "darwin" ? "/Library/Application Support/ClaudeCode"
        : process.platform === "win32" ? join(env.ProgramFiles ?? "C:\\Program Files", "ClaudeCode")
            : "/etc/claude-code";
    const out = [join(dir, "managed-settings.json")];
    try {
        for (const f of readdirSync(join(dir, "managed-settings.d")).sort())
            if (f.endsWith(".json"))
                out.push(join(dir, "managed-settings.d", f));
    }
    catch {
        /* none */
    }
    return out;
}
/** The settings files that apply in `cwd`, highest precedence first; unreadable ones are skipped. */
export function settingsSources(opts = {}) {
    const env = opts.env ?? process.env;
    const cwd = opts.cwd ?? process.cwd();
    const user = join(claudeDir(opts.home, env), "settings.json");
    const list = [
        ...managedSettingsPaths(env).map((p) => ["managed", p]),
        ["project local", join(cwd, ".claude", "settings.local.json")],
        ["project", join(cwd, ".claude", "settings.json")],
        ["user", user],
    ];
    const out = [];
    const seen = new Set();
    for (const [name, path] of list) {
        // In the home folder the project's settings.json IS the user's: it counts once, as the user's.
        if (seen.has(path) || (name !== "user" && path === user))
            continue;
        seen.add(path);
        if (!existsSync(path))
            continue;
        try {
            out.push({ name, path, settings: readSettings(path).data });
        }
        catch {
            /* unreadable: Claude Code skips it too */
        }
    }
    return out;
}
/** An environment variable as Claude Code sees it: a settings file's `env` (highest first), else the process. */
export function effectiveEnv(name, sources, env = process.env) {
    for (const s of sources) {
        const v = s.settings.env?.[name];
        if (v !== undefined && v !== null && String(v).trim() !== "")
            return { value: String(v), where: `${name}=${v} in ${tilde(s.path)} env` };
    }
    const v = env[name];
    if (v !== undefined && v.trim() !== "")
        return { value: v, where: `${name}=${v} in the environment` };
    return undefined;
}
const truthy = (v) => v !== "0" && v.toLowerCase() !== "false";
/** The prompt cache lifetime Claude Code will use, as far as settings and environment decide it. */
export function effectiveTtl(kind, sources, env = process.env) {
    const force = effectiveEnv("FORCE_PROMPT_CACHING_5M", sources, env);
    if (force && truthy(force.value))
        return { value: "5m", where: force.where, fromUser: false };
    const ev = effectiveEnv(kind === "main" ? "CLAUDE_CODE_PROMPT_CACHE_TTL" : "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL", sources, env);
    const clamp = kind === "main" ? effectiveEnv("CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL", sources, env) : undefined;
    const clamped = (r) => (clamp?.value === "5m" && r.value === "1h" ? { value: "5m", where: clamp.where, fromUser: false } : r);
    if (ev)
        return clamped({ value: ev.value, where: ev.where, fromUser: false });
    const key = kind === "main" ? "promptCacheTtl" : "subagentPromptCacheTtl";
    for (const s of sources) {
        const v = s.settings[key];
        if (v !== undefined)
            return clamped({ value: String(v), where: `${key} in ${tilde(s.path)}`, fromUser: s.name === "user" });
    }
    const on1h = effectiveEnv("ENABLE_PROMPT_CACHING_1H", sources, env);
    if (on1h && truthy(on1h.value))
        return clamped({ value: "1h", where: on1h.where, fromUser: false });
    return { fromUser: false };
}
/** What keeps a user-level promptCacheTtl / subagentPromptCacheTtl from taking effect. */
export function ttlOverrides(kind, sources, env = process.env) {
    const out = [];
    const force = effectiveEnv("FORCE_PROMPT_CACHING_5M", sources, env);
    if (force && truthy(force.value))
        out.push(force.where);
    const ev = effectiveEnv(kind === "main" ? "CLAUDE_CODE_PROMPT_CACHE_TTL" : "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL", sources, env);
    if (ev)
        out.push(ev.where);
    const key = kind === "main" ? "promptCacheTtl" : "subagentPromptCacheTtl";
    for (const s of sources)
        if (s.name !== "user" && s.settings[key] !== undefined)
            out.push(`${key} "${s.settings[key]}" in ${tilde(s.path)}`);
    if (kind === "main") {
        const clamp = effectiveEnv("CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL", sources, env);
        if (clamp?.value === "5m")
            out.push(`${clamp.where} (keeps the main conversation at 5 minutes)`);
    }
    return out;
}
/** The auto-compact window Claude Code will use (for `model`, when given). */
export function effectiveCompactWindow(sources, env = process.env, model) {
    const ev = effectiveEnv("CLAUDE_CODE_AUTO_COMPACT_WINDOW", sources, env);
    if (ev && Number(ev.value) > 0)
        return { value: Number(ev.value), where: ev.where, fromUser: false };
    for (const s of sources) {
        if (model) {
            const per = s.settings.modelSettings?.[model]?.autoCompactWindow;
            if (per !== undefined)
                return { value: per, where: `modelSettings.${model}.autoCompactWindow in ${tilde(s.path)}`, fromUser: false };
        }
        const v = s.settings.autoCompactWindow;
        if (v !== undefined)
            return { value: v, where: `autoCompactWindow in ${tilde(s.path)}`, fromUser: s.name === "user" };
    }
    return { fromUser: false };
}
/** What keeps a user-level autoCompactWindow from taking effect (everywhere, or for some models). */
export function compactWindowOverrides(sources, env = process.env) {
    const out = [];
    const ev = effectiveEnv("CLAUDE_CODE_AUTO_COMPACT_WINDOW", sources, env);
    if (ev)
        out.push(ev.where);
    for (const s of sources) {
        if (s.name !== "user" && s.settings.autoCompactWindow !== undefined)
            out.push(`autoCompactWindow ${JSON.stringify(s.settings.autoCompactWindow)} in ${tilde(s.path)}`);
        const per = s.settings.modelSettings;
        if (per && typeof per === "object") {
            const models = Object.entries(per).filter(([, v]) => v?.autoCompactWindow !== undefined).map(([m]) => m);
            if (models.length)
                out.push(`a per-model autoCompactWindow for ${models.join(", ")} in ${tilde(s.path)} (wins for ${models.length === 1 ? "that model" : "those models"})`);
        }
    }
    return out;
}
