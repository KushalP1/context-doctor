/**
 * Measure a model's real chars-per-token from Claude Code transcripts, with no
 * API key and no tokenizer: the API's own counts are already in the file.
 *
 * Two independent measurements, so one can check the other:
 *
 *  - PROSE. An assistant reply with no thinking block is billed as exactly
 *    `output_tokens`, and all of it is visible text in the transcript. Visible
 *    chars / output_tokens is the tokenizer's ratio on the model's own prose.
 *
 *  - BLOCKS (code, tool output, pastes). Between two consecutive API calls in
 *    one session the prompt is the old prompt plus what was appended: the
 *    previous reply (all of `output_tokens`, thinking included, since a tool
 *    loop re-sends it) and the new user-side content. When that content is a
 *    single large block, (growth − previous output_tokens) is its exact size.
 *
 * The injected reminders the harness adds make the block figure slightly
 * pessimistic (a few dozen tokens on blocks of thousands), which is why only
 * blocks over 6k chars count.
 */

import { forEachLine, listSessions } from "./session.js";
import { CHARS_PER_TOKEN, providerFor } from "./tokens.js";

export interface RatioStats {
  samples: number;
  median: number;
  p10: number;
  p90: number;
}

export interface ModelRatios {
  model: string;
  prose?: RatioStats;
  blocks?: RatioStats;
  /** What the estimator uses for this model: prose, code. */
  assumed: { prose: number; code: number };
}

export interface TokenizerReport {
  sessionsScanned: number;
  models: ModelRatios[];
}

const MIN_PROSE_CHARS = 1500;
const MIN_BLOCK_CHARS = 6000;

function stats(values: number[]): RatioStats | undefined {
  if (values.length === 0) return undefined;
  const v = [...values].sort((a, b) => a - b);
  const at = (q: number) => v[Math.min(v.length - 1, Math.floor(q * (v.length - 1)))];
  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return { samples: v.length, median, p10: at(0.1), p90: at(0.9) };
}

interface Request {
  id: string;
  model?: string;
  prompt: number;
  output: number;
  types: Set<string>;
  textChars: number;
  /** User-side entries appended after this request, before the next one. */
  after: Array<{ chars: number; meta: boolean }>;
}

function promptTotal(u: Record<string, unknown>): number {
  const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  return n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
}

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const p of content as Array<Record<string, unknown>>) {
    if (p?.type === "text" && typeof p.text === "string") out += p.text;
    else if (p?.type === "tool_result") {
      const c = p.content;
      if (typeof c === "string") out += c;
      else if (Array.isArray(c)) for (const x of c as Array<Record<string, unknown>>) if (typeof x?.text === "string") out += x.text;
    }
  }
  return out;
}

/** Scan one transcript into per-request records. Never throws on bad lines. */
function readRequests(path: string): Request[] {
  const reqs: Request[] = [];
  let cur: Request | undefined;
  forEachLine(path, (line) => {
    let e: any;
    try { e = JSON.parse(line); } catch { return; }
    if (!e || e.isSidechain) return;
    if (e.type === "assistant" && e.message && typeof e.message === "object") {
      const m = e.message;
      const u = (m.usage ?? {}) as Record<string, unknown>;
      if (!cur || cur.id !== m.id) {
        cur = { id: String(m.id), model: m.model, prompt: promptTotal(u), output: 0, types: new Set(), textChars: 0, after: [] };
        reqs.push(cur);
      }
      if (typeof u.output_tokens === "number") cur.output = Math.max(cur.output, u.output_tokens);
      for (const p of Array.isArray(m.content) ? m.content : []) {
        cur.types.add(String(p?.type));
        if (p?.type === "text" && typeof p.text === "string") cur.textChars += p.text.length;
      }
    } else if (e.type === "user" && cur) {
      const meta = Boolean(e.isMeta || e.isCompactSummary);
      const text = userText(e.message?.content);
      cur.after.push({ chars: text.length, meta });
    }
  });
  return reqs;
}

export function measureTokenizer(limit = 60, paths?: string[]): TokenizerReport {
  const prose = new Map<string, number[]>();
  const blocks = new Map<string, number[]>();
  const push = (m: Map<string, number[]>, k: string, v: number) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
  let scanned = 0;

  const targets = paths ?? listSessions(limit).map((s) => s.path);
  for (const path of targets) {
    let reqs: Request[];
    try { reqs = readRequests(path); } catch { continue; }
    if (reqs.length === 0) continue;
    scanned++;
    for (const r of reqs) {
      if (!r.model || r.model.startsWith("<")) continue;
      if (r.types.size === 1 && r.types.has("text") && r.textChars >= MIN_PROSE_CHARS && r.output > 0) {
        push(prose, r.model, r.textChars / r.output);
      }
    }
    for (let i = 0; i + 1 < reqs.length; i++) {
      const a = reqs[i], b = reqs[i + 1];
      if (!a.model || a.model !== b.model) continue;
      const real = a.after.filter((x) => !x.meta);
      if (a.after.some((x) => x.meta) || real.length !== 1 || real[0].chars < MIN_BLOCK_CHARS) continue;
      const exact = b.prompt - a.prompt - a.output;
      if (exact <= 0) continue; // a compaction or cache reset, not growth
      push(blocks, a.model, real[0].chars / exact);
    }
  }

  const models = [...new Set([...prose.keys(), ...blocks.keys()])]
    .map((model) => ({
      model,
      prose: stats(prose.get(model) ?? []),
      blocks: stats(blocks.get(model) ?? []),
      assumed: CHARS_PER_TOKEN[providerFor(model)],
    }))
    .sort((x, y) => ((y.prose?.samples ?? 0) + (y.blocks?.samples ?? 0)) - ((x.prose?.samples ?? 0) + (x.blocks?.samples ?? 0)));
  return { sessionsScanned: scanned, models };
}

export function renderTokenizer(report: TokenizerReport): string {
  const lines: string[] = [];
  lines.push("Tokenizer check — chars per token, measured from the API's own counts");
  lines.push("─".repeat(56));
  if (report.models.length === 0) {
    lines.push("No usable samples (needs Claude Code sessions with usage recorded).");
    return lines.join("\n");
  }
  const f = (n: number) => n.toFixed(2);
  const err = (assumed: number, real: number) => {
    // Estimated tokens / real tokens − 1, from chars/token on each side.
    const pct = Math.round((real / assumed - 1) * 100);
    return pct === 0 ? "exact" : `estimates ${pct > 0 ? "+" : ""}${pct}%`;
  };
  const row = (label: string, st: RatioStats, unit: string, assumed: number) =>
    `  ${label.padEnd(7)} ${f(st.median)}  ${`(p10 ${f(st.p10)}, p90 ${f(st.p90)}, ${st.samples} ${unit})`.padEnd(34)} ` +
    `estimator ${f(assumed)} → ${err(assumed, st.median)}`;
  for (const m of report.models) {
    lines.push(m.model);
    if (m.prose) {
      lines.push(row("prose", m.prose, "replies", m.assumed.prose));
    }
    if (m.blocks) {
      lines.push(row("blocks", m.blocks, "blocks", m.assumed.code));
    }
  }
  lines.push("");
  lines.push("\"estimates +x%\" means the estimator reports x% more tokens than the API bills for");
  lines.push("the same text (negative: fewer). Blocks are mostly code and tool output.");
  return lines.join("\n");
}
