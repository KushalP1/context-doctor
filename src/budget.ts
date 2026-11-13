/**
 * `context-doctor budget`: a spend budget the every-prompt hook enforces.
 *
 * `budget 50/day` (or `200/week`) is kept in ~/.claude/.context-doctor-budget.json.
 * Before each prompt the hook (Claude Code's UserPromptSubmit, Codex's
 * UserPromptSubmit, Gemini CLI's BeforeAgent) adds up what today (or this
 * week, from Monday) has cost across Claude Code, Codex and Gemini CLI, as
 * `spend` prices it, and says so to the user once per threshold: at 50%, 80%
 * and 100%. With `--block`, over the budget it holds the prompt in each
 * host's documented way (`decision: "block"` with a reason in Claude Code and
 * Codex, `decision: "deny"` in Gemini CLI), saying how to lift it. Cursor is
 * not counted: its history is a database too slow to read on every prompt,
 * and its prompt hook cannot add a line.
 *
 * The hook must stay fast, so the period's spend is a ledger
 * (~/.claude/.context-doctor-budget-state.json): per transcript, its size,
 * time and inode when last read, and the period's requests in it (a short
 * key and the dollars). A transcript met for the first time in a period is
 * read through the shared scan (scan.ts), as `spend` reads it; after that a
 * prompt reads only what was appended to the transcripts that changed, a
 * few kilobytes, without loading the scan's records for a whole transcript
 * (megabytes for a long one). The keys let a fork's copy of its parent's
 * replies count once. Measured on the author's history: docs/spend.md.
 */

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { codexDir } from "./codexdir.js";
import { fallbackStateDir, statePath } from "./ledger.js";
import { claudeCodePresent, claudeDir } from "./claudedir.js";
import { claudeFileUsage, codexSessionsRoot, rolloutFiles, SUBAGENT_LOOKBACK_MS, USAGE_ROWS } from "./limits.js";
import { subagentFiles } from "./subagents.js";
import { codexFileSpend, codexFiles, geminiFileSpend, geminiFiles, TOOL_NAME, type Tool } from "./spend.js";
import { isUnbilledModel, priceChangedText, priceTableKey, requestCost, type RecordedUsage } from "./pricing.js";
import { orgRates, orgRatesLine } from "./orgrates.js";
import { anchorOf, rowsOf } from "./scan.js";
import { realModel } from "./tokens.js";
import { isCompactionRow, isTrack, newTrack, trackCompaction, type CompactTrack } from "./compactcost.js";

export type Period = "day" | "week";

export interface Budget {
  usd: number;
  period: Period;
  /** Over the budget, hold the prompt instead of only saying so. */
  block: boolean;
  /** When it was set, ms. */
  at: number;
}

/** Beside the hook state and the ledger: ~/.claude/.context-doctor-budget.json. */
export function budgetPath(): string {
  return join(dirname(statePath()), ".context-doctor-budget.json");
}

/** The period's spend ledger and what was said: ~/.claude/.context-doctor-budget-state.json. */
export function budgetStatePath(): string {
  return join(dirname(statePath()), ".context-doctor-budget-state.json");
}

/**
 * "50/day", "$200/week", "7.5/d", "100/wk", "50/days": a budget, or an
 * error to show. Dollars are kept to the cent (50.555 was stored as given
 * and shown as $50.55); `note` says so when the amount was rounded.
 */
export function parseBudget(arg: string): { usd: number; period: Period; note?: string } | { error: string } {
  const m = /^\$?(\d*\.?\d+)\s*\/\s*(days?|d|daily|weeks?|w|wks?|weekly)$/i.exec(arg.trim());
  // Rounded in decimal ("50.555e2"), not in binary: 50.555 * 100 is 5055.4999...
  const usd = m ? Math.round(Number(`${m[1]}e2`)) / 100 : Number.NaN;
  // Under a cent it read "your $0.00/day budget".
  if (!m || !(usd >= 0.01) || usd > 1_000_000) return { error: `"${arg}" is not a budget: give dollars per day or per week, e.g. 50/day or 200/week.` };
  const period: Period = /^d/i.test(m[2]) ? "day" : "week";
  return { usd, period, ...(usd !== Number(m[1]) ? { note: `${m[1]} rounded to the cent: $${usd.toFixed(2)} a ${period}.` } : {}) };
}

export function readBudget(): Budget | undefined {
  try {
    const b = JSON.parse(readFileSync(budgetPath(), "utf8"));
    if (typeof b?.usd === "number" && b.usd > 0 && (b.period === "day" || b.period === "week")) return { usd: b.usd, period: b.period, block: b.block === true, at: Number(b.at) || 0 };
  } catch {
    /* none set, or damaged: no budget */
  }
  return undefined;
}

/** A whole file renamed into place, so two prompts at once never read half of one. */
export function writeWhole(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never written */ }
    throw e;
  }
}

