/**
 * `context-doctor savings`: what autopilot would have saved on YOUR recent
 * Claude Code sessions, measured, not modelled.
 *
 * Each session is replayed request by request, twice: as it was sent, and as
 * autopilot (autoclear.ts, the shipped class) would have sent it. Both arms
 * are priced the way the prompt cache bills (reads at the model's cache-read
 * rate, writes at the session's own 5-minute/1-hour TTL mix, a cold cache
 * after an idle gap longer than the request's own TTL). The difference
 * between the arms is the saving. The baseline shown to the user is not an
 * estimate: it is the input the sessions were actually billed for, read from
 * the usage every transcript records, each request at its own model's price.
 */

import { basename, dirname } from "node:path";
import { AutoClearer, type AutoClearOptions } from "./autoclear.js";
import { coldResumeEvents } from "./coldresume.js";
import { listSessions, replyCounter, isClaudeSession } from "./session.js";
import { rowsOf, type Extractor } from "./scan.js";
import { CACHE_WRITE_1H, CACHE_WRITE_5M, cacheWriteSplit, pricingFor, usageCost, writeMultiplier, type ModelPricing } from "./pricing.js";
import { estimateTokens, formatTokens, realModel } from "./tokens.js";
import { withInvocation } from "./invocation.js";
import { sessionsLabel } from "./compactwindow.js";

/** System prompt and tool schemas: sent on every request, identical in both arms. */
const FIXED_TOKENS = 54_000;
const CLAUDE_CODE_TTL_MS = 3_600_000;

export interface SessionSavings {
  path: string;
  project: string;
  model?: string;
  requests: number;
  /**
   * Cache-weighted input actually billed (usage in the transcript), in
   * base-input-token units: reads at 0.1x, writes at 1.25x (5-minute TTL)
   * or 2x (1-hour TTL) as each request recorded them.
   */
  billedWeighted: number;
  billedUsd: number;
  /** Replay difference, in the same units. */
  savedWeighted: number;
  savedUsd: number;
  /** Raw input tokens autopilot would not have sent. */
  savedTokens: number;
  savedPct: number;
  /** Claude Code surface that ran the session ("cli", "claude-vscode", "claude-desktop", ...). */
  entrypoint?: string;
  /** Can a settings-file ANTHROPIC_BASE_URL route this surface through autopilot? */
  autopilotReachable: boolean;
  /** Returns to this session after the cache expired, and what /compact then would have saved. */
  coldResumes: number;
  coldResumeNetUsd: number;
}

/**
 * The desktop app runs Claude Code "host-orchestrated": it sets
 * ANTHROPIC_BASE_URL itself and drops the same key from settings files, so
 * the autopilot proxy cannot sit in front of it (checked in Claude Code
 * 2.1.284). Terminal and IDE sessions read settings normally.
 */
export function autopilotReaches(entrypoint?: string): boolean {
  return !(entrypoint ?? "").startsWith("claude-desktop");
}

export interface SavingsReport {
  days: number;
  /** Sessions with 10+ requests in the period: the ones replayed and counted. */
  sessions: SessionSavings[];
  /** Claude Code transcripts written in the period, replayed or not (the progress line's total). */
  transcripts: number;
  billedUsd: number;
  savedUsd: number;
  savedTokens: number;
  billedTokens: number;
  savedPct: number;
  worse: number;
  /** Autopilot's share in sessions it can actually reach. */
  reachableUsd: number;
  unreachableSessions: number;
  coldResumes: number;
  coldResumeNetUsd: number;
}

type Msg = { role: string; content: Array<Record<string, unknown>> };

/** Without a price on file the arms still need relative weights: Claude's usual 10% read rate. */
const UNPRICED: ModelPricing = { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1 };

/** What an arm needs from a clearer: autopilot's AutoClearer, or the simulated server-side rule (serverclear.ts). */
export interface ReplayClearer { apply(body: Record<string, unknown>, now: number): { firstChanged: number } }

/**
 * One arm of the replay: the history as sent, each request's prompt split
 * into what the cache would serve and what is written. `settleReplay` prices
 * them at each request's own model, writes at the session's TTL mix, known
 * once the whole transcript has been read.
 */
