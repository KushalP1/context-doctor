/**
 * The cost of a model switch, said before it happens.
 *
 * Each model has its own prompt cache. Switching models mid-session (/model,
 * the picker, Option+P, an SDK's set_model) sends the whole context to the new
 * model, which writes all of it to its cache at 1.25x input (2x at the 1-hour
 * TTL), where the next request on the old model would have read it at
 * 5-10%. On a 600k-token session that is dollars per switch; `cache-misses`
 * finds them in the transcripts after the fact (8 of the 390 misses on the
 * author's history).
 *
 * Claude Code 2.1.251 and later run PreModelSwitch hooks before a switch
 * (verified in the 2.1.295 and 2.1.299 binaries and the hooks docs). Input:
 * session_id, transcript_path, cwd, hook_event_name, from_model, to_model,
 * requested_model, source ("command", "picker" or "sdk"), context_tokens,
 * prompt_cache_warm, cache_ttl ("5m" or "1h"), estimated_cache_write_usd and
 * pricing. A `systemMessage` in the output is shown to the user whether the
 * switch goes ahead or not; `permissionDecision` deny/ask, `decision: "block"`
 * or exit code 2 would stop it, and so does a hook that times out or crashes.
 * This hook only ever answers with a systemMessage and exit 0: it informs,
 * it never blocks, and it does no more than read the transcript's tail.
 *
 * Installing it has a trap, measured: Claude Code before 2.1.251 validates
 * ~/.claude/settings.json's hooks against the events it knows, and a file
 * with an unknown event is skipped ENTIRELY ("Files with errors are skipped
 * entirely, not just the invalid settings"): with a PreModelSwitch entry,
 * 2.1.62 ran none of the user's settings, hooks included. A plugin's inline
 * hooks fail the same way, while a plugin's separate hooks/hooks.json is
 * dropped alone. So `install` writes the hook only when every Claude Code it
 * can find on the machine is 2.1.251 or later, and the plugin carries it in a
 * file of its own.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { CACHE_WRITE_1H, CACHE_WRITE_5M, formatUsd, pricingFor } from "./pricing.js";
import { formatTokens } from "./tokens.js";
import { tailUsage } from "./statusline.js";

/** The first Claude Code that runs PreModelSwitch hooks (hooks docs). */
export const PRE_MODEL_SWITCH_SINCE = "2.1.251";

/** Below this context a switch costs pennies: nothing worth interrupting for. */
const MIN_CONTEXT = 20_000;

export interface ModelSwitchInput {
  transcript_path?: string;
  from_model?: unknown;
  to_model?: unknown;
  context_tokens?: unknown;
  prompt_cache_warm?: unknown;
  cache_ttl?: unknown;
}

/** Strip Claude Code's context-size tag: "claude-opus-5-5[1m]" is priced as claude-opus-5-5. */
const bare = (model: string): string => model.replace(/\[\d+m\]$/i, "");

/**
 * What switching costs, in one or two lines for the user, or undefined when
 * there is nothing worth saying: the cache is already cold (staying would
 * re-write it too), no real switch, or a small context.
 */
export function modelSwitchMessage(input: ModelSwitchInput): string | undefined {
  const to = typeof input.to_model === "string" && input.to_model ? input.to_model : undefined;
  const from = typeof input.from_model === "string" && input.from_model ? input.from_model : undefined;
  if (!to || (from && bare(from) === bare(to))) return undefined;
  if (input.prompt_cache_warm === false) return undefined;
  // The transcript's last reply measured the context as the API billed it;
  // Claude Code's own estimate stands in before the first reply.
  const live = input.transcript_path ? tailUsage(input.transcript_path) : undefined;
  const tokens = live?.tokens ?? (typeof input.context_tokens === "number" && Number.isFinite(input.context_tokens) ? input.context_tokens : 0);
  if (tokens < MIN_CONTEXT) return undefined;
  const oneHour = input.cache_ttl === "1h";
  const writeMult = oneHour ? CACHE_WRITE_1H : CACHE_WRITE_5M;
  const toPrice = pricingFor(bare(to));
  const fromPrice = from ? pricingFor(bare(from)) : undefined;
  const size = `~${formatTokens(tokens)}-token`;
  if (!toPrice) {
    return `context-doctor: switching to ${to} writes this session's ${size} context into its own cache once (no known price for ${to}); the next request on ${from ?? "the current model"} would read it from cache instead.`;
  }
  const writeUsd = (tokens / 1e6) * toPrice.inputPerM * writeMult;
  const stay = fromPrice ? `, where the next request on ${from} would read it for ${formatUsd((tokens / 1e6) * fromPrice.cacheReadPerM)}` : "";
  return (
    `context-doctor: switching to ${to} re-writes this session's ${size} context into its cache: ` +
    `about ${formatUsd(writeUsd)} once at the ${oneHour ? "1-hour" : "5-minute"} cache-write rate${stay}. ` +
    `Switching back later costs the same again; /compact first makes it cheaper.`
  );
}

