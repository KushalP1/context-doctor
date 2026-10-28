/**
 * `context-doctor cache-ttl`: how long Claude Code's prompt cache should
 * live, measured on your own pauses.
 *
 * Every request re-sends the whole conversation; the part the previous
 * request cached is read at 5-10% of the input price, if the cache is still
 * alive. Claude Code writes the cache with a lifetime of 5 minutes (1.25x
 * input per written token) or 1 hour (2x). A pause longer than the lifetime
 * makes the next request write the whole context again. Claude Code 2.1.243+
 * lets the user choose (code.claude.com/docs/en/env-vars):
 *  - `promptCacheTtl` ("5m" | "1h") for the main conversation; unset it is
 *    1 hour on a Claude subscription within its usage limits and 5 minutes on
 *    an API key, Bedrock, Vertex or Foundry (the setting's description in the
 *    2.1.309 binary); interactive sessions wrote 5-minute entries for a while
 *    from 2.1.301 (anthropics/claude-code#103673);
 *  - `subagentPromptCacheTtl` for subagents, workflows and background work;
 *    unset, 5 minutes (unless ENABLE_PROMPT_CACHING_1H=1).
 * The environment variables CLAUDE_CODE_PROMPT_CACHE_TTL and
 * CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL take precedence, and
 * FORCE_PROMPT_CACHING_5M overrides them all. An older Claude Code ignores
 * the keys (2.1.62 still ran the file's hooks with them present; measured),
 * so writing them is safe everywhere and takes effect where supported.
 *
 * The lifetime changes only the price: the same content is sent either way,
 * so there is no quality question. The replay, request by request over each
 * transcript, prices the same requests three ways: as billed, every write at
 * 5 minutes, every write at 1 hour. A request that found the cache cold (its
 * gap from the previous request past that entry's lifetime, and over 60% of
 * the previous context written again) would have read it at a lifetime that
 * covered the gap; a request that read a warm cache would have written it
 * all again at a lifetime its gap exceeded. Compactions and model switches
 * start a new cache in every arm. The main conversation and subagents are
 * replayed apart, since each has its own setting.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { forEachLine, listSessions, replyCounter } from "./session.js";
import { CACHE_WRITE_1H, CACHE_WRITE_5M, cacheWriteSplit, pricingFor, usageCost } from "./pricing.js";
import { realModel } from "./tokens.js";
import { readJson, writeJsonWithBackup } from "./install.js";
import { compareVersions, describeInstalls, type ClaudeCodeInstall } from "./modelswitch.js";

/** The first Claude Code with the promptCacheTtl and subagentPromptCacheTtl settings (CHANGELOG). */
export const CACHE_TTL_SINCE = "2.1.243";

export type Ttl = "5m" | "1h";
export type TtlKind = "main" | "subagents";

const FIVE_MIN = 300_000;
const HOUR = 3_600_000;
/** Over this share of the previous context written again: the cache was cold. */
const REWRITE_SHARE = 0.6;
/** A recommendation needs at least this saving, absolute and as a share of the billed input. */
const MIN_SAVING_USD = 1;
const MIN_SAVING_SHARE = 0.02;

export interface TtlReplay {
  /** Transcripts read (main: sessions with 10+ requests in the period, as `savings` counts them). */
  transcripts: number;
  requests: number;
  /** Input as billed: recorded usage at list price. */
  billedUsd: number;
  /** The same requests with every cache write at 5 minutes. */
  at5mUsd: number;
  /** ... and at 1 hour. */
  at1hUsd: number;
  /** Share of the cache-write tokens written at 1 hour, as billed. */
  oneHourShare: number;
  /** Requests a 1-hour cache would have kept warm (they re-wrote a cold one). */
  keptWarmAt1h: number;
  /** Requests a 5-minute cache would have let go cold (they read a warm one). */
  wentColdAt5m: number;
  /** Requests on models with no known price (not in the dollar figures). */
  unpriced: number;
}

export interface CacheTtlReport {
  days: number;
  main: TtlReplay;
  subagents: TtlReplay;
}

const empty = (): TtlReplay => ({ transcripts: 0, requests: 0, billedUsd: 0, at5mUsd: 0, at1hUsd: 0, oneHourShare: 0, keptWarmAt1h: 0, wentColdAt5m: 0, unpriced: 0 });