export function writeBudget(b: Budget): void {
  // Only the budget's own fields: a parse result's note is not part of it.
  writeWhole(budgetPath(), { usd: b.usd, period: b.period, block: b.block, at: b.at });
  // A new budget starts its thresholds afresh; the ledger stays (same period, same spend).
  const st = readState();
  if (st) writeWhole(budgetStatePath(), { ...st, warned: 0 });
  clearSaid();
}

/**
 * The thresholds said this period, one marker file each
 * (~/.claude/.context-doctor-budget-said.d/<period start>-<percent>). The
 * ledger records them too, but it is read, then written: two prompts at once
 * (two sessions) could both read "not said" and both say it.
 */
function saidDir(): string {
  return join(dirname(budgetStatePath()), ".context-doctor-budget-said.d");
}

/** True for exactly one caller: the marker of `level` (and of the lower thresholds, so a stale lower one is not said after it) did not exist. */
function claimSaid(start: number, level: number): boolean {
  const create = (t: number): boolean => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(join(saidDir(), `${start}-${t}`), "", { flag: "wx", mode: 0o600 });
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT" || attempt) return (e as NodeJS.ErrnoException).code !== "EEXIST";
        try { mkdirSync(saidDir(), { recursive: true }); } catch { return true; }
      }
    }
    return true;
  };
  const mine = create(level);
  for (const t of THRESHOLDS) if (t < level) create(t);
  return mine;
}

/** A new period, budget or none: the markers of other periods (or all) go. */
function clearSaid(keep?: number): void {
  try {
    for (const f of readdirSync(saidDir())) if (keep === undefined || !f.startsWith(`${keep}-`)) rmSync(join(saidDir(), f), { force: true });
  } catch { /* none */ }
}

/** Remove the budget and its ledger. True when there was one. */
export function clearBudget(): boolean {
  const had = existsSync(budgetPath());
  const dir = dirname(budgetPath());
  // A folder that held only our files, which we made (0.41.0 made ~/.claude for the budget on a
  // machine with only Codex), goes with them once empty; Claude Code's own folder never does.
  let ours = false;
  try {
    const entries = readdirSync(dir);
    ours = entries.length > 0 && entries.every((f) => f.startsWith(".context-doctor")) &&
      (dir === fallbackStateDir() || (dir === claudeDir() && !claudeCodePresent() && !process.env.CLAUDE_CONFIG_DIR?.trim()));
  } catch { /* no folder */ }
  rmSync(budgetPath(), { force: true });
  rmSync(budgetStatePath(), { force: true });
  rmSync(saidDir(), { recursive: true, force: true });
  if (ours) try { rmdirSync(dir); } catch { /* other files of ours are still in it */ }
  return had;
}

/** The start of the period holding `now`: local midnight, or Monday's for a week. */
export function periodStart(period: Period, now = Date.now()): number {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (period === "week") start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start.getTime();
}

/** When the period holding `now` ends (the next one starts). */
export function periodEnd(period: Period, now = Date.now()): number {
  const s = new Date(periodStart(period, now));
  s.setDate(s.getDate() + (period === "week" ? 7 : 1));
  return s.getTime();
}

// ---------------------------------------------------------------------------
// The period's spend, kept as a ledger
// ---------------------------------------------------------------------------

/**
 * One transcript as last read: size, time, inode; the period's requests in
 * it as keys ("" for none) and dollars. A Claude Code transcript also keeps
 * where reading stopped (`o`, after the last whole line) and its last
 * replies (`r`: message id, index into k/d or -1, output so far, output
 * price per 1M), so an append is read from there: a reply's later rows are
 * met within its last few, and only settle its output. `a` fingerprints the
 * bytes before `o` (the shared scan's anchorOf): a transcript rewritten in
 * place, same inode and no smaller, is read again in full, not from `o`.
 * `x` lists the requests on a model with no list price (index into k/d,
 * model): in `d` at $0, and said so rather than silently left out. `y`
 * lists those priced only by their model's family (an estimate), the same
 * way; `z` those priced past the day their model's price changed (index,
 * model, the day). `d` is requestCost's: each request's tier, fast mode,
 * US-only and web searches, and the output price in `r` is its own. `p`
 * fingerprints the price table `d` was priced by (pricing.ts priceTableKey)
 * and the organization's rates (orgrates.ts), when set: an entry priced
 * under another table or other rates is read again. `c` is where reading a
 * Claude Code transcript's compactions stopped (compactcost.ts): each
 * compaction's own request is in `k`/`d` too, estimated, keyed by its
 * boundary's uuid.
 */
export interface FileEntry { t: Tool; s: number; m: number; i: number; k: string[]; d: number[]; o?: number; a?: string; r?: Array<[string, number, number, number]>; x?: Array<[number, string]>; y?: Array<[number, string]>; z?: Array<[number, string, string]>; p?: string; c?: CompactTrack }

