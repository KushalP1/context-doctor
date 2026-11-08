/**
 * Long tool output: what it costs to keep in the context, and what a lower
 * cap would save. The `tool-output` lever of `fix`.
 *
 * A tool result stays in the conversation, and every later request re-reads
 * it (at the cache-read rate, or the write rate when the cache went cold)
 * until a compaction. Claude Code caps it when it arrives. Read from the
 * 2.1.309 binary and its docs (code.claude.com/docs/en/tools-reference,
 * settings-reference, mcp, env-vars):
 *  - a successful Bash or PowerShell result over `bashOutputMaxChars`
 *    (settings, any scope; default 30,000 characters, clamped to
 *    4,000-128,000; Claude Code 2.1.261+) is saved to a file, and the model
 *    receives the path and a preview of the first 2,000 characters
 *    (`<persisted-output>`). Set, it also replaces BASH_MAX_OUTPUT_LENGTH,
 *    which on its own sizes only the read-back window, not what the model
 *    receives. A failed command gets a head-and-tail excerpt of ~10,000
 *    characters instead, with no file, whatever the setting;
 *  - an MCP text result over MAX_MCP_OUTPUT_TOKENS (environment; default
 *    25,000 tokens) is saved to a file and replaced by a message naming the
 *    path, with no preview; one over 50,000 characters is saved to a file
 *    whatever the variable says (with the same 2,000-character preview as
 *    Bash), unless the tool raises its own limit.
 * Anthropic can also set a tool's threshold server-side (a remote flag the
 * binary reads per tool name); that is not visible here.
 *
 * The replay reads each transcript's requests and its Bash and MCP results
 * in order. For a candidate cap, a successful text result longer than the
 * cap would have been the preview instead: the tokens past it are priced at
 * the first request after the result (the cache write, at the session's own
 * write price) and at every later request until a compaction (a cache read,
 * or a write when that request found the cache cold: over 60% of its context
 * written again). Token counts are estimates from the text's length, at the
 * ratio measured on the growth of the billed prompt between consecutive
 * calls (tokens.ts). Not counted: the model opening the file afterwards, or
 * running the command again. Each such request costs about the context it
 * re-reads, so the replay prices one per moved result and reports how many
 * of them the saving still covers.
 */

import { listSessions, isClaudeSession, replyCounter } from "./session.js";
import { pick, rowsOf, slimUsage, type Extractor } from "./scan.js";
import { cacheWriteSplit, rateCard, ratesAt, requestCost, writeMultiplier, type RecordedUsage } from "./pricing.js";
import { isCodeLike, realModel, tokensForLength } from "./tokens.js";
import { subagentTranscripts } from "./cachettl.js";

/** The settings key the lever writes. */
export const BASH_OUTPUT_KEY = "bashOutputMaxChars";
/** The environment variable the setting replaces (a value the user set there is theirs). */
export const BASH_OUTPUT_ENV = "BASH_MAX_OUTPUT_LENGTH";
/** The first Claude Code that reads the setting (its docs; older versions ignore it). */
export const BASH_OUTPUT_SINCE = "2.1.261";
/** Claude Code's inline ceiling for a successful command, unset. */
export const BASH_OUTPUT_DEFAULT = 30_000;
/** What Claude Code clamps the setting to. */
export const BASH_OUTPUT_MIN = 4_000;
export const BASH_OUTPUT_MAX = 128_000;
/** The caps the replay tries, smallest first; under 8,000 the 2,000-character preview is most of the output. */
export const BASH_OUTPUT_CAPS = [8_000, 12_000, 16_000, 20_000];
/** What the model receives instead: a 2,000-character preview, the path and the wrapper around them. */
const PREVIEW_CHARS = 2_250;
/** The MCP cap the replay tries, in tokens: the size at which Claude Code already warns. */
export const MCP_OUTPUT_CAP = 10_000;
/** What the model receives instead of a long MCP result: a message naming the file (no preview). */
const MCP_NOTICE_CHARS = 700;
/** A request that wrote over this share of its context found the cache cold. */
const COLD_SHARE = 0.6;
/** A context that fell this far with no compaction was cut (a rewind, cleared tool output): what it held is gone. */
const CUT_SHARE = 0.7;

