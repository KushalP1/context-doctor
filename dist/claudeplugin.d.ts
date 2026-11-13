/**
 * The Claude Code plugin as `install`'s way into Claude Code (E1).
 *
 * The plugin carries everything install used to wire into Claude Code by
 * hand (the MCP server, the skills, the every-prompt, compaction,
 * session-start, subagent-price and model-switch hooks) plus the one thing
 * install could not: the mod (limits readings and Claude Code's own session
 * cost after each turn, the cold-return Compact first button,
 * /context-doctor-fix). Claude Code runs mods from 2.1.286 (Desktop app),
 * 2.1.287 (terminal) and 2.1.299 (VS Code).
 *
 * How it is switched on, verified on 2.1.321 (the Desktop app's) and 2.1.311
 * (Homebrew) in a throwaway HOME: two keys in ~/.claude/settings.json,
 * `extraKnownMarketplaces.context-doctor` (this repository on GitHub) and
 * `enabledPlugins["context-doctor@context-doctor"]: true`. Claude Code never
 * rewrites the file for them. At its next start it clones the marketplace in
 * the background (known_marketplaces.json, plugins/marketplaces/), then
 * downloads the enabled plugin (installed_plugins.json, plugins/cache/), and
 * loads it from the next session start (or /reload-plugins); a `-p` run with
 * CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1 loads it in the first session. The code
 * reconciling declared marketplaces is the binary's "[reconcile]" step; the
 * docs: code.claude.com/docs/en/plugins/loading ("Plugins and marketplaces
 * that aren't on disk at session start"). With both keys taken out again,
 * `claude plugin list` shows the downloaded copy "disabled" and no session
 * loads it. `claude plugin install` does not read the declaration (it
 * answers "not found in marketplace" until `marketplace add`, which
 * re-serialises settings.json), so the CLI is not the way.
 *
 * Settings are one file for every Claude Code on the machine, so the plugin
 * replaces install's own wiring only when every Claude Code found runs mods;
 * with an older one present (or none found) install keeps its own wiring for
 * all of them, as it does for the model-switch hook.
 */
import { type ClaudeCodeInstall } from "./modelswitch.js";
/** The first Claude Code that runs a plugin's mod (the Desktop app's Code tab; the terminal from 2.1.287). */
export declare const MOD_SINCE = "2.1.286";
/** Our marketplace's name (.claude-plugin/marketplace.json) and where it lives. */
export declare const MARKETPLACE = "context-doctor";
export declare const MARKETPLACE_REPO = "KushalP1/context-doctor";
/**
 * The key Claude Code enables our plugin under: "<plugin>@<marketplace>".
 * A copy listed in another marketplace keeps the plugin name, so any
 * "context-doctor@…" key is ours.
 */
export declare const PLUGIN_KEY = "context-doctor@context-doctor";
export declare function isOurPluginKey(key: string): boolean;
/**
 * The declaration install writes. autoUpdate: Claude Code refreshes it and
 * updates the plugin in the background after startup when plugin.json's
 * version changes (each release), as the npx-launched MCP server follows
 * npm; a third-party marketplace is off by default.
 */
export declare function marketplaceDeclaration(): {
    source: {
        source: "github";
        repo: string;
    };
    autoUpdate: boolean;
};
/** Is this extraKnownMarketplaces entry ours: this repository on GitHub, however Claude Code has touched it since? */
export declare function isOurDeclaration(entry: unknown): boolean;
export interface ModReadiness {
    /** Every Claude Code found runs mods: the plugin can stand in for install's own wiring. */
    ok: boolean;
    /** The ones that predate MOD_SINCE. */
    old: ClaudeCodeInstall[];
    installs: ClaudeCodeInstall[];
}
export declare function modReadiness(installs: ClaudeCodeInstall[]): ModReadiness;
/** What install added to settings.json for the plugin, so uninstall takes out only that. */
export interface PluginMarker {
    /** install wrote extraKnownMarketplaces.context-doctor. */
    marketplace: boolean;
    /** install wrote enabledPlugins["context-doctor@context-doctor"]: true. */
    enabled: boolean;
}
export declare function pluginMarkerPath(): string;
export declare function readPluginMarker(): PluginMarker | undefined;
/** Claude Code's plugins folder: CLAUDE_CODE_PLUGIN_CACHE_DIR, else ~/.claude/plugins. */
export declare function claudePluginsRoot(env?: NodeJS.ProcessEnv): string;
/** Is a marketplace named context-doctor registered with Claude Code (from any source)? */
export declare function marketplaceRegistered(): boolean;
/**
 * How far Claude Code has got with the plugin: "installed" (downloaded, at
 * `version`), "registered" (marketplace fetched, plugin not yet), or "none".
 */
export declare function pluginStage(): {
    stage: "installed" | "registered" | "none";
    version?: string;
};
/** When the mod last wrote each ledger (ms since epoch), from the files' modification times. */
export declare function modActivity(): {
    cost?: number;
    limits?: number;
};
/** "3 h ago", "2 days ago". */
export declare function ago(ms: number, now?: number): string;
