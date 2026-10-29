/**
 * `context-doctor fix`: the findings as one plan, applied with consent,
 * undone in one step, and re-measured afterwards.
 *
 * Every lever below already existed as its own command, and on the author's
 * own machine none of the big ones was applied (the compact window unset,
 * $1,423 a month of input it would have saved; the cold-resume offer
 * followed 1 time in 33): a user had to read several reports and type the
 * right command for each. `fix` measures them all on the user's history,
 * ranks them by dollars, says what each changes and what it costs in
 * quality, and applies a fix only on a yes (or an explicit `--apply`).
 *
 * Every fix is one setting Claude Code (or autopilot) reads, written with a
 * backup and recorded in ~/.claude/.context-doctor-fixes.json with its
 * previous value; `fix undo` puts back exactly that. Later runs say what each
 * applied fix saved since, measured on the sessions after it:
 *  - the cache lifetime: the requests since, priced as billed against the
 *    lifetime they had before (the 1-hour share measured when it was set);
 *    the same content either way, so the replay is exact up to prices;
 *  - the compact window: each compaction since that came before the old
 *    window, priced as the context it removed from every later request until
 *    the session would have reached the old window, less the compaction's
 *    own request and summary (an estimate: what the summary dropped is not
 *    priced);
 *  - autopilot: what the proxy recorded saving since (its own ledger).
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { forEachLine, listSessions, isClaudeSession } from "./session.js";
import { pricingFor } from "./pricing.js";
import { contextWindowFor, realModel } from "./tokens.js";
import { adviseTtl, estimateCacheTtl, type CacheTtlReport, type CurrentTtl, type TtlKind } from "./cachettl.js";
import { ABSENT, getPath, readSettings, removeFile, sameJson, setJsonPath, SettingsError, withLock, writeAtomic } from "./settingsedit.js";
import { compactWindowOverrides, settingsSources, ttlOverrides } from "./effective.js";
import { tilde } from "./claudedir.js";
import { applyPrune, undoPrune, type ProjectPlan } from "./prune.js";
import { readLedger } from "./ledger.js";
import { claudeDir } from "./claudedir.js";

export type FixId = "compact-window" | "cache-ttl" | "cache-ttl-subagents" | "autopilot" | "tool-search" | "prune";

export interface Fix {
  id: FixId;
  title: string;
  /** Saved over the measured period, when it can be priced. */
  savedUsd?: number;
  savedShare?: number;
  /** How the figure was measured. */
  basis: string;
  /** What it costs in quality, plainly. */
  quality: string;
  /** What it writes, where. */
  change: string;
  state: "available" | "applied" | "not-here";
  /** Why not here, or what is already applied. */
  note?: string;
  /** The value it writes. */
  value?: number | string;
  /** What would keep it from taking effect (environment, project or managed settings, per-model values). */
  overriddenBy?: string[];
}

/** The measurements a plan is made from (so the plan itself is testable without a machine's history). */
export interface FixInputs {
  days: number;
  /** Input billed over the period, the sessions `savings` counts. */
  billedUsd: number;
  compactWindow?: { window: number; savedUsd: number; savedShare: number; compactionsPerWeek: number; nowPerWeek: number; current?: number };
  ttl?: CacheTtlReport;
  currentTtl?: CurrentTtl;
  autopilot?: { on: boolean; reachableUsd: number; reachableShare: number; unreachableSessions: number; sessions: number };
  /** ENABLE_TOOL_SEARCH in Claude Code's settings env, when it switches tool search off. */
  toolSearchOff?: string;
  /** MCP servers configured for Claude Code (user and this project), for the tool-search fix. */
  mcpServers?: number;
  /** This folder's project, when `overhead prune` finds unused servers or skills in it. */
  prune?: ProjectPlan;
  /** Per fix, what would keep the value fix writes from taking effect. */
  overrides?: Partial<Record<FixId, string[]>>;
  /** The record of applied fixes could not be read. */
  recordProblem?: string;
  /** The /compact offer at cold returns: advice, not a setting; `hooked` when the every-prompt hook (or the plugin) is there to make it. */
  coldResume?: { netUsd: number; returns: number; hooked: boolean };
}