/**
 * One record per request (a reply's first row with usage, per thread), per
 * successful text-only Bash/PowerShell or MCP result (its length, whether it
 * reads as code, and for a result Claude Code already moved to a file, the
 * size it gave), and per compaction. No text: lengths, times, ids, models.
 */
type Row =
  | { t: "r"; th: number; timestamp?: unknown; id?: string; uuid?: string; model?: string; u?: unknown }
  | { t: "b"; th: number; n: number; c: number; p?: number }
  | { t: "m"; th: number; n: number; c: number }
  | { t: "c"; th: number };

/** "Output too large (43.1KB)": the size Claude Code gives a result it saved, in characters (about). */
function persistedSize(text: string): number | undefined {
  const m = /^<persisted-output>\s*Output (?:too large|exceeded the) \(?([\d.]+)\s*(bytes|KB|MB|GB)/.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]) * ({ bytes: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 } as Record<string, number>)[m[2]];
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/** The text a result's content holds; undefined when it carries an image or a document (never moved to a file). */
function resultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  let s = "";
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "image" || b.type === "document") return undefined;
    if (b.type === "text" && typeof b.text === "string") s += b.text;
  }
  return s;
}

export const TOOL_OUTPUT_ROWS: Extractor<{ ids: Record<string, number>; calls: Record<string, string> }> = {
  id: "tool-output.2",
  init: () => ({ ids: {}, calls: {} }),
  line(raw, row, out, st) {
    if (!raw.includes('"usage"') && !raw.includes('"tool_use"') && !raw.includes('"tool_result"') && !raw.includes("compact_boundary")) return;
    let e: any;
    try { e = row(); } catch { return; }
    if (!e || typeof e !== "object") return;
    const th = e.isSidechain ? 1 : 0;
    if (e.type === "system") {
      if (e.subtype === "compact_boundary") out.push({ t: "c", th });
      return;
    }
    const m = e.message;
    if (!m || typeof m !== "object" || !Array.isArray(m.content) && !m.usage) return;
    if (e.type === "assistant") {
      // A reply is written one content block a row, each with its usage: one request, at its first row.
      if (m.usage && typeof m.id === "string" && !((st.ids[m.id] ?? 0) & (th + 1))) {
        st.ids[m.id] = (st.ids[m.id] ?? 0) | (th + 1);
        out.push({ t: "r", th, ...pick(e, ["timestamp", "uuid"]), id: m.id, model: m.model, u: slimUsage(m.usage) });
      } else if (m.usage && typeof m.id !== "string") {
        out.push({ t: "r", th, ...pick(e, ["timestamp", "uuid"]), model: m.model, u: slimUsage(m.usage) });
      }
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b?.type !== "tool_use" || typeof b.id !== "string" || typeof b.name !== "string") continue;
          if (b.name === "Bash" || b.name === "PowerShell") st.calls[b.id] = "b";
          else if (b.name.startsWith("mcp__")) st.calls[b.id] = "m";
        }
      }
      return;
    }
    if (e.type !== "user" || !Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
      const kind = st.calls[b.tool_use_id];
      if (!kind) continue;
      delete st.calls[b.tool_use_id];
      // A failed command gets an excerpt of its own, whatever the cap.
      if (b.is_error) continue;
      const text = resultText(b.content);
      if (text === undefined) continue;
      const c = isCodeLike(text.slice(0, 20_000)) ? 1 : 0;
      if (kind === "m") { out.push({ t: "m", th, n: text.length, c }); continue; }
      const p = text.startsWith("<persisted-output>") ? persistedSize(text) : undefined;
      out.push({ t: "b", th, n: text.length, c, ...(p !== undefined ? { p } : {}) });
    }
  },
};

