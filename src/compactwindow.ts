/**
 * `context-doctor compact-window`: compact earlier, automatically, in every
 * Claude Code surface, including the desktop app.
 *
 * Claude Code auto-compacts near the model's window. With a 1M-token window
 * that is ~970k (measured: 31 compactions on the author's machine, median
 * preTokens 970,119), so long sessions spend most of their life re-reading
 * 400k-900k tokens on every message. Claude Code has a native setting for
 * this, `autoCompactWindow` in ~/.claude/settings.json ("Auto-compact window
 * size"): it compacts as if the window were that size. It is a settings key,
 * not an environment variable, so the desktop app (which filters settings env
 * it sets itself) honours it, and no proxy or hook is involved.
 *
 * The trade-off is real: more compactions, each replacing history with a
 * summary. So this measures both sides on the user's own history and changes
 * nothing until asked. The replay uses the usage every transcript records;
 * its baseline came within 9% of the billed figure on the author's history
 * (on the low side, so savings are, if anything, understated).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { forEachLine, listSessions } from "./session.js";
import { pricingFor } from "./pricing.js";
import { readJson, writeJsonWithBackup } from "./install.js";

/** Claude Code compacts at about this share of the window (970k of 1M, measured). */
const TRIGGER_SHARE = 0.97;
/** Context right after a compaction: system prompt, tools and the summary (median 75,447, measured). */
const AFTER_COMPACT = 75_000;
/** Output tokens a compaction summary costs, priced at output's 5x input rate. */
const SUMMARY_OUTPUT = 20_000;
const OUTPUT_RATIO = 5;
const TTL_MS = 3_600_000;

export const MIN_WINDOW = 100_000;
export const MAX_WINDOW = 1_000_000;

export interface WindowEstimate {
  window: number;
  baselineUsd: number;
  withWindowUsd: number;
  savedUsd: number;
  savedPct: number;
  /** Compactions there would be over the period with this window. */
  compactions: number;
}

export interface CompactWindowReport {
  days: number;
  sessions: number;
  /** Compactions that actually happened over the period (Claude Code's own, or /compact). */
  actualCompactions: number;
  estimates: WindowEstimate[];
}

type Req = { at: number; prompt: number } | "compact";

function readRequests(path: string): { model?: string; reqs: Req[] } {
  const reqs: Req[] = [];
  let lastId: string | undefined, model: string | undefined;
  forEachLine(path, (line) => {
    let e: any;
    try { e = JSON.parse(line); } catch { return; }
    if (!e || e.isSidechain) return;
    if (e.type === "system" && e.subtype === "compact_boundary") { reqs.push("compact"); return; }
    if (e.type !== "assistant" || !e.message || e.message.id === lastId) return;
    lastId = e.message.id;
    const u = e.message.usage ?? {};
    const prompt = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const at = Date.parse(e.timestamp);
    if (prompt > 0 && Number.isFinite(at)) { reqs.push({ at, prompt }); model ??= e.message.model; }
  });
  return { model, reqs };
}

/**
 * Replay one session twice: as it ran, and with compaction whenever the
 * context reaches the window's trigger. Both arms are priced as the prompt
 * cache bills (warm: 0.1x re-read + 1.25x for what is new; cold after an hour
 * idle: 1.25x for everything); each simulated compaction also pays its own
 * request and summary.
 */
function replay(reqs: Req[], window: number, since: number): { base: number; sim: number; extra: number; actual: number } {
  let base = 0, sim = 0, extra = 0, actual = 0;
  let removed = 0, prevActual: number | undefined, prevSim: number | undefined, prevAt: number | undefined;
  for (const r of reqs) {
    if (r === "compact") {
      if (prevAt !== undefined && prevAt >= since) actual++;
      // A real compaction in the transcript: the simulated arm compacts there too.
      if (prevAt !== undefined && prevAt >= since && removed === 0) extra++;
      removed = 0; prevActual = prevSim = undefined; continue;
    }
    const counted = r.at >= since;
    const cold = prevAt === undefined || r.at - prevAt > TTL_MS;
    const cost = (ctx: number, prev: number | undefined) => {
      if (cold) return 1.25 * ctx;
      const fresh = prev === undefined || ctx < prev ? ctx : ctx - prev;
      return 0.1 * (ctx - fresh) + 1.25 * fresh;
    };
    if (counted) base += cost(r.prompt, prevActual);
    let ctx = r.prompt - removed;
    // The real context fell below what we had removed (a rewind with no
    // compaction marker): the two arms are back in step.
    if (ctx < AFTER_COMPACT && removed > 0) { removed = 0; ctx = r.prompt; }
    let simPrev = prevSim;
    if (ctx >= TRIGGER_SHARE * window) {
      if (counted) { sim += 0.1 * ctx + OUTPUT_RATIO * SUMMARY_OUTPUT; extra++; }
      removed = r.prompt - AFTER_COMPACT;
      ctx = AFTER_COMPACT;
      simPrev = undefined; // everything after a compaction is new to the cache
    }
    if (counted) sim += cost(ctx, simPrev);
    prevActual = r.prompt;
    prevSim = ctx;
    prevAt = r.at;
  }
  return { base, sim, extra, actual };
}

