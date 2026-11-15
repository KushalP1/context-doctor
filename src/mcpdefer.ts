/**
 * `fix --apply mcp-defer`: keep an MCP server's tools behind tool search.
 *
 * Tool search defers MCP tool definitions by default, but a server the user
 * configured with `"alwaysLoad": true`, or whose author marks its tools
 * `_meta["anthropic/alwaysLoad"]`, is sent whole on every request of every
 * session and subagent. `"alwaysLoad": false` in the server's own entry
 * defers all of its tools, the author-marked ones too (Claude Code 2.1.287+,
 * "Defer a server's tools" in the MCP docs). Only servers in the user's own
 * `~/.claude.json` (user scope, or this project's local scope) are written: a
 * project's `.mcp.json` is shared with everyone who clones it, so it is named,
 * not changed. The Desktop app's own servers and connectors are not in any
 * config file and no setting reaches them.
 *
 * Undo puts back each key as it was (absent, or the value it had), only
 * where it still holds `false`: Claude Code rewrites `~/.claude.json` all the
 * time, so the file is never restored whole.
 */

import { resolve } from "node:path";
import { claudeJsonPath, tilde } from "./claudedir.js";
import { ABSENT, getPath, readSettings, SettingsError, setJsonPath, writeAtomic } from "./settingsedit.js";

/** The Claude Code version that first reads `alwaysLoad: false` on a server. */
export const MCP_DEFER_SINCE = "2.1.287";

export interface DeferEntry {
  /** The key path in ~/.claude.json. */
  key: string[];
  /** Whether the key was there before, and its value then. */
  hadPrevious: boolean;
  previous?: unknown;
}

/** Where a server's `alwaysLoad` lives in ~/.claude.json, by scope; undefined for a scope fix does not write. */
export function deferKey(name: string, scope: string, cwd = process.cwd()): string[] | undefined {
  if (scope === "user") return ["mcpServers", name, "alwaysLoad"];
  if (scope === "project") return ["projects", resolve(cwd), "mcpServers", name, "alwaysLoad"];
  return undefined;
}

/**
 * Set `alwaysLoad: false` on each server, in one write of ~/.claude.json.
 * A server no longer in the file is skipped; one already deferred is left.
 * The caller holds the fix records' lock.
 */
export function applyMcpDefer(servers: Array<{ name: string; scope: string }>, opts: { home?: string; cwd?: string } = {}): { file: string; entries: DeferEntry[]; lines: string[] } {
  const file = claudeJsonPath(opts.home);
  const cur = readSettings(file);
  if (cur.text === undefined) throw new SettingsError(`${tilde(file)} does not exist: no MCP server to defer. Nothing was changed.`);
  let text = cur.text;
  const entries: DeferEntry[] = [];
  const lines: string[] = [];
  for (const s of servers) {
    const key = deferKey(s.name, s.scope, opts.cwd);
    if (!key) { lines.push(`– ${s.name}: in ${s.scope}, shared with the repository: set "alwaysLoad": false there yourself if everyone should get it`); continue; }
    const entry = getPath(cur.data, key.slice(0, -1));
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { lines.push(`– ${s.name}: no longer in ${tilde(file)}: skipped`); continue; }
    const now = (entry as Record<string, unknown>).alwaysLoad;
    if (now === false) { lines.push(`– ${s.name}: already deferred`); continue; }
    text = setJsonPath(text, key, false);
    entries.push({ key, hadPrevious: now !== undefined, ...(now !== undefined ? { previous: now } : {}) });
    lines.push(`✓ ${s.name}: "alwaysLoad": false in ${tilde(file)}`);
  }
  if (entries.length) writeAtomic(file, text);
  return { file, entries, lines };
}

/** Put each key back where it still holds `false`. The caller holds the fix records' lock. */
export function undoMcpDefer(file: string, entries: DeferEntry[]): string[] {
  const cur = readSettings(file);
  if (cur.text === undefined) return [`– ${tilde(file)} is gone: nothing to put back`];
  let text = cur.text;
  const lines: string[] = [];
  let changed = false;
  for (const e of entries) {
    const name = e.key[e.key.length - 2];
    const now = getPath(cur.data, e.key);
    if (now !== false) { lines.push(`– ${name}: alwaysLoad was changed since fix set it (now ${now === undefined ? "not set" : JSON.stringify(now)}): left as it is`); continue; }
    text = setJsonPath(text, e.key, e.hadPrevious ? e.previous : ABSENT);
    changed = true;
    lines.push(`✓ ${name}: alwaysLoad ${e.hadPrevious ? `back to ${JSON.stringify(e.previous)}` : "removed"}`);
  }
  if (changed) writeAtomic(file, text);
  return lines;
}