/**
 * A request, priced: its prompt, rates and whether it counts (in the
 * period, not a fork's copy, priced). `lower`: on a long-prompt tier (Haiku
 * 5.5 over 100k), the share of its prompt's price it would pay below
 * `over` tokens, where all of it bills at the lower rates.
 */
interface Req { k: "r"; prompt: number; readPerM: number; writePerM: number; cold: boolean; counted: boolean; billedUsd: number; over?: number; lower?: number }
/** A result: its length (or the size Claude Code saved), as code or prose, the model's tokenizer. */
interface Res { k: "b" | "m"; n: number; c: number; p?: number; model?: string }
type Step = Req | Res | { k: "c" };

/** One transcript as the replay walks it, per thread, fork copies marked once for every cap. */
function timeline(path: string, since: number, until: number, runRows: Set<string>): Step[][] {
  const threads: Step[][] = [[], []];
  const rows = rowsOf<Row>(path, TOOL_OUTPUT_ROWS);
  // The session's own write price, for writes the replay charges: mostly 1 hour on the main thread, 5 minutes in subagents.
  let w5 = 0, w1 = 0;
  for (const r of rows) if (r?.t === "r") { const s = cacheWriteSplit(r.u as RecordedUsage); w5 += s.fiveMinute; w1 += s.oneHour; }
  const writeMult = writeMultiplier(w5, w1);
  const sighting = replyCounter(runRows);
  const model: Array<string | undefined> = [undefined, undefined];
  // Results met before the thread's first priced reply take that reply's model (its tokenizer).
  const unsized: Res[][] = [[], []];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const th = r.th === 1 ? 1 : 0;
    const out = threads[th];
    if (r.t === "c") { out.push({ k: "c" }); continue; }
    if (r.t === "b" || r.t === "m") {
      const res: Res = { k: r.t, n: r.n, c: r.c, ...(r.t === "b" && r.p !== undefined ? { p: r.p } : {}), model: model[th] };
      if (!res.model) unsized[th].push(res);
      out.push(res);
      continue;
    }
    if (r.t !== "r") continue;
    const seen = sighting({ message: { id: r.id }, uuid: r.uuid });
    if (seen === "repeat") continue;
    const u = (r.u ?? {}) as RecordedUsage;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
    const prompt = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
    const at = Date.parse(String(r.timestamp ?? ""));
    if (!(prompt > 0) || !Number.isFinite(at)) continue;
    const m = realModel(r.model);
    if (m) {
      model[th] = m;
      for (const x of unsized[th].splice(0)) x.model = m;
    }
    const card = rateCard(m, u, at);
    const price = card && ratesAt(card, prompt);
    const below = card?.over !== undefined && prompt > card.over ? card.rates : undefined;
    out.push({
      k: "r", prompt,
      readPerM: price?.cacheReadPerM ?? 0,
      writePerM: (price?.inputPerM ?? 0) * writeMult,
      cold: num(u.cache_creation_input_tokens) > COLD_SHARE * prompt,
      counted: !!price && seen === "new" && at >= since && at < until,
      billedUsd: requestCost(m, u, at)?.promptUsd ?? 0,
      ...(below && price ? { over: card!.over, lower: below.inputPerM / price.inputPerM } : {}),
    });
  }
  return threads;
}

/** Which results a cap moves to a file, and the tokens the model would no longer carry. */
type Mover = (r: Res) => number;