/** What a ledger entry counts: 2, each Claude Code compaction's own request too (compactcost.ts). An entry counted otherwise is read again. */
const COUNTED = 2;

/** Replies remembered per transcript, to tell a later row of one from a new reply. */
const RECENT_REPLIES = 64;

interface BudgetState {
  start: number;
  files: Record<string, FileEntry>;
  /** The highest threshold already said this period (0, 50, 80, 100). */
  warned: number;
  /** Whether the hook has said that part of this period has no list price. */
  unpricedSaid?: boolean;
  /** Codex's rollouts written in the period at the last full walk of its folders, and when (ms). */
  cx?: { at: number; files: string[] };
  usd: number;
  byTool: Partial<Record<Tool, number>>;
}

function readState(): BudgetState | undefined {
  try {
    const s = JSON.parse(readFileSync(budgetStatePath(), "utf8"));
    if (typeof s?.start === "number" && s.files && typeof s.files === "object") return { start: s.start, files: s.files, warned: Number(s.warned) || 0, unpricedSaid: s.unpricedSaid === true, ...(s.cx && typeof s.cx.at === "number" && Array.isArray(s.cx.files) ? { cx: s.cx } : {}), usd: Number(s.usd) || 0, byTool: s.byTool ?? {} };
  } catch {
    /* none yet, or damaged: start afresh */
  }
  return undefined;
}

/**
 * Write the ledger. Another prompt or the status line may have written it
 * meanwhile: a threshold it already said stays said.
 */
function saveState(st: BudgetState): void {
  const disk = readState();
  if (disk?.start === st.start) {
    st.warned = Math.max(st.warned, disk.warned);
    st.unpricedSaid = st.unpricedSaid || disk.unpricedSaid;
  }
  try { writeWhole(budgetStatePath(), st); } catch { /* a read-only folder: worked out again next time */ }
}

/**
 * Claude Code's transcripts written since `since`, without listing Codex's or
 * Gemini's too: each main transcript written since then, and the subagents
 * (workflow agents included) written since then of every session written in
 * the SUBAGENT_LOOKBACK_MS before it. A subagent still running after
 * midnight, its session quiet meanwhile, was not counted until the session
 * itself was written again.
 */
