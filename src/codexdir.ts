/**
 * Where Codex keeps its home: `~/.codex` (config.toml, hooks.json, auth.json,
 * AGENTS.md, skills/, sessions/, archived_sessions/), unless CODEX_HOME
 * names another folder. Read from the Codex binary (ChatGPT.app's, 2026-09):
 * a non-empty CODEX_HOME is used as given (it must exist; Codex refuses to
 * start otherwise), else `~/.codex`. As with CLAUDE_CONFIG_DIR (claudedir.ts),
 * a caller that passes its own `home` (tests, a throwaway home) gets that
 * home's folder: the variable describes the real user's setup.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** `~/.codex`, or CODEX_HOME. */
export function codexDir(home?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (home === undefined || home === homedir()) {
    const v = env.CODEX_HOME?.trim();
    if (v) return resolve(v);
  }
  return join(home ?? homedir(), ".codex");
}