// -- Which Claude Code versions are on this machine ---------------------------

export interface ClaudeCodeInstall {
  path: string;
  version: string;
  /** Where it was found: a CLI on PATH or a known install location, or the desktop app's bundled Claude Code. */
  source: "cli" | "desktop app";
}

/** Compare dotted versions numerically: -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

const VERSION = /(\d+\.\d+\.\d+)/;

/** A CLI binary's version: from its install path when it carries one, else its package.json, else `--version`. */
function cliVersion(bin: string, run: boolean): string | undefined {
  let real = bin;
  try {
    real = realpathSync(bin);
  } catch {
    /* keep the given path */
  }
  // Homebrew's cask (…/Caskroom/claude-code/2.1.62/claude) and the native
  // installer (~/.local/share/claude/versions/2.1.299) keep the version in the path.
  const inPath = /(?:claude-code|claude[\\/]versions)[\\/](\d+\.\d+\.\d+)/.exec(real);
  if (inPath) return inPath[1];
  // An npm global install: …/node_modules/@anthropic-ai/claude-code/cli.js.
  for (let dir = dirname(real), i = 0; i < 3; i++, dir = dirname(dir)) {
    const pkg = join(dir, "package.json");
    if (!existsSync(pkg)) continue;
    try {
      const p = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string; version?: string };
      if (p.name === "@anthropic-ai/claude-code" && typeof p.version === "string") return p.version;
    } catch {
      /* not it */
    }
  }
  if (!run) return undefined;
  try {
    const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000, env: { ...process.env, CLAUDECODE: "" }, shell: process.platform === "win32" });
    return VERSION.exec(String(r.stdout ?? ""))?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Every Claude Code this machine has that reads ~/.claude/settings.json: the
 * CLIs on PATH and in the usual install places, and the newest Claude Code
 * the desktop app has downloaded (the app runs the newest).
 */
export function claudeCodeInstalls(opts: { home?: string; pathEnv?: string; runVersion?: boolean } = {}): ClaudeCodeInstall[] {
  const home = opts.home ?? homedir();
  const out: ClaudeCodeInstall[] = [];
  const seen = new Set<string>();
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  const candidates = [
    ...(opts.pathEnv ?? process.env.PATH ?? "").split(delimiter).filter(Boolean).flatMap((d) => names.map((n) => join(d, n))),
    join(home, ".local", "bin", "claude"),
    join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const bin of candidates) {
    let real: string;
    try {
      if (!statSync(bin).isFile()) continue;
      real = realpathSync(bin);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    const version = cliVersion(bin, opts.runVersion !== false);
    if (version) out.push({ path: bin, version, source: "cli" });
  }
  // The desktop app keeps each Claude Code it downloads; it runs the newest.
  for (const root of [join(home, "Library", "Application Support", "Claude", "claude-code"), join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude-code")]) {
    let versions: string[];
    try {
      versions = readdirSync(root).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
    } catch {
      continue;
    }
    const newest = versions.sort(compareVersions).pop();
    if (newest) out.push({ path: join(root, newest), version: newest, source: "desktop app" });
  }
  return out;
}

export interface ModelSwitchReadiness {
  /** Safe to put a PreModelSwitch hook in ~/.claude/settings.json. */
  ok: boolean;
  /** Claude Code versions found that predate the event (and would skip the whole file). */
  old: ClaudeCodeInstall[];
  installs: ClaudeCodeInstall[];
}

export function modelSwitchReadiness(installs: ClaudeCodeInstall[] = claudeCodeInstalls()): ModelSwitchReadiness {
  const old = installs.filter((i) => compareVersions(i.version, PRE_MODEL_SWITCH_SINCE) < 0);
  return { ok: installs.length > 0 && old.length === 0, old, installs };
}

/** "Claude Code 2.1.62 (/opt/homebrew/bin/claude)" for messages. */
export function describeInstalls(list: ClaudeCodeInstall[]): string {
  return list.map((i) => `Claude Code ${i.version} (${i.source === "desktop app" ? "desktop app" : i.path.replace(homedir(), "~")})`).join(", ");
}