function claudePeriodFiles(since: number): string[] {
  const root = join(claudeDir(), "projects");
  const out: string[] = [];
  let dirs: string[];
  try { dirs = readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    let names: string[];
    try { names = readdirSync(join(root, d)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const top = join(root, d, n);
      let m: number;
      try { m = statSync(top).mtimeMs; } catch { continue; /* vanished */ }
      if (m < since - SUBAGENT_LOOKBACK_MS) continue;
      if (m >= since) out.push(top);
      for (const f of subagentFiles(top, since)) out.push(f.file);
    }
  }
  return out;
}

/** How long the hook goes between full walks of Codex's folders. */
const CODEX_WALK_MS = 5 * 60_000;

/**
 * Codex's rollouts written in the period, without stat'ing every rollout on
 * every prompt (3,000 of them took 16 ms; the status line runs this too).
 * Codex files a rollout under the day it began (sessions/YYYY/MM/DD), so a
 * new one is in the period's own folders, walked every time. A resumed one
 * is appended where it is, in an older folder: those are found by a full
 * walk, done once every CODEX_WALK_MS (so a resumed session's spend can be
 * up to five minutes late) and at once when a known rollout is gone (moved
 * to archived_sessions). `st.cx` keeps the last full walk.
 */
function codexPeriodFiles(st: BudgetState, start: number, now: number, home: string): string[] {
  const known = st.cx?.files ?? [];
  if (!st.cx || now - st.cx.at >= CODEX_WALK_MS || now < st.cx.at || known.some((f) => !existsSync(f))) {
    st.cx = { at: now, files: codexFiles(start, home) };
    return st.cx.files;
  }
  // The period's day folders, by local and by UTC date, a day either side.
  const root = codexSessionsRoot(home);
  const days = new Set<string>();
  for (let t = start - 86_400_000; t <= now + 86_400_000; t += 3_600_000) {
    const d = new Date(t);
    for (const [y, m, dd] of [[d.getFullYear(), d.getMonth() + 1, d.getDate()], [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]]) days.add(join(root, String(y), String(m).padStart(2, "0"), String(dd).padStart(2, "0")));
  }
  const out = new Set(known);
  for (const dir of days) for (const f of rolloutFiles(dir, start)) out.add(f);
  return [...out];
}

/** 12 hex digits of a row's uuid: enough to tell a fork's copy, a third of the bytes. */
const keyOf = (uuid: string | undefined) => (uuid ? uuid.slice(0, 13) : "");

/** The offset just after the last newline before `size`: where a whole-line read resumes. */
function lineStart(fd: number, size: number): number {
  const buf = Buffer.alloc(64 * 1024);
  for (let end = size; end > 0;) {
    const from = Math.max(0, end - buf.length);
    const n = readSync(fd, buf, 0, end - from, from);
    const nl = buf.subarray(0, n).lastIndexOf(10);
    if (nl >= 0) return from + nl + 1;
    end = from;
  }
  return 0;
}

/**
 * The requests of one transcript in the period, read in full (through the
 * shared scan, so only what it has not cached), as the ledger keeps them.
 */
function readFile(tool: Tool, file: string, since: number, size: number): Omit<FileEntry, "t" | "s" | "m" | "i"> {
  const k: string[] = [], d: number[] = [], x: NonNullable<FileEntry["x"]> = [], y: NonNullable<FileEntry["y"]> = [], z: NonNullable<FileEntry["z"]> = [];
  const flag = (i: number, q: { model?: string; priced: boolean; estimated?: boolean; changedOn?: string }) => {
    if (!q.priced) x.push([i, q.model ?? "unknown"]);
    else if (q.changedOn) z.push([i, q.model ?? "unknown", q.changedOn]);
    else if (q.estimated) y.push([i, q.model ?? "unknown"]);
  };
  const flags = () => ({ ...(x.length ? { x } : {}), ...(y.length ? { y } : {}), ...(z.length ? { z } : {}) });
  if (tool !== "claude") {
    // A Codex request's key (a forked rollout repeats its parent's) kept short: 12 hex digits of its hash.
    for (const r of tool === "codex" ? codexFileSpend(file, since) : geminiFileSpend(file, since)) {
      flag(k.length, r);
      k.push(r.key ? createHash("sha1").update(r.key).digest("hex").slice(0, 12) : "");
      d.push(r.usd);
    }
    return { k, d, ...flags() };
  }
  const reqs = claudeFileUsage(file, since);
  const at = new Map<string, number>();
  reqs.forEach((q, i) => {
    flag(i, { ...q, priced: q.rates !== undefined });
    k.push(keyOf(q.uuid));
    d.push(q.usd);
    if (q.id) at.set(q.id, i);
  });
  // The last replies, those from before the period too: a reply streamed
  // across midnight has its first row in yesterday, and its later rows,
  // appended after this read, must still be known as its own (they were
  // counted again as a new request).
  const last = new Map<string, [string, number, number, number]>();
  // Where the compactions stand at the end (claudeFileUsage counted those before it): an append goes on from here.
  const track = newTrack();
  for (const row of rowsOf<Record<string, any>>(file, USAGE_ROWS)) {
    trackCompaction(track, row);
    const m = row?.message;
    if (row?.type !== "assistant" || typeof m?.id !== "string") continue;
    const out = Number(m.usage?.output_tokens) > 0 ? Number(m.usage.output_tokens) : 0;
    const known = last.get(m.id);
    if (known) { known[2] = Math.max(known[2], out); continue; }
    const i = at.get(m.id) ?? -1;
    last.set(m.id, [m.id, i, out, (i >= 0 ? reqs[i].rates : requestCost(realModel(m.model), m.usage, Date.parse(String(row.timestamp ?? "")))?.rates)?.outputPerM ?? 0]);
    if (last.size > RECENT_REPLIES) last.delete(last.keys().next().value!);
  }
  const r = [...last.values()];
  const fd = openSync(file, "r");
  try {
    const o = lineStart(fd, size);
    return { k, d, o, a: anchorOf(fd, o), r: r.slice(-RECENT_REPLIES), c: track, ...flags() };
  } finally {
    closeSync(fd);
  }
}

/**
 * A Claude Code transcript that grew: the whole lines after `e.o`, each
 * reply counted as claudeFileUsage counts it (once, its output settled on
 * its later rows, priced with usageCost), into `e`. False, `e` untouched,
 * when what came before `e.o` is not what was read (rewritten in place), or
 * when the entry no longer keeps its last replies (`r`, dropped for a
 * finished subagent): then a later row of a reply would not be known as one.
 * Read in blocks, so a long transcript never needs one buffer of all of it.
 * `own`: count only the rows of this session, by their `sessionId`: a
 * session resumed or forked into a new one starts with a copy of the old
 * one's rows, which keep its id (seen on the author's machine), and were
 * counted as the new session's spend.
 */
function readAppended(e: FileEntry, file: string, since: number, own?: string): boolean {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const from = e.o ?? 0;
    if (e.a === undefined || e.r === undefined || size < from || anchorOf(fd, from) !== e.a) return false;
    const recent = e.r;
    let pos = from;
    let carry: Buffer = Buffer.alloc(0);
    while (pos < size) {
      const block = Buffer.alloc(Math.min(READ_BLOCK, size - pos));
      const n = readSync(fd, block, 0, block.length, pos);
      if (n <= 0) break;
      pos += n;
      const buf: Buffer = carry.length ? Buffer.concat([carry, block.subarray(0, n)]) : block.subarray(0, n);
      const end = buf.lastIndexOf(10);
      if (end < 0) { carry = buf; continue; }
      carry = buf.subarray(end + 1);
      countLines(e, recent, buf.subarray(0, end).toString("utf8"), since, own);
    }
    e.r = recent.slice(-RECENT_REPLIES);
    // After the last whole line: a half-written one is read next time.
    e.o = pos - carry.length;
    e.a = anchorOf(fd, e.o);
    return true;
  } finally {
    closeSync(fd);
  }
}