/** A candidate cap for Bash: a successful result longer than it, still inline, becomes the preview. */
export const bashCap = (cap: number): Mover => (r) => (r.k === "b" && r.p === undefined && r.n > cap ? tokensForLength(r.n, !!r.c, r.model) - tokensForLength(PREVIEW_CHARS, !!r.c, r.model) : 0);
/** Since a cap was set: the results Claude Code moved that the cap before would have left inline. */
export const bashMovedSince = (previous: number): Mover => (r) => (r.k === "b" && r.p !== undefined && r.p <= previous ? tokensForLength(r.p, !!r.c, r.model) - tokensForLength(Math.min(r.n, PREVIEW_CHARS), !!r.c, r.model) : 0);
/** MAX_MCP_OUTPUT_TOKENS at `tokens`: a longer text result becomes a message naming the file. */
export const mcpCap = (tokens: number): Mover => (r) => {
  if (r.k !== "m") return 0;
  const t = tokensForLength(r.n, !!r.c, r.model);
  return t > tokens ? t - tokensForLength(MCP_NOTICE_CHARS, false, r.model) : 0;
};

export interface CapReplay {
  /** Results the cap moves to a file, of the ones it applies to. */
  moved: number;
  results: number;
  /** Tokens it keeps out of the context, summed over the requests that re-read them. */
  tokens: number;
  savedUsd: number;
  /** One more request at each moved result's context: what opening the file (or running the command again) costs a time. */
  openUsd: number;
}

/** Walk the timelines once for one cap. */
function walk(lines: Step[][], move: Mover, kind: "b" | "m"): CapReplay {
  let moved = 0, results = 0, tokens = 0, savedUsd = 0, openUsd = 0;
  for (const steps of lines) {
    // The moved results still in the context, and whether a request has re-read each yet.
    let live: Array<{ e: number; fresh: boolean }> = [];
    let prev: number | undefined;
    // Results since the last request that a cap applies to (still inline as recorded): counted with the request that first reads them.
    let arrived = 0;
    for (const s of steps) {
      if (s.k === "c") { live = []; prev = undefined; continue; }
      if (s.k !== "r") {
        if (s.k !== kind) continue;
        if (s.p === undefined) arrived++;
        const e = move(s);
        if (e > 0) live.push({ e, fresh: true });
        continue;
      }
      if (s.counted) results += arrived;
      arrived = 0;
      if (prev !== undefined && s.prompt < CUT_SHARE * prev) live = live.filter((x) => x.fresh);
      prev = s.prompt;
      // Never more than the request held.
      const held = live.reduce((n, x) => n + x.e, 0);
      const scale = held > s.prompt ? s.prompt / held : 1;
      let here = 0;
      for (const x of live) {
        if (x.fresh && s.counted) { moved++; openUsd += (s.prompt * s.readPerM) / 1e6; }
        if (s.counted) {
          const t = x.e * scale;
          tokens += t;
          const usd = (t * (x.fresh || s.cold ? s.writePerM : s.readPerM)) / 1e6;
          savedUsd += usd;
          here += usd;
        }
        x.fresh = false;
      }
      // Under its tier's threshold now: the rest of its prompt bills at the lower rates too.
      if (s.counted && s.over !== undefined && s.lower !== undefined && s.prompt - held * scale <= s.over) savedUsd += Math.max(0, s.billedUsd - here) * (1 - s.lower);
    }
  }
  return { moved, results, tokens, savedUsd, openUsd };
}

export interface ToolOutputReplay {
  /** Transcripts read (main conversations and subagents). */
  transcripts: number;
  requests: number;
  /** Input billed over the same requests (prompt only), the share's base. */
  billedUsd: number;
  /** Successful Bash results Claude Code already saved to a file (over 30,000 characters or the cap set). */
  alreadyMoved: number;
  bash: Array<CapReplay & { cap: number }>;
  /** MAX_MCP_OUTPUT_TOKENS at MCP_OUTPUT_CAP: measured, not offered (the model gets no preview). */
  mcp: CapReplay & { cap: number };
  /** The cap `fix` offers: the most saved among those that cover the model opening at least half the files. */
  recommended?: number;
}

/** The share of moved results the model could open before the cap stops paying (each opening costs openUsd / moved and loses that result's saving). */
export function breakEven(r: CapReplay): number {
  return r.savedUsd + r.openUsd > 0 ? r.savedUsd / (r.savedUsd + r.openUsd) : 0;
}

