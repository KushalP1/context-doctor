/**
 * Pack: put only the parts of a document that matter into the context.
 *
 * Everything else in context-doctor slims a conversation after the fact. The
 * cheapest token is the one that never goes in: a 60k-token manual pasted to
 * answer one question costs 60k tokens on that message and on every message
 * after it. Pack splits files into chunks along their own structure (markdown
 * headings, top-level code declarations, paragraphs), ranks the chunks against
 * a question with BM25, and returns the best ones that fit a token budget, with
 * an id and line range on each so the model can ask for more.
 *
 * Offline and keyless like the rest of the tool: lexical ranking, no embeddings
 * and no model calls. Lexical ranking misses pure paraphrase; the outline that
 * comes with every result lets the model pick sections by heading when it does.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { estimateTokens, formatTokens } from "./tokens.js";
import { EXTRACTABLE, extractText } from "./extract.js";

export interface PackSource {
  /** Name shown in chunk ids, e.g. a path relative to where the user is. */
  name: string;
  text: string;
}

export interface Chunk {
  /** `name#n`, stable for the same file and chunk size. */
  id: string;
  source: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Markdown heading path or the chunk's first declaration line. */
  heading: string;
  text: string;
  tokens: number;
  /** BM25 score against the query; 0 when there is none. */
  score: number;
}

export interface PackOptions {
  /** The question the context is for. Without one, pack returns an outline. */
  query?: string;
  /** Token budget for the packed text (default 4000). */
  budget?: number;
  /** Chunks by id (from an earlier outline or result), packed in this order of priority. */
  ids?: string[];
  /** Upper bound for one chunk (default 400 tokens). */
  maxChunkTokens?: number;
  /** Model whose tokenizer the budget is in. Default: Claude's ratios, the conservative ones. */
  model?: string;
}

export interface PackResult {
  mode: "query" | "ids" | "outline";
  query?: string;
  budget: number;
  /** Tokens across every source, i.e. the cost of pasting them whole. */
  totalTokens: number;
  packedTokens: number;
  /** Selected chunks, in source and line order. */
  selected: Chunk[];
  /** Every chunk, scored, in source and line order. */
  chunks: Chunk[];
  /** Ids asked for that do not exist. */
  missingIds: string[];
  /** What semantic ranking did, or why it was off (packContextSemantic only). */
  semanticNote?: string;
  sources: Array<{ name: string; tokens: number; chunks: number; selected: number }>;
}

const DEFAULT_BUDGET = 4000;
const DEFAULT_CHUNK_TOKENS = 400;
/** Claude's tokenizer produces the most tokens per char; a budget in its terms never overruns another's. */
const DEFAULT_MODEL = "claude";

const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".h",
  ".cc", ".cpp", ".hpp", ".cs", ".php", ".scala", ".sh", ".bash", ".zsh", ".sql", ".lua", ".dart", ".vue", ".svelte",
]);
const MARKDOWN_EXT = new Set([".md", ".mdx", ".markdown", ".rst", ".adoc"]);

type Kind = "markdown" | "code" | "prose";

function kindOf(name: string, text: string): Kind {
  const ext = extname(name).toLowerCase();
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (CODE_EXT.has(ext)) return "code";
  if (/^#{1,6}\s+\S/m.test(text) && !/^#!/.test(text)) return "markdown";
  return "prose";
}

/** A top-level declaration or block start in most languages: not indented, not a closer. */
const CODE_BOUNDARY = /^(?![\s})\]]|$)/;