/** Below this a priced fix is not worth a setting. */
const MIN_USD = 1;

const money = (n: number): string => (n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const k = (n: number) => `${Math.round(n / 1000)}k`;

export function planFixes(i: FixInputs): Fix[] {
  const fixes: Fix[] = [];
  const where = tilde(join(claudeDir(), "settings.json"));
  const cw = i.compactWindow;
  if (cw) {
    const applied = cw.current !== undefined;
    if (applied || cw.savedUsd >= MIN_USD) {
      fixes.push({
        id: "compact-window",
        title: `Compact earlier: auto-compact window ${k(applied ? cw.current! : cw.window)}`,
        savedUsd: applied ? undefined : cw.savedUsd,
        savedShare: applied ? undefined : cw.savedShare,
        basis: `your sessions replayed request by request at a ${k(cw.window)} window: ${cw.compactionsPerWeek.toFixed(1)} compactions a week instead of ${cw.nowPerWeek.toFixed(1)}`,
        quality: "each compaction replaces the history with a summary (the compaction hook tells it what to keep): detail for money",
        change: `${where}: autoCompactWindow = ${cw.window}`,
        state: applied ? "applied" : "available",
        note: applied ? `autoCompactWindow is ${cw.current}` : undefined,
        value: cw.window,
      });
    }
  }
  for (const kind of ["main", "subagents"] as const) {
    const r = i.ttl?.[kind];
    if (!r) continue;
    const set = i.currentTtl?.[kind];
    const a = adviseTtl(r);
    const id: FixId = kind === "main" ? "cache-ttl" : "cache-ttl-subagents";
    const key = kind === "main" ? "promptCacheTtl" : "subagentPromptCacheTtl";
    const who = kind === "main" ? "main conversation" : "subagents";
    if (a && a.ttl !== set) {
      fixes.push({
        id,
        title: `Cache lifetime, ${who}: ${a.ttl === "1h" ? "1 hour" : "5 minutes"}`,
        savedUsd: a.savedUsd,
        savedShare: a.savedShare,
        basis: `the same ${r.requests.toLocaleString("en-US")} requests priced at each lifetime (${pct(r.oneHourShare)} of writes at 1 hour as billed${a.ttl === "1h" && r.keptWarmAt1h ? `; ${r.keptWarmAt1h} cold re-writes kept warm` : ""})`,
        quality: "none: the same content is sent; only the price of keeping it cached changes",
        change: `${where}: ${key} = "${a.ttl}" (Claude Code 2.1.243+)`,
        state: "available",
        value: a.ttl,
      });
    } else if (set) {
      fixes.push({ id, title: `Cache lifetime, ${who}: ${set}`, basis: "set", quality: "none", change: `${key} = "${set}"`, state: "applied", note: `${key} is "${set}"`, value: set });
    }
  }
  const ap = i.autopilot;
  if (ap) {
    if (ap.on) {
      const nowhere = ap.sessions > 0 && ap.unreachableSessions === ap.sessions;
      fixes.push({ id: "autopilot", title: "Autopilot: clear stale tool output when the cache is cold", basis: "on", quality: "none measured: it clears only output the model has read, only when the cache is cold", change: "autopilot on", state: "applied", note: nowhere ? "on, but all your sessions ran in the desktop app, which it cannot reach" : "autopilot is on" });
    } else if (ap.reachableUsd >= MIN_USD) {
      fixes.push({
        id: "autopilot",
        title: "Autopilot: clear stale tool output when the cache is cold",
        savedUsd: ap.reachableUsd,
        savedShare: ap.reachableShare,
        basis: `your terminal and IDE sessions replayed through the shipped autopilot code${ap.unreachableSessions ? ` (${ap.unreachableSessions} desktop-app sessions it cannot reach left out)` : ""}`,
        quality: "clears only tool output the model has already read, only when the cache is cold, so a request never costs more; recall finds anything cleared",
        change: `a local proxy service on 127.0.0.1:8787; ${where} env.ANTHROPIC_BASE_URL`,
        state: "available",
      });
    } else if (ap.unreachableSessions > 0 && ap.unreachableSessions === ap.sessions) {
      fixes.push({ id: "autopilot", title: "Autopilot", basis: "", quality: "", change: "", state: "not-here", note: "all your sessions ran in the desktop app, which sets its own API address" });
    }
  }
  if (i.toolSearchOff !== undefined && (i.mcpServers ?? 0) > 0) {
    fixes.push({
      id: "tool-search",
      title: "MCP tool search back on",
      basis: `ENABLE_TOOL_SEARCH=${i.toolSearchOff} loads every tool definition of your ${i.mcpServers} MCP server${i.mcpServers === 1 ? "" : "s"} into every request; with search on Claude Code loads one when it is needed (Anthropic: ~77k tokens to ~8.7k on a large set, tool choice more accurate, not less)`,
      quality: "none expected: Anthropic measured better tool choice with search on (Opus 4.5: 79.5% to 88.1%)",
      change: `${where}: env.ENABLE_TOOL_SEARCH = "auto"`,
      state: "available",
      value: "auto",
    });
  }
  if (i.prune && !i.prune.thin && i.prune.unused.length > 0) {
    const names = i.prune.unused.map((u) => u.name);
    fixes.push({
      id: "prune",
      title: `Switch off ${names.length} unused MCP server${names.length === 1 ? "" : "s"} or skill${names.length === 1 ? "" : "s"} in this project`,
      basis: `none used in ${i.prune.sessions} sessions of this project in ${i.days} days: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""}`,
      quality: "none while they stay unused; undo brings them back",
      change: `${i.prune.cwd}/.claude/settings.local.json`,
      state: "available",
    });
  }
  for (const f of fixes) {
    const o = i.overrides?.[f.id];
    if (o?.length && f.state === "available") f.overriddenBy = o;
  }
  const rank = (f: Fix) => (f.state === "available" ? 0 : f.state === "applied" ? 2 : 3) + (f.savedUsd === undefined ? 1 : 0);
  return fixes.sort((a, b) => rank(a) - rank(b) || (b.savedUsd ?? 0) - (a.savedUsd ?? 0));
}

// -- The record of what fix applied -------------------------------------------------

export interface FixRecord {
  id: FixId;
  /** When it was first applied (ms). */
  at: number;
  /** The value it wrote. */
  value?: unknown;
  /** The setting's value before context-doctor first changed it, as written (any JSON). */
  previous?: unknown;
  /** Whether the setting existed before (`previous` may itself be null). */
  hadPrevious?: boolean;
  /** The settings file and key path it wrote. */
  file?: string;
  key?: string[];
  /** The whole file before its first change (null: there was no file), and as fix left it: undo puts `before` back when the file is still exactly `after`. */
  before?: string | null;
  after?: string;
  /** For cache-ttl: the share of writes at 1 hour before the change, the baseline "since" compares against. */
  oneHourShareBefore?: number;
  /** For prune: the project folder. */
  cwd?: string;
}

export function fixRecordPath(home?: string): string {
  return join(claudeDir(home), ".context-doctor-fixes.json");
}

function lockPath(home?: string): string {
  return join(claudeDir(home), ".context-doctor-fixes.lock");
}

/**
 * The records, strictly: an absent file is none; a file that is not ours to
 * read (corrupt, the wrong shape) is refused, never treated as empty and
 * overwritten: it lists what `fix undo` would put back.
 */
export function loadFixRecords(home?: string): FixRecord[] {
  const p = fixRecordPath(home);
  if (!existsSync(p)) return [];
  let v: any;
  try {
    v = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new SettingsError(`${tilde(p)} is not valid JSON (${(e as Error).message}): it lists what fix undo puts back, so nothing was changed. Repair it, or remove it to forget those fixes.`);
  }
  if (!v || typeof v !== "object" || !Array.isArray(v.fixes)) throw new SettingsError(`${tilde(p)} is not a list of fixes: nothing was changed. Repair it, or remove it to forget those fixes.`);
  return v.fixes.filter((f: any) => f && typeof f.id === "string" && typeof f.at === "number");
}

/** The records for reporting: a damaged file reads as none (the plan says so). */
export function readFixRecords(home?: string): FixRecord[] {
  try {
    return loadFixRecords(home);
  } catch {
    return [];
  }
}

function writeFixRecords(list: FixRecord[], home?: string): void {
  const p = fixRecordPath(home);
  mkdirSync(dirname(p), { recursive: true });
  writeAtomic(p, JSON.stringify({ version: 2, fixes: list }, null, 2) + "\n");
}

export interface FixDeps {
  home?: string;
  now?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Autopilot's own commands (injected in tests: they start and stop a service). */
  autopilotOn?: () => Promise<{ ok: boolean; lines: string[] }>;
  autopilotOff?: () => Promise<string[]>;
}

/** The settings key each settings fix writes. */
const KEY_PATH: Partial<Record<FixId, string[]>> = {
  "compact-window": ["autoCompactWindow"],
  "cache-ttl": ["promptCacheTtl"],
  "cache-ttl-subagents": ["subagentPromptCacheTtl"],
  "tool-search": ["env", "ENABLE_TOOL_SEARCH"],
};

/** What would keep this fix's value from taking effect, as Claude Code merges settings. */
export function fixOverrides(id: FixId, deps: { home?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {}): string[] {
  const env = deps.env ?? process.env;
  const sources = settingsSources({ home: deps.home, cwd: deps.cwd, env });
  if (id === "compact-window") return compactWindowOverrides(sources, env);
  if (id === "cache-ttl") return ttlOverrides("main", sources, env);
  if (id === "cache-ttl-subagents") return ttlOverrides("subagents", sources, env);
  if (id === "tool-search") {
    const out: string[] = [];
    for (const s of sources) if (s.name !== "user" && s.settings.env?.ENABLE_TOOL_SEARCH !== undefined) out.push(`ENABLE_TOOL_SEARCH=${s.settings.env.ENABLE_TOOL_SEARCH} in ${tilde(s.path)} env`);
    return out;
  }
  return [];
}

/** Set one key of the user's settings.json, under the lock, and record it (the first record's previous value is kept). */
function applySetting(fix: Fix, home: string | undefined, at: number, extra: Partial<FixRecord>): string[] {
  const key = KEY_PATH[fix.id]!;
  const file = join(claudeDir(home), "settings.json");
  mkdirSync(dirname(file), { recursive: true });
  return withLock(lockPath(home), () => {
    const records = loadFixRecords(home);
    const cur = readSettings(file);
    const now = getPath(cur.data, key);
    if (key.length > 1) {
      const parent = getPath(cur.data, key.slice(0, -1));
      if (parent !== undefined && (parent === null || typeof parent !== "object" || Array.isArray(parent))) throw new SettingsError(`"${key[0]}" in ${tilde(file)} is not an object; fix it first. Nothing was changed.`);
    }
    if (sameJson(now, fix.value)) return [`${key.join(".")} is already ${JSON.stringify(fix.value)} in ${tilde(file)}: nothing to change.`];
    const after = setJsonPath(cur.text, key, fix.value);
    writeAtomic(file, after);
    const old = records.find((r) => r.id === fix.id);
    const before = cur.text ?? null;
    const rec: FixRecord = {
      ...extra,
      id: fix.id,
      at: old?.at ?? at,
      value: fix.value,
      file,
      key,
      // A second apply keeps the state from before context-doctor's first change.
      previous: old ? old.previous : now,
      hadPrevious: old ? old.hadPrevious : now !== undefined,
      before: old ? (old.after === before ? old.before : undefined) : before,
      after,
      oneHourShareBefore: old?.oneHourShareBefore ?? extra.oneHourShareBefore,
    };
    writeFixRecords([...records.filter((r) => r.id !== fix.id), rec], home);
    return [`✓ ${fix.change}`];
  });
}

/** Apply one fix; record it unless it changed nothing. Refusals (a damaged settings file, a damaged record) change nothing. */
export async function applyFix(fix: Fix, deps: FixDeps = {}, context: { oneHourShare?: number; prune?: ProjectPlan } = {}): Promise<{ ok: boolean; lines: string[] }> {
  const home = deps.home;
  const at = deps.now ?? Date.now();
  if (fix.state !== "available") return { ok: false, lines: [`${fix.title}: ${fix.note ?? "nothing to apply here"}`] };
  try {
    if (KEY_PATH[fix.id]) {
      const lines = applySetting(fix, home, at, { oneHourShareBefore: context.oneHourShare });
      const over = fixOverrides(fix.id, deps);
      if (over.length) lines.push(`  ⚠ written, but it will not take effect while ${over.join("; ")} ${over.length === 1 ? "overrides" : "override"} it.`);
      return { ok: over.length === 0, lines };
    }
    if (fix.id === "autopilot") {
      if (!deps.autopilotOn) return { ok: false, lines: ["autopilot: run context-doctor autopilot on"] };
      loadFixRecords(home); // refuse before starting anything if the record is damaged
      const r = await deps.autopilotOn();
      if (r.ok) withLock(lockPath(home), () => writeFixRecords([...loadFixRecords(home).filter((x) => x.id !== "autopilot"), { id: "autopilot", at }], home));
      return r;
    }
    if (fix.id === "prune") {
      if (!context.prune) return { ok: false, lines: ["prune: no plan for this folder"] };
      const plan = context.prune;
      return withLock(lockPath(home), () => {
        const records = loadFixRecords(home);
        const r = applyPrune(plan);
        writeFixRecords([...records.filter((x) => x.id !== "prune"), { id: "prune", at, cwd: plan.cwd }], home);
        return { ok: true, lines: [`✓ switched off in ${r.file}: ${plan.unused.map((u) => u.name).join(", ")}`] };
      });
    }
  } catch (e) {
    if (e instanceof SettingsError) return { ok: false, lines: [`✗ ${fix.id}: ${e.message}`] };
    throw e;
  }
  return { ok: false, lines: [`${fix.id}: not a fix`] };
}

/** Undo one settings record; the line says what happened. Throws SettingsError on a damaged settings file. */
function undoSetting(r: FixRecord, home: string | undefined): string {
  const key = r.key ?? KEY_PATH[r.id]!;
  const file = r.file ?? join(claudeDir(home), "settings.json");
  const name = key.join(".");
  const cur = readSettings(file);
  const text = cur.text ?? null;
  // Nothing touched the file since fix wrote it: put back the file it found, byte for byte.
  if (r.after !== undefined && r.before !== undefined && text === r.after) {
    if (r.before === null) removeFile(file);
    else writeAtomic(file, r.before);
    return `✓ ${name} ${r.hadPrevious ? `back to ${JSON.stringify(r.previous)}` : "removed"}${r.before === null ? ` (and the ${tilde(file)} fix created)` : ""}`;
  }
  const now = getPath(cur.data, key);
  if (!sameJson(now, r.value)) {
    return `– ${name} was changed since fix set it (now ${now === undefined ? "not set" : JSON.stringify(now)}): left as it is`;
  }
  const next = setJsonPath(cur.text, key, r.hadPrevious ? r.previous : ABSENT);
  // A file fix created and that is now an empty object goes again.
  if (r.before === null && !r.hadPrevious) {
    try {
      const left = JSON.parse(next.replace(/^\uFEFF/, "") || "{}");
      if (left && typeof left === "object" && !Array.isArray(left) && Object.keys(left).length === 0) {
        removeFile(file);
        return `✓ ${name} removed (and the ${tilde(file)} fix created)`;
      }
    } catch {
      /* keep it */
    }
  }
  writeAtomic(file, next);
  return `✓ ${name} ${r.hadPrevious ? `back to ${JSON.stringify(r.previous)}` : "removed"}`;
}

/** Undo what fix applied: every fix, or the ones named. Returns what it did, line by line. */
export async function undoFixes(ids: FixId[] | undefined, deps: FixDeps = {}): Promise<string[]> {
  const home = deps.home;
  let records: FixRecord[];
  try {
    records = loadFixRecords(home);
  } catch (e) {
    if (e instanceof SettingsError) return [`✗ ${e.message}`];
    throw e;
  }
  const chosen = records.filter((r) => !ids || ids.includes(r.id));
  if (chosen.length === 0) return [ids ? `Nothing applied by context-doctor fix under ${ids.join(", ")}.` : "Nothing applied by context-doctor fix to undo."];
  const lines: string[] = [];
  // Newest first, so each file's whole-file restore finds the text it left.
  // Records are kept in the order they were (last) applied: newest first here.
  for (const r of [...chosen].reverse()) {
    let done = true;
    try {
      if (KEY_PATH[r.id]) {
        lines.push(withLock(lockPath(home), () => undoSetting(r, home)));
      } else if (r.id === "autopilot") {
        if (deps.autopilotOff) lines.push(...(await deps.autopilotOff()));
        else { lines.push("autopilot: run context-doctor autopilot off"); done = false; }
      } else if (r.id === "prune") {
        const u = r.cwd ? undoPrune(r.cwd) : undefined;
        lines.push(u ? `✓ switched back on in ${u.file}: ${u.removed.join(", ") || "nothing left to remove"}` : "✓ prune: nothing left to undo");
      }
    } catch (e) {
      done = false;
      lines.push(`✗ ${r.id}: ${(e as Error).message}`);
    }
    if (done) {
      try {
        withLock(lockPath(home), () => writeFixRecords(loadFixRecords(home).filter((x) => x.id !== r.id), home));
      } catch (e) {
        lines.push(`✗ ${r.id}: ${(e as Error).message}`);
      }
    }
  }
  // An empty record file goes too.
  try {
    if (loadFixRecords(home).length === 0) removeFile(fixRecordPath(home));
  } catch {
    /* damaged: left for the user */
  }
  return lines;
}

// -- What each applied fix saved since ------------------------------------------------

export interface SinceResult {
  id: FixId;
  at: number;
  /** Saved since it was applied; undefined when not priced. */
  savedUsd?: number;
  detail: string;
}

/**
 * Compactions since `since` that came before the old window, priced: every
 * later request in that session re-read less context, until the session
 * would have reached the old window and compacted anyway; less each
 * compaction's own request and a 20k-token summary at the output rate.
 */
export function compactWindowSavingsSince(since: number, previousWindow: number | undefined, paths?: string[]): { usd: number; compactions: number } {
  const targets = paths ?? listSessions(10_000).filter((s) => isClaudeSession(s) && s.modifiedAt.getTime() >= since).map((s) => s.path);
  let usd = 0, compactions = 0;
  for (const p of targets) {
    let episode: { pre: number; post?: number; trigger: number; open: boolean } | undefined;
    let pendingPre: number | undefined;
    let lastId: string | undefined;
    try {
      forEachLine(p, (line) => {
        if (!line.includes('"usage"') && !line.includes("compact_boundary")) return;
        let e: any;
        try { e = JSON.parse(line); } catch { return; }
        if (!e || e.isSidechain) return;
        const at = Date.parse(String(e.timestamp ?? ""));
        if (e.type === "system" && e.subtype === "compact_boundary") {
          episode = undefined;
          const md = e.compactMetadata ?? {};
          if (md.trigger === "auto" && typeof md.preTokens === "number" && Number.isFinite(at) && at >= since) pendingPre = md.preTokens;
          return;
        }
        const msg = e.message;
        if (e.type !== "assistant" || !msg?.usage) return;
        if (typeof msg.id === "string" && msg.id === lastId) return;
        lastId = typeof msg.id === "string" ? msg.id : undefined;
        const model = realModel(msg.model);
        const price = pricingFor(model);
        const u = msg.usage;
        const total = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        if (pendingPre !== undefined) {
          const oldTrigger = 0.97 * (previousWindow ?? contextWindowFor(model) ?? 200_000);
          // Only a compaction the old window would not have made yet.
          if (pendingPre < 0.9 * oldTrigger && price) {
            episode = { pre: pendingPre, post: total, trigger: oldTrigger, open: true };
            compactions++;
            usd -= (pendingPre * price.cacheReadPerM + 20_000 * price.outputPerM) / 1e6;
          }
          pendingPre = undefined;
          return;
        }
        if (episode?.open && price && episode.post !== undefined) {
          const cf = episode.pre + Math.max(0, total - episode.post);
          if (cf >= episode.trigger) episode.open = false;
          else usd += ((cf - total) * price.cacheReadPerM) / 1e6;
        }
      });
    } catch {
      /* unreadable */
    }
  }
  return { usd, compactions };
}

export function savedSince(records: FixRecord[], opts: { paths?: string[]; subagentPaths?: string[]; ledger?: ReturnType<typeof readLedger> } = {}): SinceResult[] {
  const out: SinceResult[] = [];
  for (const r of records) {
    if (r.id === "cache-ttl" || r.id === "cache-ttl-subagents") {
      const kind: TtlKind = r.id === "cache-ttl" ? "main" : "subagents";
      const rep = estimateCacheTtl(0, { since: r.at, minRequests: 1, paths: opts.paths, subagentPaths: opts.subagentPaths })[kind];
      if (!(rep.billedUsd > 0)) { out.push({ id: r.id, at: r.at, detail: "no requests since" }); continue; }
      const share = r.previous === "1h" ? 1 : r.previous === "5m" ? 0 : r.oneHourShareBefore ?? (kind === "main" ? 1 : 0);
      const before = share * rep.at1hUsd + (1 - share) * rep.at5mUsd;
      out.push({ id: r.id, at: r.at, savedUsd: before - rep.billedUsd, detail: `estimated: ${rep.requests.toLocaleString("en-US")} requests, priced as billed against the lifetime before (${pct(share)} at 1 hour), a cold re-write told by over 60% of the context written again` });
    } else if (r.id === "compact-window") {
      const c = compactWindowSavingsSince(r.at, typeof r.previous === "number" ? r.previous : undefined, opts.paths);
      out.push({ id: r.id, at: r.at, savedUsd: c.compactions ? c.usd : undefined, detail: c.compactions ? `${c.compactions} earlier compaction${c.compactions === 1 ? "" : "s"}, the context each removed from later requests (estimated; what the summary dropped is not priced)` : "no earlier compaction yet" });
    } else if (r.id === "autopilot") {
      const ledger = opts.ledger ?? readLedger();
      const ev = ledger.filter((e) => e.ev === "proxy" && e.ts >= r.at);
      const usd = ev.reduce((s, e) => s + (e.usd ?? 0), 0);
      out.push({ id: r.id, at: r.at, savedUsd: ev.length ? usd : undefined, detail: ev.length ? "recorded by the proxy" : "nothing recorded by the proxy yet" });
    } else {
      out.push({ id: r.id, at: r.at, detail: "applied; not priced" });
    }
  }
  return out;
}

// -- Rendering ---------------------------------------------------------------------------

const LABEL: Record<FixId, string> = {
  "compact-window": "Compact earlier",
  "cache-ttl": "Cache lifetime, main conversation",
  "cache-ttl-subagents": "Cache lifetime, subagents",
  autopilot: "Autopilot",
  "tool-search": "MCP tool search",
  prune: "Unused MCP servers and skills",
};

export function renderFixPlan(days: number, billedUsd: number, fixes: Fix[], since: SinceResult[], command = (s: string) => `context-doctor ${s}`, coldResume?: FixInputs["coldResume"], recordProblem?: string): string {
  const out: string[] = [];
  if (recordProblem) out.push(`⚠ ${recordProblem}`);
  out.push("context-doctor fix: what to change, ranked by what it saves you");
  out.push(`Last ${days} days of your Claude Code sessions, ${money(billedUsd)} of input at list prices`);
  out.push("─".repeat(66));
  const avail = fixes.filter((f) => f.state === "available");
  // No input billed: there is no history to measure, which is not "all applied".
  if (avail.length === 0) out.push(...(billedUsd > 0 ? ["Nothing left to fix here: every lever that pays on your history is applied."] : noHistory(days, command)));
  avail.forEach((f, n) => {
    const usd = f.savedUsd !== undefined ? `${money(f.savedUsd)}${f.savedShare !== undefined ? ` (${pct(f.savedShare)})` : ""}` : "not priced";
    const head = `${n + 1}. ${f.title}`;
    out.push(head.length < 52 ? head.padEnd(52) + usd.padStart(14) : `${head}   ${usd}`);
    out.push(`   measured: ${f.basis}`);
    out.push(`   quality:  ${f.quality}`);
    out.push(`   changes:  ${f.change}   [${f.id}]`);
    if (f.overriddenBy?.length) out.push(`   ⚠ would not take effect: ${f.overriddenBy.join("; ")}`);
  });
  if (avail.filter((f) => f.savedUsd !== undefined).length > 1) {
    out.push("   Each figure is measured alone. Do not add them up: the levers overlap (compacting earlier and");
    out.push("   the cache lifetime both change what is written to the cache), so together they save less.");
  }
  const applied = fixes.filter((f) => f.state === "applied");
  if (applied.length) {
    out.push("");
    out.push("Already applied");
    for (const f of applied) {
      const s = since.find((x) => x.id === f.id);
      const when = s ? ` since ${new Date(s.at).toISOString().slice(0, 10)}` : "";
      const saved = s?.savedUsd !== undefined ? `: ${s.savedUsd >= 0 ? "saved" : "cost"} ${money(Math.abs(s.savedUsd))}${when} (${s.detail})` : s ? `${when}: ${s.detail}` : "";
      out.push(`  ✓ ${LABEL[f.id]}: ${f.note ?? f.title}${saved}`);
    }
  }
  // Fixes applied by `fix` whose setting has since changed are still reported.
  for (const s of since.filter((x) => !applied.some((f) => f.id === x.id))) {
    out.push(`  ✓ ${LABEL[s.id]} (applied ${new Date(s.at).toISOString().slice(0, 10)})${s.savedUsd !== undefined ? `: ${s.savedUsd >= 0 ? "saved" : "cost"} ${money(Math.abs(s.savedUsd))} since (${s.detail})` : `: ${s.detail}`}`);
  }
  const elsewhere = fixes.filter((f) => f.state === "not-here");
  for (const f of elsewhere) out.push(`  - ${LABEL[f.id]}: ${f.note}`);
  if (coldResume && coldResume.netUsd >= MIN_USD) {
    out.push("");
    out.push("Advice you act on");
    out.push(`  /compact when you come back to a big session after the cache expired: ${money(coldResume.netUsd)} over ${coldResume.returns} returns.`);
    out.push(coldResume.hooked
      ? "  The every-prompt hook offers it at those moments; say yes when it does."
      : `  Nothing points those moments out yet: ${command("install")} (or the Claude Code plugin) adds the hook that does.`);
  }
  out.push("");
  if (avail.length) {
    out.push(`Apply: ${command("fix")} in a terminal asks about each one; or ${command(`fix --apply ${avail.map((f) => f.id).join(",")}`)}`);
  }
  out.push(`Undo everything fix applied: ${command("fix undo")}. Dollars at list price; on a subscription the same tokens come out of your usage limit.`);
  return out.join("\n");
}

/** What `fix` says on a machine with no Claude Code sessions in the period: savings' wording, and what to do. */
function noHistory(days: number, command: (s: string) => string): string[] {
  return [`No Claude Code sessions in the last ${days} days to measure yet, so no fix can be priced.`, `Use Claude Code for a while, then run this again: ${command("fix")}.`];
}

export function renderFixShare(days: number, billedUsd: number, fixes: Fix[]): string {
  const avail = fixes.filter((f) => f.state === "available" && f.savedUsd !== undefined);
  const lines = [`context-doctor fix on my last ${days} days of Claude Code (${money(billedUsd)} of input at list price):`];
  for (const f of avail) lines.push(`- ${LABEL[f.id]}: ${money(f.savedUsd!)}${f.savedShare !== undefined ? ` (${pct(f.savedShare)})` : ""}`);
  if (avail.length === 0) lines.push(billedUsd > 0 ? "- nothing left to fix" : "- no Claude Code sessions to measure yet");
  if (avail.length > 1) lines.push("Each measured alone; they overlap, so do not add them up.");
  lines.push("Measured on my own sessions, locally: npx context-doctor fix");
  return lines.join("\n");
}

export function parseFixIds(raw: string, fixes: Fix[]): { ids: FixId[]; unknown: string[] } {
  const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (names.includes("all")) return { ids: fixes.filter((f) => f.state === "available").map((f) => f.id), unknown: [] };
  const known = new Set<string>(Object.keys(LABEL));
  return { ids: names.filter((n) => known.has(n)) as FixId[], unknown: names.filter((n) => !known.has(n)) };
}