/** Lines read at a time by readAppended. */
const READ_BLOCK = 8 * 1024 * 1024;

/** Whole lines of a Claude Code transcript counted into `e` (readAppended). */
function countLines(e: FileEntry, recent: NonNullable<FileEntry["r"]>, text: string, since: number, own?: string): void {
  {
    for (const line of text.split("\n")) {
      // Only the last replies matter (a reply's rows are written together): a whole transcript read at once stays linear.
      if (recent.length > 2 * RECENT_REPLIES) recent.splice(0, recent.length - RECENT_REPLIES);
      const compaction = isCompactionRow(line);
      if (!compaction && !line.includes('"usage"')) continue;
      let row: Record<string, any>;
      try { row = JSON.parse(line); } catch { continue; }
      // A compaction's own request, estimated (compactcost.ts), as claudeFileUsage counts it.
      if (!isTrack(e.c)) e.c = newTrack();
      const done = trackCompaction(e.c, row);
      if (done && (Number.isFinite(done.ts) ? done.ts >= since : since <= 0) && !(own !== undefined && done.sessionId !== undefined && done.sessionId !== own)) {
        const index = e.k.length;
        if (done.cost.changedOn) (e.z ??= []).push([index, done.model, done.cost.changedOn]);
        else if (done.cost.estimated) (e.y ??= []).push([index, done.model]);
        e.k.push(keyOf(done.uuid));
        e.d.push(done.cost.totalUsd);
      }
      const m = row?.message;
      if (row?.type !== "assistant" || !m?.usage) continue;
      const u = m.usage as RecordedUsage;
      const out = Number(u.output_tokens) > 0 ? Number(u.output_tokens) : 0;
      const known = typeof m.id === "string" ? recent.find((x) => x[0] === m.id) : undefined;
      if (known) {
        // A later row of a reply already met: only output it settles on is new.
        if (out > known[2]) {
          if (known[1] >= 0) e.d[known[1]] += ((out - known[2]) * known[3]) / 1e6;
          known[2] = out;
        }
        continue;
      }
      const ts = Date.parse(String(row.timestamp ?? ""));
      const tokens = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].reduce((t: number, v) => t + (Number(v) > 0 ? Number(v) : 0), 0);
      const model = realModel(m.model);
      const c = requestCost(model, u, ts);
      let index = -1;
      // A reply on <synthetic> was made by Claude Code itself, never billed: not a request at all.
      // A row of another session (`own`): a copy of its history, its spend, not this session's.
      const copied = own !== undefined && typeof row.sessionId === "string" && row.sessionId !== own;
      // A row with no time of its own fits no period, but it is in the session's price (since 0), at today's rates (requestCost).
      if ((Number.isFinite(ts) ? ts >= since : since <= 0) && tokens > 0 && !isUnbilledModel(m.model) && !copied) {
        index = e.k.length;
        if (!c) (e.x ??= []).push([index, model ?? "unknown"]);
        else if (c.changedOn) (e.z ??= []).push([index, model ?? "unknown", c.changedOn]);
        else if (c.estimated) (e.y ??= []).push([index, model ?? "unknown"]);
        e.k.push(keyOf(typeof row.uuid === "string" ? row.uuid : undefined));
        e.d.push(c ? c.totalUsd : 0);
      }
      if (typeof m.id === "string") recent.push([m.id, index, out, c?.rates.outputPerM ?? 0]);
    }
  }
}

/** A ledger entry this version can use: a damaged one threw on every prompt until its transcript changed. */
export function wellFormed(e: FileEntry | undefined): e is FileEntry {
  return Boolean(e) && typeof e === "object" && Array.isArray(e!.k) && Array.isArray(e!.d) && e!.k.length === e!.d.length &&
    e!.k.every((x) => typeof x === "string") && e!.d.every((x) => typeof x === "number" && Number.isFinite(x)) &&
    (e!.a === undefined || typeof e!.a === "string") && (e!.x === undefined || (Array.isArray(e!.x) && e!.x.every((y) => Array.isArray(y) && typeof y[0] === "number"))) && (e!.y === undefined || (Array.isArray(e!.y) && e!.y.every((y) => Array.isArray(y) && typeof y[0] === "number"))) && (e!.r === undefined || (Array.isArray(e!.r) && e!.r.every((x) => Array.isArray(x) && x.length === 4))) &&
    (e!.z === undefined || (Array.isArray(e!.z) && e!.z.every((z) => Array.isArray(z) && typeof z[0] === "number" && typeof z[2] === "string")));
}