function arm(model: string | undefined, clearer: ReplayClearer | null) {
  const msgs: Msg[] = [];
  const tok: number[] = [];
  let total = 0, prevLen = 0;
  const size = (m: Msg) => estimateTokens(JSON.stringify(m), model);
  return {
    push(m: Msg) { msgs.push(structuredClone(m)); const k = size(m); tok.push(k); total += k; },
    extend(blocks: Array<Record<string, unknown>>) {
      const i = msgs.length - 1;
      msgs[i].content.push(...structuredClone(blocks));
      total -= tok[i]; tok[i] = size(msgs[i]); total += tok[i];
    },
    /** One request: what the cache would have served (read), what is written, and the whole prompt. */
    request(now: number, cold: boolean): ArmRequest | undefined {
      let first = -1;
      if (clearer) {
        const body = { model, messages: msgs, system: [{ type: "text", text: "", cache_control: { type: "ephemeral", ttl: "1h" } }] };
        first = clearer.apply(body as unknown as Record<string, unknown>, now).firstChanged;
      }
      if (first >= 0) for (let i = first; i < msgs.length; i++) { total -= tok[i]; tok[i] = size(msgs[i]); total += tok[i]; }
      const k = cold ? 0 : Math.min(prevLen, first >= 0 ? first : prevLen);
      let read = 0;
      for (let i = 0; i < k; i++) read += tok[i];
      prevLen = msgs.length;
      return { read, write: total - read, total };
    },
  };
}

/**
 * A transcript, replayed once into the records the report prices: per
 * request its time, uuid, model and recorded bill, and what each arm read
 * and wrote; the compactions; the uuids of replies with no usage. What
 * depends on the period or on other transcripts (which requests count, a
 * fork's copied history) is settled afterwards, by `settleReplay`, so the
 * records can be kept and the replay (most of the time `savings` takes)
 * runs once per transcript, not once per run.
 */
type ReplayRow =
  | { k: "r"; now: number; uuid?: string; pm?: string; bw: number; usd: number; raw: number; cold: boolean; b?: number[]; a?: number[] }
  | { k: "s"; uuid?: string }
  | { k: "c" }
  | { k: "end"; model?: string; entrypoint?: string; w5: number; w1: number };

/** One arm's request, as the arm left it: tokens read from the cache, written, and the total sent. */
type ArmRequest = { read: number; write: number; total: number };