const COMMENT_LINE = /^(\/\*\*?|\*\/?|\/\/|#(?!include|define|!)|"""|\'\'\'|--|@\w+)/;

interface Unit {
  start: number; // 0-based line index, inclusive
  end: number; // exclusive
  heading: string;
  /** A markdown heading starts here: never merge it into the previous chunk. */
  hard: boolean;
}

/** Structural units: markdown sections and paragraphs, code blocks, prose paragraphs. */
function units(lines: string[], kind: Kind): Unit[] {
  const out: Unit[] = [];
  const path: string[] = [];
  let heading = "";
  let start = 0;
  let hard = false;
  let inFence = false;
  const close = (end: number, nextHard: boolean) => {
    if (end > start && lines.slice(start, end).some((l) => l.trim())) out.push({ start, end, heading, hard });
    start = end;
    hard = nextHard;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (kind === "markdown") {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      const h = !inFence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (h) {
        close(i, true);
        const level = h[1].length;
        path.length = level - 1;
        path[level - 1] = h[2];
        heading = path.filter(Boolean).join(" > ");
        continue;
      }
      if (!inFence && !line.trim() && i + 1 < lines.length && lines[i + 1].trim()) close(i + 1, false);
    } else if (kind === "code") {
      // A new unit at a top-level line that follows a blank line.
      if (i > 0 && !lines[i - 1].trim() && line.trim() && CODE_BOUNDARY.test(line)) close(i, false);
    } else if (!line.trim() && i + 1 < lines.length && lines[i + 1].trim()) {
      close(i + 1, false);
    }
  }
  close(lines.length, false);
  if (kind !== "markdown") {
    for (const u of out) {
      // Label code by its declaration, not the doc comment above it.
      const body = lines.slice(u.start, u.end).map((l) => l.trim()).filter(Boolean);
      const prose = body.map((l) => l.replace(COMMENT_LINE, "").trim()).find(Boolean);
      const label = (kind === "code" && (body.find((l) => !COMMENT_LINE.test(l)) || prose)) || body[0] || "";
      u.heading = label.slice(0, 80);
    }
  }
  return out;
}

/** Split one source into chunks of at most `maxTokens`, along its own structure. */
export function chunkSource(source: PackSource, opts: { maxChunkTokens?: number; model?: string } = {}): Chunk[] {
  const maxTokens = Math.max(50, opts.maxChunkTokens ?? DEFAULT_CHUNK_TOKENS);
  const model = opts.model ?? DEFAULT_MODEL;
  const kind = kindOf(source.name, source.text);
  // A line longer than a chunk (minified code, base64, one-line logs) is cut
  // into pieces at whitespace where it can be; `lineNo` keeps line ranges true.
  const lines: string[] = [];
  const lineNo: number[] = [];
  const maxChars = Math.floor(maxTokens * 2.4);
  source.text.replace(/\r\n?/g, "\n").split("\n").forEach((line, n) => {
    while (line.length > maxChars) {
      const cut = line.lastIndexOf(" ", maxChars);
      const at = cut > maxChars / 2 ? cut + 1 : maxChars;
      lines.push(line.slice(0, at));
      lineNo.push(n + 1);
      line = line.slice(at);
    }
    lines.push(line);
    lineNo.push(n + 1);
  });
  // Prefix sums of per-line estimates: re-estimating slices would be quadratic on a big log.
  const prefix = [0];
  for (const l of lines) prefix.push(prefix[prefix.length - 1] + estimateTokens(l + "\n", model));
  const tok = (a: number, b: number) => prefix[b] - prefix[a];

  // Units over the limit are cut by lines; a single over-long line stays whole
  // (cutting inside a line breaks words, code and tables alike).
  const pieces: Unit[] = [];
  for (const u of units(lines, kind)) {
    if (tok(u.start, u.end) <= maxTokens) {
      pieces.push(u);
      continue;
    }
    let s = u.start;
    for (let i = u.start + 1; i <= u.end; i++) {
      if (i === u.end || tok(s, i + 1) > maxTokens) {
        const first = s === u.start;
        pieces.push({ start: s, end: i, heading: first ? u.heading : `${u.heading} (cont.)`, hard: first && u.hard });
        s = i;
      }
    }
  }

  // Merge small neighbours up to the limit, never across a heading.
  const merged: Unit[] = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last && !p.hard && last.heading === p.heading && tok(last.start, p.end) <= maxTokens) last.end = p.end;
    else if (last && !p.hard && kind !== "markdown" && tok(last.start, p.end) <= maxTokens) last.end = p.end;
    else merged.push({ ...p });
  }

  return merged.map((u, n) => {
    // Trim blank edges so line ranges point at content.
    let a = u.start;
    let b = u.end;
    while (a < b && !lines[a].trim()) a++;
    while (b > a && !lines[b - 1].trim()) b--;
    const text = lines.slice(a, b).join("\n");
    return {
      id: `${source.name}#${n + 1}`,
      source: source.name,
      startLine: lineNo[a] ?? a + 1,
      endLine: lineNo[b - 1] ?? b,
      heading: u.heading,
      text,
      tokens: estimateTokens(text, model),
      score: 0,
    };
  });
}

const STOPWORDS = new Set(
  ("a an and are as at be but by can do does for from has have how i if in into is it its of on or our so that the their " +
    "them then there these they this to was we were what when where which who why will with you your about should would could " +
    "not no yes all any my me get set use using used").split(" ")
);

/** Lowercased terms: camelCase and snake_case split, stopwords dropped, plural -s folded. */
export function terms(text: string): string[] {
  const out: string[] = [];
  const words = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^\p{L}\p{N}]+/u);
  for (let w of words) {
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
    else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    out.push(w);
  }
  return out;
}