export interface ToolOutputOptions {
  since: number;
  until?: number;
  /** Transcripts (default: Claude Code's main conversations and subagents written since `since`). */
  paths?: string[];
  caps?: number[];
}

/** Claude Code transcripts written since `since`, subagents included: every place a tool result is re-read. */
export function toolOutputTranscripts(since: number): string[] {
  const main = listSessions(10_000).filter((s) => isClaudeSession(s) && s.modifiedAt.getTime() >= since).map((s) => s.path);
  return [...main, ...subagentTranscripts(since)];
}

/** Replay every Bash and MCP result in [since, until) at each candidate cap. */
export function replayToolOutput(opts: ToolOutputOptions): ToolOutputReplay {
  const until = opts.until ?? Infinity;
  const paths = opts.paths ?? toolOutputTranscripts(opts.since);
  const runRows = new Set<string>();
  const lines: Step[][] = [];
  let requests = 0, billedUsd = 0, alreadyMoved = 0;
  for (const p of paths) {
    let t: Step[][];
    try { t = timeline(p, opts.since, until, runRows); } catch { continue; }
    for (const steps of t) {
      if (!steps.length) continue;
      lines.push(steps);
      for (const s of steps) {
        if (s.k === "r" && s.counted) { requests++; billedUsd += s.billedUsd; }
        if (s.k === "b" && s.p !== undefined) alreadyMoved++;
      }
    }
  }
  const bash = (opts.caps ?? BASH_OUTPUT_CAPS).map((cap) => ({ cap, ...walk(lines, bashCap(cap), "b") }));
  const mcp = { cap: MCP_OUTPUT_CAP, ...walk(lines, mcpCap(MCP_OUTPUT_CAP), "m") };
  const paying = bash.filter((b) => b.moved > 0 && breakEven(b) >= 0.5).sort((a, b) => b.savedUsd - a.savedUsd);
  return { transcripts: paths.length, requests, billedUsd, alreadyMoved, bash, mcp, recommended: paying[0]?.cap };
}

/** What a cap set at `since` saved: the results it moved that the cap before (`previous`) left inline, re-read no more. */
export function toolOutputSavedSince(since: number, previous: number, paths?: string[]): CapReplay {
  const runRows = new Set<string>();
  const lines: Step[][] = [];
  for (const p of paths ?? toolOutputTranscripts(since)) {
    try { lines.push(...timeline(p, since, Infinity, runRows).filter((s) => s.length)); } catch { /* unreadable */ }
  }
  return walk(lines, bashMovedSince(previous), "b");
}

const usd = (n: number): string => (Math.abs(n) >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const k = (n: number) => `${Math.round(n / 1000)}k`;

/** The lines under the lever in `fix`: each cap tried, and MCP's. */
export function renderToolOutputCaps(r: ToolOutputReplay): string[] {
  const out = [`${"cap (characters)".padEnd(18)}${"moved".padStart(14)}${"saved".padStart(10)}   pays unless the model opens`];
  for (const b of r.bash) {
    const mark = b.cap === r.recommended ? "  ←" : "";
    out.push(`${k(b.cap).padEnd(18)}${`${b.moved.toLocaleString("en-US")} of ${b.results.toLocaleString("en-US")}`.padStart(14)}${usd(b.savedUsd).padStart(10)}   over ${pct(breakEven(b))} of them${mark}`);
  }
  const m = r.mcp;
  if (m.results > 0) {
    out.push(m.moved > 0
      ? `MCP results over ${k(m.cap)} tokens: ${m.moved.toLocaleString("en-US")} of ${m.results.toLocaleString("en-US")}, ${usd(m.savedUsd)} re-reading them; not offered: over MAX_MCP_OUTPUT_TOKENS the model gets only the file's path, no preview.`
      : `MCP results: none of ${m.results.toLocaleString("en-US")} over ${k(m.cap)} tokens.`);
  }
  return out;
}