function replayExtractor(id: string, options: AutoClearOptions, makeClearer: (model?: string) => ReplayClearer, replay: boolean): Extractor<any> {
  return {
    id,
    resumable: false,
    init() {
      const st = {
        model: undefined as string | undefined,
        entrypoint: undefined as string | undefined,
        lastId: undefined as string | undefined,
        lastTs: null as number | null,
        writes5m: 0,
        writes1h: 0,
        sighting: replyCounter(),
        base: undefined as ReturnType<typeof arm> | undefined,
        auto: undefined as ReturnType<typeof arm> | undefined,
      };
      st.base = armOf(undefined, null);
      st.auto = armOf(undefined, replay ? makeClearer() : null);
      return st;
    },
    line(_raw, row, out, st) {
      let e: any;
      try { e = row(); } catch { return; }
      if (!e || e.isSidechain) return;
      if (!st.entrypoint && typeof e.entrypoint === "string") st.entrypoint = e.entrypoint;
      if (e.type === "system" && e.subtype === "compact_boundary") {
        // Compaction replaces the history in both arms alike: start fresh.
        out.push({ k: "c" });
        st.base = armOf(st.model, null);
        st.auto = armOf(st.model, replay ? makeClearer(st.model) : null);
        return;
      }
      if (e.type === "assistant" && e.message) {
        const m = e.message;
        // "<synthetic>" placeholders are not a model: a session that opened
        // with one was priced at nothing.
        st.model = st.model ?? realModel(m.model);
        const blocks = (Array.isArray(m.content) ? m.content : []).filter((b: any) => b?.type !== "thinking" && b?.type !== "redacted_thinking");
        if (m.id !== st.lastId) {
          st.lastId = m.id;
          const u = m.usage ?? {};
          const read = u.cache_read_input_tokens ?? 0, write = u.cache_creation_input_tokens ?? 0, fresh = u.input_tokens ?? 0;
          const seen = st.sighting(e);
          const uuid = typeof e.uuid === "string" ? e.uuid : undefined;
          if (seen !== "repeat" && read + write + fresh > 0) {
            const now = Date.parse(e.timestamp) || 0;
            // Each request at its own model: a session that switched from a
            // $4 to a $10 model was priced at the first one throughout.
            const pm = realModel(m.model) ?? st.model;
            const price = pricingFor(pm);
            const ttl = cacheWriteSplit(u);
            st.writes5m += ttl.fiveMinute;
            st.writes1h += ttl.oneHour;
            const cold = st.lastTs === null || now - st.lastTs > CLAUDE_CODE_TTL_MS;
            const r: ReplayRow = {
              k: "r", now, cold,
              bw: fresh + read * 0.1 + ttl.fiveMinute * CACHE_WRITE_5M + ttl.oneHour * CACHE_WRITE_1H,
              usd: price ? usageCost(u, price).promptUsd : 0,
              raw: fresh + read + write,
            };
            // Only what is set: a record read back from the cache must equal this one.
            if (uuid !== undefined) r.uuid = uuid;
            if (pm !== undefined) r.pm = pm;
            const b = st.base!.request(now, cold), a = st.auto!.request(now, cold);
            if (b && a) Object.assign(r, { b: [b.read, b.write, b.total], a: [a.read, a.write, a.total] });
            out.push(r);
            st.lastTs = now;
          } else if (seen !== "repeat") {
            out.push(uuid === undefined ? { k: "s" } : { k: "s", uuid });
          }
          st.base!.push({ role: "assistant", content: blocks });
          st.auto!.push({ role: "assistant", content: blocks });
        } else {
          st.base!.extend(blocks);
          st.auto!.extend(blocks);
        }
      } else if (e.type === "user" && e.message) {
        const c = e.message.content;
        const msg: Msg = { role: "user", content: Array.isArray(c) ? c : [{ type: "text", text: String(c ?? "") }] };
        st.base!.push(msg);
        st.auto!.push(msg);
      }
    },
    end(out, st) {
      out.push({ k: "end", ...(st.model !== undefined ? { model: st.model } : {}), ...(st.entrypoint !== undefined ? { entrypoint: st.entrypoint } : {}), w5: st.writes5m, w1: st.writes1h });
    },
  };

  // Without the replay (autopilot already on: `fix` needs only the bill and
  // the cold returns) the arms do nothing, which is most of the time spent.
  function armOf(m: string | undefined, c: ReplayClearer | null): ReturnType<typeof arm> {
    return replay ? arm(m, c) : { push() {}, extend() {}, request: () => undefined };
  }
}

const REPLAY = replayExtractor("replay.1", {}, () => new AutoClearer({}), true);
const BILL = replayExtractor("bill.1", {}, () => new AutoClearer({}), false);
/** What `estimateSavings` reads from each transcript, with or without autopilot's replay (for `prescan`). */
export const savingsRows = (replay = true): Extractor<any> => (replay ? REPLAY : BILL);

/**
 * Replay one Claude Code transcript. Undefined when it holds too few requests
 * to mean anything. `runRows` is shared by every transcript of one report: a
 * forked session starts as a copy of its parent's history, which replays
 * here (it shapes the context) but was billed once, under the parent.
 * `coldRows` does the same for the cold-resume count, which reads the
 * transcript again after the replay has added its rows to `runRows`.
 */
export function replaySession(path: string, options: AutoClearOptions = {}, since = 0, runRows?: Set<string>, coldRows?: Set<string>, makeClearer?: (model?: string) => ReplayClearer, replay = true): SessionSavings | undefined {
  // The default replay is kept between runs; another clearer or options are replayed afresh.
  const custom = makeClearer !== undefined || Object.keys(options).length > 0;
  const ex = custom ? replayExtractor(`replay.custom`, options, makeClearer ?? (() => new AutoClearer(options)), replay) : replay ? REPLAY : BILL;
  return settleReplay(path, custom ? rowsOf<ReplayRow>(path, ex, { keep: false }) : rowsOf<ReplayRow>(path, ex), since, runRows, coldRows, replay);
}