interface Acc extends TtlReplay {
  writes: number;
  writes1h: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Replay one transcript into `acc`, counting requests in [since, until).
 * `sidechains`: a subagent's own transcript, whose rows are all sidechain
 * rows; a main transcript skips them. Returns the requests counted.
 */
export function replayTtlTranscript(path: string, acc: Acc, since: number, until = Infinity, sidechains = false, runRows?: Set<string>): number {
  let prev: { at: number; ttl: number; total: number; model: string } | undefined;
  let lastTtl = FIVE_MIN;
  let compacted = false;
  let counted = 0;
  const sighting = replyCounter(runRows);
  forEachLine(path, (line) => {
    if (!line.includes('"usage"') && !line.includes("compact_boundary")) return;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (!e || typeof e !== "object" || (!sidechains && e.isSidechain)) return;
    if (e.type === "system" && e.subtype === "compact_boundary") {
      compacted = true;
      return;
    }
    const msg = e.message;
    if (e.type !== "assistant" || !msg?.usage) return;
    const seen = sighting(e);
    if (seen === "repeat") return;
    const model = realModel(msg.model);
    if (!model) return;
    const at = Date.parse(String(e.timestamp ?? ""));
    if (!Number.isFinite(at)) return;
    const u = msg.usage;
    const W = num(u.cache_creation_input_tokens);
    const R = num(u.cache_read_input_tokens);
    const I = num(u.input_tokens);
    const total = W + R + I;
    const split = cacheWriteSplit(u);
    // An entry lives as long as the TTL it was written at; a request that
    // wrote nothing keeps the lifetime of the last one that did.
    if (W > 0) lastTtl = split.oneHour > split.fiveMinute ? HOUR : FIVE_MIN;
    const p = pricingFor(model);
    if (at >= since && at < until && seen === "new") {
      counted++;
      acc.requests++;
      if (!p) acc.unpriced++;
      else {
        acc.billedUsd += usageCost(u, p).promptUsd;
        acc.writes += W;
        acc.writes1h += split.oneHour;
        const inp = p.inputPerM / 1e6;
        const rd = p.cacheReadPerM / 1e6;
        const continued = prev !== undefined && !compacted && prev.model === model;
        for (const [ttl, mult] of [[FIVE_MIN, CACHE_WRITE_5M], [HOUR, CACHE_WRITE_1H]] as const) {
          let read = R, write = W;
          if (continued && prev) {
            const gap = at - prev.at;
            const warmAsBilled = gap < prev.ttl;
            const warmHere = gap < ttl;
            if (warmAsBilled && !warmHere && R > 0) {
              // Read warm as billed; at this lifetime the entry had expired.
              write = W + R;
              read = 0;
              if (ttl === FIVE_MIN) acc.wentColdAt5m++;
            } else if (!warmAsBilled && warmHere && W > REWRITE_SHARE * prev.total) {
              // Re-written cold as billed; at this lifetime the previous context was still there.
              const kept = Math.max(0, Math.min(W, prev.total - R));
              read = R + kept;
              write = W - kept;
              if (ttl === HOUR && kept > 0) acc.keptWarmAt1h++;
            }
          }
          const usd = I * inp + read * rd + write * inp * mult;
          if (ttl === FIVE_MIN) acc.at5mUsd += usd;
          else acc.at1hUsd += usd;
        }
      }
    }
    prev = { at, ttl: lastTtl, total, model };
    compacted = false;
  });
  return counted;
}

function finish(acc: Acc): TtlReplay {
  const { writes, writes1h, ...r } = acc;
  return { ...r, oneHourShare: writes > 0 ? writes1h / writes : 0 };
}

/** Subagent transcripts of the main transcripts under ~/.claude/projects written since `since`. */
export function subagentTranscripts(since: number, home = homedir()): string[] {
  const root = join(home, ".claude", "projects");
  const out: string[] = [];
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return out;
  }
  for (const project of projects) {
    let entries: string[];
    try {
      entries = readdirSync(join(root, project));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) continue;
      const dir = join(root, project, entry, "subagents");
      if (!existsSync(dir)) continue;
      let files: string[];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const p = join(dir, f);
        try {
          if (statSync(p).mtimeMs >= since) out.push(p);
        } catch {
          /* gone */
        }
      }
    }
  }
  return out;
}

export interface TtlOptions {
  /** Main transcripts (default: Claude Code transcripts written in the period). */
  paths?: string[];
  /** Subagent transcripts (default: those under the main transcripts' folders). */
  subagentPaths?: string[];
  /** Count only requests before this time (default: now). */
  until?: number;
  /** Replay from this time instead of `days` before now. */
  since?: number;
  /** Main sessions need this many requests in the period to count (savings' rule: 10). */
  minRequests?: number;
  onProgress?: (done: number, total: number) => void;
}