/**
 * One transcript's entry brought up to date: kept when the file is as last
 * read, read from where the last read stopped when a Claude Code transcript
 * only grew, read in full otherwise. `read`: the bytes read, -1 when the
 * entry was kept as it was. Undefined when the file cannot be read now.
 * `direct`: a Claude Code transcript met for the first time is read here,
 * not through the shared scan, which keeps a cache entry of it on disk (the
 * session price reads one session, and writes nothing while it has nothing
 * to say). `own`: a Claude Code transcript's rows of other sessions are not
 * counted (readAppended); only with `direct`, which reads every Claude Code
 * transcript itself.
 */
export function refreshEntry(tool: Tool, file: string, prev: FileEntry | undefined, since: number, direct = false, own?: string): { e: FileEntry; read: number } | undefined {
  let s;
  try { s = statSync(file); } catch { return undefined; }
  // An entry not in the shape this version writes (edited, or another version's), or priced at other
  // rates (the organization's, or another price table: an upgrade that corrected a price), or counted
  // otherwise (COUNTED: 2 adds each compaction's own request), is read again.
  const org = orgRates()?.key;
  const p = `${COUNTED}.${priceTableKey()}${org ? ` ${org}` : ""}`;
  const e = wellFormed(prev) && prev.p === p ? prev : undefined;
  if (e && e.t === tool && e.s === s.size && e.m === s.mtimeMs && e.i === s.ino) return { e, read: -1 };
  try {
    // Claude Code appends: a transcript that only grew is read from where the last read stopped.
    if (e && tool === "claude" && e.o !== undefined && e.i === s.ino && s.size >= e.s) {
      const from = e.o;
      if (readAppended(e, file, since, direct ? own : undefined)) return { e: { ...e, s: s.size, m: s.mtimeMs }, read: s.size - from };
    }
    if (direct && tool === "claude") {
      // From the start, as an append to nothing: the same counting, without the scan.
      const fd = openSync(file, "r");
      let a: string;
      try { a = anchorOf(fd, 0); } finally { closeSync(fd); }
      const blank: FileEntry = { t: tool, s: 0, m: 0, i: s.ino, k: [], d: [], o: 0, a, r: [], p };
      if (readAppended(blank, file, since, own)) return { e: { ...blank, s: s.size, m: s.mtimeMs }, read: s.size };
    }
    return { e: { t: tool, s: s.size, m: s.mtimeMs, i: s.ino, ...readFile(tool, file, since, s.size), p }, read: s.size };
  } catch {
    return undefined;
  }
}

export interface PeriodSpend {
  start: number; end: number; usd: number; byTool: Partial<Record<Tool, number>>;
  /** Requests on a model with no list price: counted here, not in `usd`. */
  unpriced?: { requests: number; models: string[] };
  /** Requests on a model priced only by its family: in `usd`, an estimate. */
  estimated?: { requests: number; usd: number; models: string[] };
  /** Requests priced past the day their model's price changed (model, day): in `usd`, an estimate. */
  changed?: { requests: number; usd: number; models: Array<[string, string]> };
}

/**
 * What the period holding `now` has cost so far, across Claude Code, Codex
 * and Gemini CLI. Re-reads only the transcripts that changed since the last
 * call (any process's), then writes the ledger back. `warn` (the hook's) is
 * the threshold reached, recorded as said, when it is one not said yet.
 */