/** The report's figures for one transcript from its replay records: the period and the forks applied. */
function settleReplay(path: string, rows: ReplayRow[], since: number, runRows: Set<string> | undefined, coldRows: Set<string> | undefined, replay: boolean): SessionSavings | undefined {
  // A reply first met in an earlier transcript (a fork's copy) is a copy here.
  const sighting = (uuid: string | undefined): "new" | "copy" => {
    if (!runRows || uuid === undefined) return "new";
    if (runRows.has(uuid)) return "copy";
    runRows.add(uuid);
    return "new";
  };
  const fresh = () => ({ readUsd: 0, writeAtInput: 0, raw: 0 });
  let base = fresh(), auto = fresh();
  let baseUsd = 0, autoUsd = 0, baseRaw = 0, autoRaw = 0;
  let billed = 0, billedUsd = 0, billedRaw = 0, requests = 0;
  let end: Extract<ReplayRow, { k: "end" }> | undefined;
  // Arms are closed out at each compaction and at the end, priced at the
  // session's write mix (known by the end, so the closed arms wait for it).
  const closed: Array<ReturnType<typeof fresh>> = [];
  const flush = () => { closed.push(base, auto); baseRaw += base.raw; autoRaw += auto.raw; };
  const charge = (acc: ReturnType<typeof fresh>, r: number[] | undefined, cold: boolean, price: ModelPricing) => {
    if (!replay || !r) return;
    const [read, write, total] = r;
    acc.readUsd += ((cold ? 0 : FIXED_TOKENS) + read) * price.cacheReadPerM;
    acc.writeAtInput += ((cold ? FIXED_TOKENS : 0) + write) * price.inputPerM;
    acc.raw += FIXED_TOKENS + total;
  };
  for (const r of rows) {
    if (r.k === "s") sighting(r.uuid);
    else if (r.k === "c") { flush(); base = fresh(); auto = fresh(); }
    else if (r.k === "end") end = r;
    else {
      // History before the window, or already billed under the session it
      // was forked from, still shapes the replay's state; only the rest is
      // billed and counted.
      const seen = sighting(r.uuid);
      const inWindow = r.now >= since && seen === "new";
      if (!inWindow) continue;
      billed += r.bw;
      billedUsd += r.usd;
      billedRaw += r.raw;
      requests++;
      const price = pricingFor(r.pm) ?? UNPRICED;
      charge(base, r.b, r.cold, price);
      charge(auto, r.a, r.cold, price);
    }
  }
  flush();
  if (requests < 10 || billed <= 0) return undefined;

  // The replay decides the SHARE saved (both arms priced the same way); that
  // share is applied to what was actually billed, so the dollars and tokens
  // shown are fractions of the user's real usage, not of an estimate. The
  // arms write at this session's own TTL mix: the replay charges writes that
  // never happened (a cold re-read after clearing), and Claude Code would
  // have written those at the TTL it wrote everything else at.
  const mix = writeMultiplier(end?.w5 ?? 0, end?.w1 ?? 0);
  const usd = (a: ReturnType<typeof fresh>) => (a.readUsd + a.writeAtInput * mix) / 1e6;
  for (let i = 0; i < closed.length; i += 2) { baseUsd += usd(closed[i]); autoUsd += usd(closed[i + 1]); }
  const cold = coldResumeEvents(path, undefined, undefined, coldRows).filter((c) => c.at >= since);
  const pct = baseUsd > 0 ? (baseUsd - autoUsd) / baseUsd : 0;
  const rawPct = baseRaw > 0 ? (baseRaw - autoRaw) / baseRaw : 0;
  const dir = basename(dirname(path));
  const entrypoint = end?.entrypoint;
  return {
    path,
    project: dir.replace(/^-Users-[^-]+-/, "").replace(/^-/, "") || dir,
    model: end?.model,
    requests,
    billedWeighted: billed,
    billedUsd,
    savedWeighted: pct * billed,
    savedUsd: pct * billedUsd,
    savedTokens: rawPct * billedRaw,
    savedPct: pct,
    entrypoint,
    autopilotReachable: autopilotReaches(entrypoint),
    coldResumes: cold.length,
    coldResumeNetUsd: cold.reduce((n, c) => n + c.netUsd, 0),
  };
}

