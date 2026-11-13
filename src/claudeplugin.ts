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

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeDir } from "./claudedir.js";
import { compareVersions, type ClaudeCodeInstall } from "./modelswitch.js";
import { statePath } from "./ledger.js";

/** The first Claude Code that runs a plugin's mod (the Desktop app's Code tab; the terminal from 2.1.287). */
export const MOD_SINCE = "2.1.286";

/** Our marketplace's name (.claude-plugin/marketplace.json) and where it lives. */
export const MARKETPLACE = "context-doctor";
export const MARKETPLACE_REPO = "KushalP1/context-doctor";

/**
 * The key Claude Code enables our plugin under: "<plugin>@<marketplace>".
 * A copy listed in another marketplace keeps the plugin name, so any
 * "context-doctor@…" key is ours.
 */
export const PLUGIN_KEY = `context-doctor@${MARKETPLACE}`;

export function isOurPluginKey(key: string): boolean {
  return key === PLUGIN_KEY || key.startsWith("context-doctor@");
}

/**
 * The declaration install writes. autoUpdate: Claude Code refreshes it and
 * updates the plugin in the background after startup when plugin.json's
 * version changes (each release), as the npx-launched MCP server follows
 * npm; a third-party marketplace is off by default.
 */
export function marketplaceDeclaration(): { source: { source: "github"; repo: string }; autoUpdate: boolean } {
  return { source: { source: "github", repo: MARKETPLACE_REPO }, autoUpdate: true };
}

/** Is this extraKnownMarketplaces entry ours: this repository on GitHub, however Claude Code has touched it since? */
export function isOurDeclaration(entry: unknown): boolean {
  const src = (entry as { source?: { source?: unknown; repo?: unknown } } | undefined)?.source;
  return src?.source === "github" && typeof src.repo === "string" && src.repo.toLowerCase() === MARKETPLACE_REPO.toLowerCase();
}

export interface ModReadiness {
  /** Every Claude Code found runs mods: the plugin can stand in for install's own wiring. */
  ok: boolean;
  /** The ones that predate MOD_SINCE. */
  old: ClaudeCodeInstall[];
  installs: ClaudeCodeInstall[];
}

export function modReadiness(installs: ClaudeCodeInstall[]): ModReadiness {
  const old = installs.filter((i) => compareVersions(i.version, MOD_SINCE) < 0);
  return { ok: installs.length > 0 && old.length === 0, old, installs };
}

/** What install added to settings.json for the plugin, so uninstall takes out only that. */
export interface PluginMarker {
  /** install wrote extraKnownMarketplaces.context-doctor. */
  marketplace: boolean;
  /** install wrote enabledPlugins["context-doctor@context-doctor"]: true. */
  enabled: boolean;
}

export function pluginMarkerPath(): string {
  return join(claudeDir(), ".context-doctor-plugin.json");
}

export function readPluginMarker(): PluginMarker | undefined {
  try {
    const raw = JSON.parse(readFileSync(pluginMarkerPath(), "utf8"));
    if (!raw || typeof raw !== "object") return undefined;
    const m = { marketplace: raw.marketplace === true, enabled: raw.enabled === true };
    return m.marketplace || m.enabled ? m : undefined;
  } catch {
    return undefined;
  }
}

/** Claude Code's plugins folder: CLAUDE_CODE_PLUGIN_CACHE_DIR, else ~/.claude/plugins. */
export function claudePluginsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CODE_PLUGIN_CACHE_DIR?.trim() || join(claudeDir(), "plugins");
}

function readObject(path: string): Record<string, any> | undefined {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Is a marketplace named context-doctor registered with Claude Code (from any source)? */
export function marketplaceRegistered(): boolean {
  return Boolean(readObject(join(claudePluginsRoot(), "known_marketplaces.json"))?.[MARKETPLACE]);
}

/**
 * How far Claude Code has got with the plugin: "installed" (downloaded, at
 * `version`), "registered" (marketplace fetched, plugin not yet), or "none".
 */
export function pluginStage(): { stage: "installed" | "registered" | "none"; version?: string } {
  const installed = readObject(join(claudePluginsRoot(), "installed_plugins.json"))?.plugins;
  if (installed && typeof installed === "object") {
    for (const [key, list] of Object.entries(installed as Record<string, unknown>)) {
      if (!isOurPluginKey(key)) continue;
      const first = Array.isArray(list) ? (list[0] as { version?: unknown } | undefined) : undefined;
      return { stage: "installed", version: typeof first?.version === "string" ? first.version : undefined };
    }
  }
  return { stage: marketplaceRegistered() ? "registered" : "none" };
}

/** When the mod last wrote each ledger (ms since epoch), from the files' modification times. */
export function modActivity(): { cost?: number; limits?: number } {
  const at = (p: string) => {
    try {
      return existsSync(p) ? statSync(p).mtimeMs : undefined;
    } catch {
      return undefined;
    }
  };
  // modmeasure.ts costLogPath and limits.ts limitsLogPath, without loading the reports here.
  const dir = dirname(statePath());
  return { cost: at(join(dir, ".context-doctor-session-cost.jsonl")), limits: at(join(dir, ".context-doctor-limits.jsonl")) };
}

/** "3 h ago", "2 days ago". */
export function ago(ms: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - ms) / 60_000));
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