/** BM25 (k1 1.2, b 0.75); heading terms count twice, as a heading says what a section is about. */
export function scoreChunks(chunks: Chunk[], query: string): void {
  const q = [...new Set(terms(query))];
  if (q.length === 0 || chunks.length === 0) return;
  const docs = chunks.map((c) => {
    const t = [...terms(c.text), ...terms(c.heading), ...terms(c.heading)];
    const tf = new Map<string, number>();
    for (const w of t) tf.set(w, (tf.get(w) ?? 0) + 1);
    return { len: t.length, tf };
  });
  const avg = docs.reduce((s, d) => s + d.len, 0) / docs.length || 1;
  const n = docs.length;
  for (const term of q) {
    const df = docs.filter((d) => d.tf.has(term)).length;
    if (df === 0) continue;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    docs.forEach((d, i) => {
      const f = d.tf.get(term) ?? 0;
      if (f) chunks[i].score += idf * ((f * 2.2) / (f + 1.2 * (1 - 0.75 + (0.75 * d.len) / avg)));
    });
  }
}

/** Chunk, rank and select. Pure: give it text, get the plan back. */
export function packContext(sources: PackSource[], opts: PackOptions = {}): PackResult {
  const perSource = sources.map((s) => chunkSource(s, opts));
  const query = opts.query?.trim() || undefined;
  if (query) scoreChunks(perSource.flat(), query);
  return select(sources, perSource, query, opts);
}

/**
 * packContext with optional semantic re-ranking through a local Ollama
 * (`semantic: true`, or a model name). Falls back to keyword ranking, with
 * the reason in `semanticNote`, when no embedding model is available.
 */
export async function packContextSemantic(sources: PackSource[], opts: PackOptions & { semantic?: boolean | string } = {}): Promise<PackResult> {
  const perSource = sources.map((s) => chunkSource(s, opts));
  const query = opts.query?.trim() || undefined;
  let semanticNote: string | undefined;
  if (query) {
    scoreChunks(perSource.flat(), query);
    if (opts.semantic) {
      const { semanticRerank } = await import("./embed.js");
      semanticNote = (await semanticRerank(perSource.flat(), query, { model: typeof opts.semantic === "string" ? opts.semantic : undefined })).note;
    }
  }
  return { ...select(sources, perSource, query, opts), semanticNote };
}

function select(sources: PackSource[], perSource: Chunk[][], query: string | undefined, opts: PackOptions): PackResult {
  const budget = Math.max(1, opts.budget ?? DEFAULT_BUDGET);
  const chunks = perSource.flat();
  const pick: Chunk[] = [];
  const missingIds: string[] = [];
  let used = 0;
  const take = (c: Chunk) => {
    if (pick.includes(c) || used + c.tokens > budget) return;
    pick.push(c);
    used += c.tokens;
  };
  let mode: PackResult["mode"] = "outline";
  if (opts.ids?.length) {
    mode = "ids";
    const byId = new Map(chunks.map((c) => [c.id, c]));
    for (const id of opts.ids) {
      const c = byId.get(id);
      if (c) take(c);
      else missingIds.push(id);
    }
  }
  if (query) {
    if (mode === "outline") mode = "query";
    for (const c of [...chunks].filter((c) => c.score > 0).sort((a, b) => b.score - a.score)) take(c);
  }
  const order = new Map(chunks.map((c, i) => [c, i]));
  pick.sort((a, b) => order.get(a)! - order.get(b)!);

  return {
    mode,
    query,
    budget,
    totalTokens: chunks.reduce((s, c) => s + c.tokens, 0),
    packedTokens: used,
    selected: pick,
    chunks,
    missingIds,
    sources: sources.map((s, i) => ({
      name: s.name,
      tokens: perSource[i].reduce((sum, c) => sum + c.tokens, 0),
      chunks: perSource[i].length,
      selected: perSource[i].filter((c) => pick.includes(c)).length,
    })),
  };
}

/** Outline lines: one per chunk, so a model can choose sections by heading. */
function outline(chunks: Chunk[], limit: number): string[] {
  const shown = chunks.slice(0, limit).map((c) => `  ${c.id}  L${c.startLine}-${c.endLine}  ~${formatTokens(c.tokens)}  ${c.heading}`);
  if (chunks.length > limit) shown.push(`  … ${chunks.length - limit} more`);
  return shown;
}