export function estimateSavings(days = 30, options: AutoClearOptions = {}, paths?: string[], onProgress?: (done: number, total: number) => void, replay = true): SavingsReport {
  const since = Date.now() - days * 86_400_000;
  const targets = paths ?? listSessions(10_000).filter((s) => isClaudeSession(s) && s.modifiedAt.getTime() >= since).map((s) => s.path);
  const sessions: SessionSavings[] = [];
  const runRows = new Set<string>(), coldRows = new Set<string>();
  for (const [i, p] of targets.entries()) {
    onProgress?.(i, targets.length);
    try {
      const s = replaySession(p, options, since, runRows, coldRows, undefined, replay);
      if (s) sessions.push(s);
    } catch {
      /* one unreadable transcript must not sink the report */
    }
  }
  const sum = (k: keyof SessionSavings) => sessions.reduce((n, s) => n + (s[k] as number), 0);
  const billedUsd = sum("billedUsd"), savedUsd = sum("savedUsd");
  const billedW = sum("billedWeighted");
  // The share printed beside a dollar figure is a share of dollars. With each
  // request priced at its own model, token-weighted and dollar shares differ
  // (author's 133 days: 11.4% of weighted tokens, 12.7% of dollars); tokens
  // only when nothing could be priced.
  const savedPct = billedUsd > 0 ? savedUsd / billedUsd : billedW > 0 ? sum("savedWeighted") / billedW : 0;
  onProgress?.(targets.length, targets.length);
  return {
    days,
    sessions: sessions.sort((a, b) => b.savedUsd - a.savedUsd),
    transcripts: targets.length,
    billedUsd,
    savedUsd,
    savedTokens: sum("savedTokens"),
    billedTokens: sessions.reduce((n, s) => n + s.billedWeighted, 0),
    savedPct,
    worse: sessions.filter((s) => s.savedPct < -1e-9).length,
    reachableUsd: sessions.filter((s) => s.autopilotReachable).reduce((n, s) => n + s.savedUsd, 0),
    unreachableSessions: sessions.filter((s) => !s.autopilotReachable).length,
    coldResumes: sum("coldResumes"),
    coldResumeNetUsd: sum("coldResumeNetUsd"),
  };
}

const tokens = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : formatTokens(n));
const usd = (n: number) => (n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);

/** Optional third lever, computed by compactwindow.ts and passed in by the CLI. */
export interface CompactWindowLine {
  window: number;
  savedUsd: number;
  compactionsPerWeek: number;
  nowPerWeek: number;
  isCurrent: boolean;
}