export function periodSpend(period: Period, now = Date.now(), home = homedir(), warnAt?: (usd: number, warned: number) => number): PeriodSpend & { warn?: number; unpricedNew?: boolean } {
  const start = periodStart(period, now);
  const prev = readState();
  const fresh = !prev || prev.start !== start;
  const st: BudgetState = fresh ? { start, files: {}, warned: 0, usd: 0, byTool: {} } : prev;
  const walked = st.cx?.at;
  const files: Array<[Tool, string]> = [
    ...claudePeriodFiles(start).map((f) => ["claude", f] as [Tool, string]),
    ...codexPeriodFiles(st, start, now, home).map((f) => ["codex", f] as [Tool, string]),
    ...geminiFiles(start, home).map((f) => ["gemini", f] as [Tool, string]),
  ];
  let changed = fresh || st.cx?.at !== walked;
  const kept: Record<string, FileEntry> = {};
  for (const [tool, file] of files) {
    const r = refreshEntry(tool, file, st.files[file], start);
    if (!r) continue; // unreadable now: left out, read again next time
    kept[file] = r.e;
    if (r.read >= 0) changed = true;
  }
  if (Object.keys(st.files).some((f) => !(f in kept))) changed = true;
  // Each reply once: a fork's copy shares its key with the reply it copied.
  const seen = new Set<string>();
  let usd = 0;
  const byTool: Partial<Record<Tool, number>> = {};
  let unpriced = 0;
  const models = new Set<string>();
  const estimated = { requests: 0, usd: 0, models: new Set<string>() };
  const changedPrice = { requests: 0, usd: 0, models: new Map<string, [string, string]>() };
  for (const file of Object.keys(kept).sort()) {
    const e = kept[file];
    const x = new Map(e.x ?? []), y = new Map(e.y ?? []), z = new Map((e.z ?? []).map(([i, m, on]) => [i, [m, on] as [string, string]]));
    e.k.forEach((key, i) => {
      if (key) { if (seen.has(key)) return; seen.add(key); }
      usd += e.d[i];
      byTool[e.t] = (byTool[e.t] ?? 0) + e.d[i];
      if (x.has(i)) { unpriced++; models.add(x.get(i)!); }
      else if (y.has(i)) { estimated.requests++; estimated.usd += e.d[i]; estimated.models.add(y.get(i)!); }
      else if (z.has(i)) { const [m, on] = z.get(i)!; changedPrice.requests++; changedPrice.usd += e.d[i]; changedPrice.models.set(`${m}\u0000${on}`, [m, on]); }
    });
  }
  const level = warnAt ? warnAt(usd, st.warned) : 0;
  let warn = level > st.warned ? level : undefined;
  if (warn) {
    st.warned = warn;
    changed = true;
    // Said by exactly one of several prompts at once: the one that creates the threshold's marker.
    if (!claimSaid(start, warn)) warn = undefined;
  }
  if (fresh) clearSaid(start);
  // The hook (warnAt) says once a period that part of it has no price.
  const unpricedNew = Boolean(warnAt) && unpriced > 0 && !st.unpricedSaid;
  if (unpricedNew) { st.unpricedSaid = true; changed = true; }
  if (changed) saveState({ ...st, files: kept, usd, byTool });
  return { start, end: periodEnd(period, now), usd, byTool, ...(unpriced ? { unpriced: { requests: unpriced, models: [...models] } } : {}), ...(estimated.requests ? { estimated: { requests: estimated.requests, usd: estimated.usd, models: [...estimated.models] } } : {}), ...(changedPrice.requests ? { changed: { requests: changedPrice.requests, usd: changedPrice.usd, models: [...changedPrice.models.values()] } } : {}), ...(warn ? { warn } : {}), ...(unpricedNew ? { unpricedNew } : {}) };
}

// ---------------------------------------------------------------------------
// What the hook, the status line and `budget` say
// ---------------------------------------------------------------------------

/** "$12.30", "$1,234": dollars as the budget lines show them. */
const money = (n: number) => (n >= 1000 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);
/** "$50", "$7.50": the budget itself. */
const amount = (n: number) => (Number.isInteger(n) ? `$${n.toLocaleString("en-US")}` : `$${n.toFixed(2)}`);
const per = (p: Period) => (p === "day" ? "day" : "week");
const span = (p: Period) => (p === "day" ? "today" : "this week");

/** The thresholds the hook speaks at. */
export const THRESHOLDS = [50, 80, 100] as const;

/** The highest threshold `usd` has reached of `budget` (0 below the first). */
export function levelOf(usd: number, budget: number): number {
  const pct = (usd / budget) * 100;
  return [...THRESHOLDS].reverse().find((t) => pct >= t) ?? 0;
}

function byToolText(byTool: Partial<Record<Tool, number>>): string {
  const parts = (Object.keys(byTool) as Tool[]).filter((t) => (byTool[t] ?? 0) >= 0.005).sort((a, b) => byTool[b]! - byTool[a]!).map((t) => `${TOOL_NAME[t]} ${money(byTool[t]!)}`);
  return parts.length > 1 ? ` (${parts.join(", ")})` : "";
}

/** "3 requests on gpt-7 have no list price, so the budget does not count them." */
function unpricedText(u: NonNullable<PeriodSpend["unpriced"]>): string {
  const names = u.models.slice(0, 2).join(", ") + (u.models.length > 2 ? " and others" : "");
  return `${u.requests.toLocaleString("en-US")} request${u.requests === 1 ? " is" : "s are"} on ${names}, with no list price, so the budget does not count ${u.requests === 1 ? "it" : "them"}.`;
}

/** When the period resets, in words. */
function resets(p: Period): string {
  return p === "day" ? "It resets at midnight." : "It resets on Monday.";
}

/** A higher budget to suggest: half again, or a fifth over what was spent, rounded up to $5. */
function raised(b: Budget, spent: number): number {
  return Math.ceil(Math.max(b.usd * 1.5, spent * 1.2) / 5) * 5;
}

export interface BudgetVerdict {
  /** A line for the user, once per threshold per period. */
  message?: string;
  /** Over the budget with --block: why the prompt is held, and how to lift it. */
  block?: string;
  spend: PeriodSpend;
  budget: Budget;
}