/** Plain-text rendering for a model or a terminal. */
export function renderPack(r: PackResult, { outlineLimit = 60 }: { outlineLimit?: number } = {}): string {
  const out: string[] = [];
  const pct = r.totalTokens > 0 ? Math.round((r.packedTokens / r.totalTokens) * 100) : 0;
  const names = r.sources.length === 1 ? r.sources[0].name : `${r.sources.length} files`;
  if (r.mode === "outline") {
    out.push(`OUTLINE of ${names}: ~${formatTokens(r.totalTokens)} tokens in ${r.chunks.length} chunks. Nothing packed: pass a query, or chunk ids from this list.`);
    out.push(...outline(r.chunks, outlineLimit));
    return out.join("\n");
  }
  out.push(
    `PACKED ~${formatTokens(r.packedTokens)} of ~${formatTokens(r.totalTokens)} tokens (${pct}%) from ${names}: ` +
      `${r.selected.length} of ${r.chunks.length} chunks` +
      (r.query ? ` for "${r.query}"` : "") +
      `, budget ${formatTokens(r.budget)}.`
  );
  if (r.missingIds.length) out.push(`Unknown ids: ${r.missingIds.join(", ")}.`);
  if (r.semanticNote) out.push(`(${r.semanticNote})`);
  if (r.selected.length === 0) {
    out.push("No chunk matched. Choose from the outline by id, or rephrase with words the document would use.");
    out.push(...outline(r.chunks, outlineLimit));
    return out.join("\n");
  }
  for (const c of r.selected) {
    out.push("", `── ${c.id} · L${c.startLine}-${c.endLine}${c.heading ? ` · ${c.heading}` : ""} · ~${formatTokens(c.tokens)}`, c.text);
  }
  const left = r.chunks.length - r.selected.length;
  if (left > 0) {
    // Name the best of what was left out, so asking for more is one call.
    const next = r.chunks.filter((c) => c.score > 0 && !r.selected.includes(c)).sort((a, b) => b.score - a.score).slice(0, 5);
    out.push("", `Not included: ${left} chunk(s). ` + (next.length ? `Next best: ${next.map((c) => `${c.id} (${c.heading || `L${c.startLine}`})`).join("; ")}.` : "Ask for the outline to see them."));
  }
  return out.join("\n");
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "__pycache__", ".venv", "venv", "vendor"]);
export const PACK_LIMITS = { files: 500, fileBytes: 5 * 1024 * 1024, totalBytes: 50 * 1024 * 1024 };

/**
 * Read files and directories (recursively, skipping build and dependency
 * folders, binaries, and anything past the size limits) into sources.
 * `skipped` says what was left out and why, so nothing vanishes silently.
 */
/** Files git would consider part of the repository under `dir` (relative to it), or undefined outside git. */
function gitFiles(dir: string): string[] | undefined {
  try {
    const r = spawnSync("git", ["-C", dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
    if (r.status !== 0 || typeof r.stdout !== "string") return undefined;
    // --cached lists files deleted from the work tree too; only what exists is read.
    return r.stdout.split("\0").filter((f) => f && existsSync(join(dir, f))).sort();
  } catch {
    return undefined;
  }
}

export function readSources(paths: string[], cwd = process.cwd()): { sources: PackSource[]; skipped: string[] } {
  const sources: PackSource[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  const visit = (p: string, top: boolean) => {
    if (sources.length >= PACK_LIMITS.files) {
      if (top || skipped.length < 20) skipped.push(`${p}: over ${PACK_LIMITS.files} files`);
      return;
    }
    let st;
    try {
      st = statSync(p);
    } catch {
      skipped.push(`${p}: not found`);
      return;
    }
    if (st.isDirectory()) {
      if (!top && (SKIP_DIRS.has(basename(p)) || basename(p).startsWith("."))) return;
      // Inside a git repository the repository says what is source: tracked
      // files plus untracked ones not ignored, so .gitignore'd build output,
      // data dumps and secrets stay out. Elsewhere, walk with SKIP_DIRS.
      const listed = top ? gitFiles(p) : undefined;
      if (listed) {
        for (const f of listed) visit(join(p, f), false);
        return;
      }
      for (const e of readdirSync(p).sort()) visit(join(p, e), false);
      return;
    }
    if (!st.isFile()) return;
    if (st.size > PACK_LIMITS.fileBytes || bytes + st.size > PACK_LIMITS.totalBytes) {
      skipped.push(`${p}: too large (${Math.round(st.size / 1024)} KB)`);
      return;
    }
    const rel = relative(cwd, p);
    const name = rel && !rel.startsWith("..") ? rel : p;
    if (EXTRACTABLE.has(extname(p).toLowerCase())) {
      const got = extractText(p);
      if ("error" in got) skipped.push(`${p}: ${got.error}`);
      else {
        bytes += st.size;
        sources.push({ name, text: got.text });
      }
      return;
    }
    const buf = readFileSync(p);
    if (buf.subarray(0, 8000).includes(0)) {
      if (top) skipped.push(`${p}: binary (pack reads text, PDF and Word/PowerPoint/ODT files)`);
      return;
    }
    bytes += st.size;
    sources.push({ name, text: buf.toString("utf8") });
  };
  for (const p of paths) {
    if (!existsSync(p)) skipped.push(`${p}: not found`);
    else visit(p, true);
  }
  return { sources, skipped };
}