export function estimateCompactWindows(windows: number[], days = 30, paths?: string[]): CompactWindowReport {
  const since = Date.now() - days * 86_400_000;
  const targets = paths ?? listSessions(10_000).filter((s) => s.path.includes(".claude") && s.modifiedAt.getTime() >= since).map((s) => s.path);
  const acc = windows.map((w) => ({ window: w, base: 0, sim: 0, extra: 0 }));
  let sessions = 0, actualCompactions = 0;
  for (const p of targets) {
    let parsed: ReturnType<typeof readRequests>;
    try { parsed = readRequests(p); } catch { continue; }
    const perM = pricingFor(parsed.model)?.inputPerM;
    if (!perM || parsed.reqs.filter((r) => r !== "compact" && r.at >= since).length < 10) continue;
    sessions++;
    actualCompactions += replay(parsed.reqs, Number.MAX_SAFE_INTEGER, since).actual;
    for (const a of acc) {
      const r = replay(parsed.reqs, a.window, since);
      a.base += (r.base * perM) / 1e6;
      a.sim += (r.sim * perM) / 1e6;
      a.extra += r.extra;
    }
  }
  return {
    days,
    sessions,
    actualCompactions,
    estimates: acc.map((a) => ({
      window: a.window,
      baselineUsd: a.base,
      withWindowUsd: a.sim,
      savedUsd: a.base - a.sim,
      savedPct: a.base > 0 ? (a.base - a.sim) / a.base : 0,
      compactions: a.extra,
    })),
  };
}

export function settingsPath(home = homedir()): string {
  return join(home, ".claude", "settings.json");
}

/** The autoCompactWindow Claude Code will use from user settings, if set. */
export function currentCompactWindow(home = homedir()): number | undefined {
  const p = settingsPath(home);
  if (!existsSync(p)) return undefined;
  try {
    const v = JSON.parse(readFileSync(p, "utf8"))?.autoCompactWindow;
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Set (or with undefined, remove) autoCompactWindow in ~/.claude/settings.json. A .backup is kept. */
export function setCompactWindow(window: number | undefined, home = homedir()): void {
  if (window !== undefined && (!Number.isInteger(window) || window < MIN_WINDOW || window > MAX_WINDOW)) {
    throw new Error(`window must be a whole number of tokens between ${MIN_WINDOW} and ${MAX_WINDOW}`);
  }
  const p = settingsPath(home);
  const settings = readJson(p);
  if (window === undefined) delete settings.autoCompactWindow;
  else settings.autoCompactWindow = window;
  writeJsonWithBackup(p, settings);
}

/** "400k" / "400000" / "0.4m" -> 400000. Undefined when unparseable. */
export function parseWindow(raw: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(raw);
  if (!m) return undefined;
  const n = Number(m[1]) * (m[2].toLowerCase() === "m" ? 1e6 : m[2].toLowerCase() === "k" ? 1e3 : 1);
  return Math.round(n);
}

const usd = (n: number) => (Math.abs(n) >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);
const k = (n: number) => `${Math.round(n / 1000)}k`;

export function renderCompactWindows(r: CompactWindowReport, current?: number): string {
  const lines: string[] = [];
  lines.push("Auto-compact window: compact earlier, automatically (Claude Code's own setting)");
  lines.push(`Your last ${r.days} days, ${r.sessions} Claude Code session${r.sessions === 1 ? "" : "s"}, priced at list prices`);
  lines.push("─".repeat(66));
  if (r.sessions === 0) {
    lines.push("No sessions with 10+ requests in the window to replay.");
    return lines.join("\n");
  }
  lines.push(`Now: ${current ? `${k(current)} (set in ~/.claude/settings.json)` : "not set: Claude Code compacts near the model's full window"}`);
  lines.push("");
  lines.push("  window   input cost   saved            compactions");
  for (const e of r.estimates) {
    const mark = current === e.window ? "  ← current" : "";
    lines.push(`  ${k(e.window).padStart(6)}   ${usd(e.withWindowUsd).padStart(10)}   ${(usd(e.savedUsd) + ` (${Math.round(e.savedPct * 100)}%)`).padEnd(16)} ${String(e.compactions).padStart(4)} (${((e.compactions / r.days) * 7).toFixed(1)}/week)${mark}`);
  }
  lines.push(`  as now   ${usd(r.estimates[0]?.baselineUsd ?? 0).padStart(10)}                    ${String(r.actualCompactions).padStart(4)} (${((r.actualCompactions / r.days) * 7).toFixed(1)}/week)`);
  lines.push("");
  lines.push("Each compaction replaces the session's history with a summary, so a smaller");
  lines.push("window trades detail for cost. Set one with:  context-doctor compact-window 400k");
  lines.push("Undo with:  context-doctor compact-window off");
  return lines.join("\n");
}