export function estimateCacheTtl(days = 30, opts: TtlOptions = {}): CacheTtlReport {
  const since = opts.since ?? Date.now() - days * 86_400_000;
  const until = opts.until ?? Infinity;
  const mains = opts.paths ?? listSessions(10_000).filter((s) => s.path.includes(".claude") && s.modifiedAt.getTime() >= since).map((s) => s.path);
  const subs = opts.subagentPaths ?? subagentTranscripts(since);
  const minRequests = opts.minRequests ?? 10;
  const main: Acc = { ...empty(), writes: 0, writes1h: 0 };
  const sub: Acc = { ...empty(), writes: 0, writes1h: 0 };
  const runRows = new Set<string>();
  const total = mains.length + subs.length;
  for (const [i, p] of mains.entries()) {
    opts.onProgress?.(i, total);
    // Into a scratch accumulator first: a session counts only with enough requests.
    const one: Acc = { ...empty(), writes: 0, writes1h: 0 };
    try {
      if (replayTtlTranscript(p, one, since, until, false, runRows) < minRequests) continue;
    } catch {
      continue;
    }
    main.transcripts++;
    for (const k of ["requests", "billedUsd", "at5mUsd", "at1hUsd", "keptWarmAt1h", "wentColdAt5m", "unpriced", "writes", "writes1h"] as const) main[k] += one[k];
  }
  for (const [i, p] of subs.entries()) {
    opts.onProgress?.(mains.length + i, total);
    try {
      if (replayTtlTranscript(p, sub, since, until, true) > 0) sub.transcripts++;
    } catch {
      /* unreadable */
    }
  }
  opts.onProgress?.(total, total);
  return { days, main: finish(main), subagents: finish(sub) };
}

export interface TtlAdvice {
  ttl: Ttl;
  /** Saved against the input as billed. */
  savedUsd: number;
  savedShare: number;
}

/** The lifetime to set, when one is clearly cheaper than the input as billed; else undefined. */
export function adviseTtl(r: TtlReplay): TtlAdvice | undefined {
  if (!(r.billedUsd > 0)) return undefined;
  const best: Ttl = r.at1hUsd <= r.at5mUsd ? "1h" : "5m";
  const saved = r.billedUsd - (best === "1h" ? r.at1hUsd : r.at5mUsd);
  if (saved < Math.max(MIN_SAVING_USD, MIN_SAVING_SHARE * r.billedUsd)) return undefined;
  return { ttl: best, savedUsd: saved, savedShare: saved / r.billedUsd };
}

// -- The settings ---------------------------------------------------------------

const KEY: Record<TtlKind, string> = { main: "promptCacheTtl", subagents: "subagentPromptCacheTtl" };
const ENV: Record<TtlKind, string> = { main: "CLAUDE_CODE_PROMPT_CACHE_TTL", subagents: "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL" };

export function claudeSettingsPath(home = homedir()): string {
  return join(home, ".claude", "settings.json");
}

const asTtl = (v: unknown): Ttl | undefined => (v === "5m" || v === "1h" ? v : undefined);

export interface CurrentTtl {
  /** The setting in ~/.claude/settings.json. */
  main?: Ttl;
  subagents?: Ttl;
  /** What wins over the setting: the environment variable, in settings `env` or the process environment. */
  overrides: string[];
}

/** The lifetimes set in user settings, and anything that overrides them. */
export function currentTtl(home = homedir(), env: NodeJS.ProcessEnv = process.env): CurrentTtl {
  let s: Record<string, any> = {};
  try {
    s = readJson(claudeSettingsPath(home));
  } catch {
    /* unreadable settings: nothing known */
  }
  const senv = s.env && typeof s.env === "object" ? (s.env as Record<string, unknown>) : {};
  const overrides: string[] = [];
  for (const name of [ENV.main, ENV.subagents, "FORCE_PROMPT_CACHING_5M", "ENABLE_PROMPT_CACHING_1H"]) {
    const v = senv[name] ?? env[name];
    if (v !== undefined && v !== "" && v !== "0") overrides.push(`${name}=${String(v)}${senv[name] !== undefined ? " (settings env)" : ""}`);
  }
  return { main: asTtl(s[KEY.main]), subagents: asTtl(s[KEY.subagents]), overrides };
}

export interface SetTtlResult {
  changed: boolean;
  created: boolean;
  backup?: string;
  /** The value before the change (undefined: not set). */
  previous?: Ttl;
}