/**
 * The hook's check: undefined with no budget set (one failed read: the hot
 * path stays a stat), otherwise the spend so far and what to say or do.
 */
export function budgetVerdict(now = Date.now(), home = homedir()): BudgetVerdict | undefined {
  const b = readBudget();
  if (!b) return undefined;
  const spend = periodSpend(b.period, now, home, (usd) => levelOf(usd, b.usd));
  const pct = Math.round((spend.usd / b.usd) * 100);
  const head = `context-doctor: ${money(spend.usd)} spent ${span(b.period)}`;
  if (b.block && spend.usd >= b.usd) {
    return {
      spend, budget: b,
      block: `${head}${byToolText(spend.byTool)}, over your ${amount(b.usd)}/${per(b.period)} budget, so this prompt was held. To go on, turn it off (context-doctor budget off) or raise it (context-doctor budget ${raised(b, spend.usd)}/${per(b.period)} --block). ${resets(b.period)}`,
    };
  }
  // Once a period: requests the budget cannot price, by name, so it is not read as all there is.
  const unpriced = spend.unpricedNew && spend.unpriced ? unpricedText(spend.unpriced) : undefined;
  if (!spend.warn) return unpriced ? { spend, budget: b, message: `context-doctor: ${unpriced}` } : { spend, budget: b };
  const message = spend.warn >= 100
    ? `${head}${byToolText(spend.byTool)}: over your ${amount(b.usd)}/${per(b.period)} budget (${pct}%). Raise it with context-doctor budget ${raised(b, spend.usd)}/${per(b.period)}, or add --block to hold prompts over it.`
    : `${head}${byToolText(spend.byTool)}: ${pct}% of your ${amount(b.usd)}/${per(b.period)} budget.`;
  return { spend, budget: b, message: unpriced ? `${message} ${unpriced}` : message };
}

/** The status line's part: "$12/$50 today", or undefined with no budget set. */
export function budgetStatus(now = Date.now(), home = homedir()): string | undefined {
  const b = readBudget();
  if (!b) return undefined;
  const s = periodSpend(b.period, now, home);
  const short = (n: number) => (n >= 10 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);
  return `${short(s.usd)}/${amount(b.usd)} ${span(b.period)}${s.usd >= b.usd ? " ⚠" : ""}`;
}

/** `budget` with no argument, and after setting one: the budget and where the period stands. */
export function renderBudgetStatus(b: Budget | undefined, s: PeriodSpend | undefined, hookInstalled: boolean): string {
  if (!b || !s) return "No spend budget set. Set one: context-doctor budget 50/day (or 200/week; --block to hold prompts over it).";
  const lines = [
    `Budget: ${amount(b.usd)} a ${per(b.period)}, across Claude Code, Codex and Gemini CLI${b.block ? "; prompts over it are held" : ""}.`,
    `${span(b.period) === "today" ? "Today" : "This week"}: ${money(s.usd)} so far, ${Math.round((s.usd / b.usd) * 100)}%${byToolText(s.byTool)}. ${resets(b.period)}`,
  ];
  const org = orgRatesLine();
  if (org) lines.push(org);
  if (s.unpriced) lines.push(`Not counted: ${unpricedText(s.unpriced)}`);
  if (s.estimated) {
    const one = s.estimated.models.length === 1;
    lines.push(`An estimate: ${money(s.estimated.usd)} of it is on ${s.estimated.models.slice(0, 2).join(", ")}${s.estimated.models.length > 2 ? " and others" : ""}, with no list price of ${one ? "its" : "their"} own, priced as ${one ? "its" : "their"} model's family.`);
  }
  if (s.changed) lines.push(`An estimate: ${money(s.changed.usd)} of it is priced past the day its model's price changed (${priceChangedText(s.changed.models)}).`);
  lines.push(hookInstalled
    ? `The every-prompt hook says so at ${THRESHOLDS.join("%, ").replace(/, (\d+)$/, " and $1")}%${b.block ? ", and holds prompts over it" : ""}. Cursor is not counted (context-doctor spend shows it).`
    : "No every-prompt hook is installed, so nothing will say so: run context-doctor install.");
  lines.push(`Off: context-doctor budget off`);
  return lines.join("\n");
}

/** Our every-prompt hook in Claude Code, Codex or Gemini CLI, or the plugin's. */
export function promptHookInstalled(home = homedir()): boolean {
  const has = (path: string, pick: (j: any) => unknown) => {
    try { return JSON.stringify(pick(JSON.parse(readFileSync(path, "utf8"))) ?? "").includes("context-doctor"); } catch { return false; }
  };
  return has(join(claudeDir(), "settings.json"), (j) => [j?.hooks?.UserPromptSubmit, j?.enabledPlugins]) ||
    has(join(codexDir(home), "hooks.json"), (j) => j?.hooks?.UserPromptSubmit) ||
    has(join(home, ".gemini", "settings.json"), (j) => j?.hooks?.BeforeAgent);
}