export function renderSavings(r: SavingsReport, autopilotOn = false, cw?: CompactWindowLine, missLines?: string[], limitLines?: string[], lensLines?: string[]): string {
  const lines: string[] = [];
  if (r.sessions.length === 0) {
    lines.push(`No Claude Code sessions with 10+ requests in the last ${r.days} days to replay.`);
    lines.push("Use Claude Code for a while, then run this again: `context-doctor savings`.");
    return withInvocation(lines.join("\n"));
  }
  const n = r.sessions.length;
  const allDesktop = r.unreachableSessions === n;
  const pct = (x: number) => (r.billedUsd > 0 ? ` (${Math.round((x / r.billedUsd) * 100)}%)` : "");
  // Kept within 80 columns: this is most people's first screen of the tool.
  lines.push("What context-doctor finds in your Claude Code sessions");
  // The same count, said the same way, as compact-window's.
  lines.push(`Last ${r.days} days, ${sessionsLabel(n, r.transcripts ?? n)}, at list prices`);
  lines.push("─".repeat(60));
  lines.push(`Input you were billed for         ${usd(r.billedUsd).padStart(9)}   from your transcripts' usage`);
  lines.push("");
  lines.push(`1. Compact when you come back     ${usd(Math.max(0, r.coldResumeNetUsd)).padStart(9)}${pct(Math.max(0, r.coldResumeNetUsd))}`);
  lines.push(`   ${r.coldResumes} return${r.coldResumes === 1 ? "" : "s"} to a session over 150k tokens after the prompt cache`);
  lines.push("   expired. Running /compact then, net of the compaction itself, would");
  lines.push("   have saved this. The every-prompt hook points these moments out, in");
  lines.push("   every Claude Code surface, the desktop app included.");
  lines.push("");
  if (allDesktop) {
    lines.push(`2. Autopilot                      ${"n/a".padStart(9)}`);
    lines.push(`   All ${n} sessions ran in the desktop app, which sets its own API`);
    lines.push("   address, so the autopilot proxy cannot sit in front of them. In a");
    lines.push(`   terminal or an IDE they would have saved ${usd(r.savedUsd)} (${(r.savedPct * 100).toFixed(1)}%).`);
  } else {
    lines.push(`2. Autopilot                      ${usd(r.reachableUsd).padStart(9)}${pct(r.reachableUsd)}`);
    lines.push("   Stale tool output cleared only when the cache is cold, so it never");
    lines.push(`   costs more (${r.worse} session${r.worse === 1 ? "" : "s"} made more expensive); ${tokens(r.savedTokens)} tokens not sent.`);
    if (r.unreachableSessions > 0) lines.push(`   Terminal and IDE sessions only; ${r.unreachableSessions} desktop-app session${r.unreachableSessions === 1 ? "" : "s"} not reachable.`);
    if (!autopilotOn) lines.push("   Turn it on:  context-doctor autopilot on");
  }
  if (cw) {
    lines.push("");
    lines.push(`${`3. Compact earlier (${Math.round(cw.window / 1000)}k window)`.padEnd(34)}${usd(Math.max(0, cw.savedUsd)).padStart(9)}${pct(Math.max(0, cw.savedUsd))}`);
    lines.push(`   Claude Code's own auto-compact window${cw.isCurrent ? ", as you have it set" : ""}: automatic in every surface,`);
    lines.push(`   ${cw.compactionsPerWeek.toFixed(1)} compactions a week instead of ${cw.nowPerWeek.toFixed(1)}. Each keeps a summary, not the`);
    lines.push("   full history. Compare sizes: context-doctor compact-window");
    if (!cw.isCurrent) lines.push(`   Set it with: context-doctor compact-window ${Math.round(cw.window / 1000)}k`);
  }
  if (limitLines?.length) {
    // Only when a fit on the user's own limit readings is good enough (limits.ts).
    lines.push("");
    lines.push(...limitLines);
  }
  if (lensLines?.length) {
    // Shown, not claimed: whether shorter output keeps quality is for `ab`.
    lines.push("");
    lines.push(...lensLines);
  }
  if (missLines?.length) {
    // Not a lever of ours: money the cache lost on its own, said once, with where to look.
    lines.push("");
    lines.push(...missLines);
  }
  lines.push("");
  lines.push("Replayed request by request through the shipped code and priced as the");
  lines.push("prompt cache bills. On a subscription the same tokens come out of your");
  lines.push("usage limit instead. Share yours: context-doctor savings --share");
  // Hints as the user can type them: `npx context-doctor …` after an npx run.
  return withInvocation(lines.join("\n"));
}

/**
 * `savings --share`: a few lines people can paste or screenshot. Totals only:
 * no project names, paths or session ids, so sharing it leaks nothing.
 */
export function renderShare(r: SavingsReport): string {
  if (r.sessions.length === 0) return "context-doctor found no Claude Code sessions to measure yet.";
  const lines = [
    `My Claude Code input, last ${r.days} days: ${usd(r.billedUsd)} at list price (${r.sessions.length} sessions).`,
  ];
  if (r.coldResumeNetUsd > 0) {
    lines.push(`Running /compact when I came back to a big session after the cache expired would have saved ${usd(r.coldResumeNetUsd)} (${Math.round((r.coldResumeNetUsd / r.billedUsd) * 100)}%, ${r.coldResumes} times).`);
  }
  if (r.reachableUsd > 0) {
    lines.push(`Clearing stale tool output only when the cache is cold would have cut another ${usd(r.reachableUsd)}, with no session made more expensive.`);
  }
  lines.push("Measured from my own transcripts with context-doctor: npx context-doctor savings");
  return lines.join("\n");
}