/** Set (or with undefined, remove) promptCacheTtl / subagentPromptCacheTtl in ~/.claude/settings.json. */
export function setCacheTtl(kind: TtlKind, ttl: Ttl | undefined, home = homedir()): SetTtlResult {
  const p = claudeSettingsPath(home);
  const existed = existsSync(p);
  const settings = readJson(p);
  const previous = asTtl(settings[KEY[kind]]);
  if (ttl === undefined ? !(KEY[kind] in settings) : settings[KEY[kind]] === ttl) return { changed: false, created: false, previous };
  if (ttl === undefined) delete settings[KEY[kind]];
  else settings[KEY[kind]] = ttl;
  writeJsonWithBackup(p, settings);
  return { changed: true, created: !existed, backup: existed ? `${p}.context-doctor.backup` : undefined, previous };
}

export function settingKey(kind: TtlKind): string {
  return KEY[kind];
}

/** Claude Code installs too old for the setting (it does nothing there). */
export function ttlUnsupported(installs: ClaudeCodeInstall[]): ClaudeCodeInstall[] {
  return installs.filter((i) => compareVersions(i.version, CACHE_TTL_SINCE) < 0);
}

// -- The report -------------------------------------------------------------------

function money(n: number): string {
  if (!(Math.abs(n) > 0.005)) return "$0";
  const a = Math.abs(n);
  const s = a >= 100 ? `$${Math.round(a).toLocaleString("en-US")}` : `$${a.toFixed(2)}`;
  return n < 0 ? `-${s}` : s;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function block(label: string, r: TtlReplay, set: Ttl | undefined, kind: TtlKind): string[] {
  const lines: string[] = [];
  lines.push(`${label}: ${r.requests.toLocaleString("en-US")} requests in ${r.transcripts} ${kind === "main" ? "sessions" : "subagent transcripts"}, ${pct(r.oneHourShare)} of cache writes at 1 hour`);
  if (!(r.billedUsd > 0)) {
    lines.push("  nothing priced to replay");
    return lines;
  }
  const row = (name: string, usd: number, note = "") => `  ${name.padEnd(22)} ${money(usd).padStart(9)}${note}`;
  lines.push(row("as billed", r.billedUsd, set ? `   (set: ${set})` : ""));
  const d5 = r.billedUsd - r.at5mUsd;
  const d1 = r.billedUsd - r.at1hUsd;
  lines.push(row("all at 5 minutes", r.at5mUsd, `   ${d5 >= 0 ? "saves" : "costs"} ${money(Math.abs(d5))} (${pct(Math.abs(d5) / r.billedUsd)})`));
  lines.push(row("all at 1 hour", r.at1hUsd, `   ${d1 >= 0 ? "saves" : "costs"} ${money(Math.abs(d1))} (${pct(Math.abs(d1) / r.billedUsd)})${r.keptWarmAt1h ? `; ${r.keptWarmAt1h} cold re-writes kept warm` : ""}`));
  return lines;
}

export function renderCacheTtl(r: CacheTtlReport, current: CurrentTtl, installs: ClaudeCodeInstall[] = [], command = (s: string) => `context-doctor ${s}`): string {
  const out: string[] = [];
  out.push("Prompt cache lifetime: 5 minutes or 1 hour (Claude Code's own setting)");
  out.push(`Last ${r.days} days, at list prices; the same content is sent either way`);
  out.push("─".repeat(66));
  out.push(...block("Main conversation", r.main, current.main, "main"));
  out.push("");
  out.push(...block("Subagents", r.subagents, current.subagents, "subagents"));
  out.push("");
  const advice: string[] = [];
  for (const kind of ["main", "subagents"] as const) {
    const a = adviseTtl(r[kind]);
    const set = current[kind];
    if (a && a.ttl !== set) {
      advice.push(`  ${kind === "main" ? "Main conversation" : "Subagents"}: ${a.ttl} would have saved ${money(a.savedUsd)} (${pct(a.savedShare)}).  Set: ${command(`cache-ttl ${a.ttl}${kind === "subagents" ? " --subagents" : ""}`)}`);
    }
  }
  if (advice.length) {
    out.push("Recommended");
    out.push(...advice);
  } else {
    out.push("No change pays: the lifetimes as billed are within 2% of the cheaper one.");
  }
  if (current.main || current.subagents) out.push(`Undo: ${command("cache-ttl off")}${current.subagents ? ` and ${command("cache-ttl off --subagents")}` : ""}`);
  if (current.overrides.length) out.push(`Note: ${current.overrides.join(", ")} overrides the setting.`);
  const old = ttlUnsupported(installs);
  if (old.length) out.push(`Note: ${describeInstalls(old)} predates the setting (${CACHE_TTL_SINCE}) and ignores it.`);
  out.push("");
  out.push("A 1-hour write costs 2x input, a 5-minute one 1.25x; a pause longer than the");
  out.push("lifetime makes the next message write the whole context again. On a subscription");
  out.push("the same tokens come out of your usage limit instead of a bill.");
  return out.join("\n");
}
