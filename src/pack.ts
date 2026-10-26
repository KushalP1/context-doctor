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
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { estimateTokens, formatTokens } from "./tokens.js";
import { EXTRACT_BUDGET_MS, EXTRACTABLE, extractText, extractTextAsync } from "./extract.js";

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
  /**
   * Chunks that were asked for by id, or matched the query, but did not fit
   * what was left of the budget, in priority order. With nothing selected,
   * this is the difference between "nothing matched" and "the budget is too
   * small for what matched".
   */
  unfit: Array<{ id: string; tokens: number; requested: boolean }>;
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

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

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
      let at = cut > maxChars / 2 ? cut + 1 : maxChars;
      // Indexes are UTF-16 units: a cut between the two halves of an emoji or
      // other astral character would leave a lone surrogate on each side.
      if (isHigh(line.charCodeAt(at - 1)) && isLow(line.charCodeAt(at))) at--;
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
  const unfit: PackResult["unfit"] = [];
  let used = 0;
  const take = (c: Chunk, requested: boolean) => {
    if (pick.includes(c)) return;
    if (used + c.tokens > budget) {
      if (!unfit.some((u) => u.id === c.id)) unfit.push({ id: c.id, tokens: c.tokens, requested });
      return;
    }
    pick.push(c);
    used += c.tokens;
  };
  let mode: PackResult["mode"] = "outline";
  if (opts.ids?.length) {
    mode = "ids";
    const byId = new Map(chunks.map((c) => [c.id, c]));
    for (const id of opts.ids) {
      const c = byId.get(id);
      if (c) take(c, true);
      else missingIds.push(id);
    }
  }
  if (query) {
    if (mode === "outline") mode = "query";
    for (const c of [...chunks].filter((c) => c.score > 0).sort((a, b) => b.score - a.score)) take(c, false);
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
    unfit,
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
  const unfitRequested = (r.unfit ?? []).filter((u) => u.requested);
  if (r.selected.length > 0 && unfitRequested.length > 0) {
    out.push(`Did not fit the budget of ${formatTokens(r.budget)}: ${unfitRequested.map((u) => `${u.id} (~${formatTokens(u.tokens)})`).join(", ")}. Ask for it alone or with a larger budget (--max-tokens; MCP max_tokens).`);
  }
  if (r.selected.length === 0 && (r.unfit ?? []).length > 0) {
    // Something matched (or was asked for by id); the budget is what stopped it.
    // "Rephrase" would send the user after the wrong problem.
    const best = r.unfit[0];
    const chunk = r.chunks.find((c) => c.id === best.id);
    out.push(
      `Nothing fit the budget of ${formatTokens(r.budget)} tokens: ${best.requested ? "the requested chunk" : "the best match"} ` +
        `${best.id}${chunk?.heading ? ` (${chunk.heading})` : ""} is ~${formatTokens(best.tokens)} tokens. ` +
        `Raise the budget to at least ${best.tokens} (--max-tokens; MCP max_tokens), or use smaller chunks (--chunk-tokens).`
    );
    out.push(...outline(r.chunks, outlineLimit));
    return out.join("\n");
  }
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

/** Git ignores something under `dir`: why a folder that has files can list none. */
function gitIgnoresSome(dir: string): boolean {
  // --directory names an ignored folder once instead of every file in it.
  const r = spawnSync("git", ["-C", dir, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
  return r.status === 0 && typeof r.stdout === "string" && r.stdout.length > 0;
}

/** `inner` is `root` itself or somewhere under it. */
function within(root: string, inner: string): boolean {
  const rel = relative(root, inner);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

/**
 * Files that hold credentials by convention. Packing one puts its keys into a
 * model's context (and, through MCP, into a transcript on disk): measured on
 * a folder outside git, `pack .` returned an .env's API key and an .npmrc's
 * token verbatim. They are skipped even when named outright or tracked by
 * git; only the CLI's --include-secrets packs them.
 */
const SECRET_NAMES = new Set([".npmrc", ".pypirc", ".netrc", "_netrc", ".git-credentials", ".pgpass", ".htpasswd"]);
const SECRET_EXT = new Set([".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"]);

/** Why `path` looks like a secrets file, or undefined when it does not. */
export function secretFileReason(path: string): string | undefined {
  const name = basename(path);
  const lower = name.toLowerCase();
  if (lower === ".env" || lower.startsWith(".env.")) return "an .env file";
  if (SECRET_NAMES.has(lower)) return `a credentials file (${name})`;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/.test(lower) || (/^id_(rsa|dsa|ecdsa|ed25519)/.test(lower) && !lower.endsWith(".pub"))) {
    return "a private SSH key";
  }
  if (SECRET_EXT.has(extname(lower))) return `a key or certificate store (${extname(lower)})`;
  const parts = path.split(/[\\/]+/);
  if (lower === "credentials" && parts[parts.length - 2] === ".aws") return "AWS credentials";
  return undefined;
}

/**
 * Folders that hold credentials whatever the files inside are called. A path
 * in one is refused unless secrets are allowed (never over MCP).
 */
function sensitiveDirs(): string[] {
  const home = homedir();
  const dirs = [
    ...[".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure", join(".config", "gcloud"), join("Library", "Keychains"), ".password-store"].map((d) => join(home, d)),
    "/etc/shadow", "/etc/gshadow", "/etc/sudoers", "/etc/master.passwd", "/etc/ssh",
  ];
  // Compared against real paths: /etc is /private/etc on macOS, and a home
  // under /var/folders is really /private/var/folders.
  const real = dirs.map((d) => {
    try {
      return realpathSync(d);
    } catch {
      return d;
    }
  });
  return [...new Set([...dirs, ...real])];
}

/** The denylisted folder `path` (a real path) sits in, if any. */
function inSensitiveDir(path: string, dirs: string[]): string | undefined {
  return dirs.find((d) => within(d, path));
}

export interface ReadSourcesOptions {
  /** Names are shown relative to this (default: the working directory). */
  cwd?: string;
  /**
   * Pack secrets files (.env, .npmrc, private keys, …) and paths in credential
   * folders (~/.ssh, ~/.aws, …) too. CLI `--include-secrets` only; the MCP
   * tool has no way to set it.
   */
  includeSecrets?: boolean;
  /** How the caller can opt in, appended to a "secret, skipped" note. */
  secretsHint?: string;
  /**
   * Internal (readSourcesAsync): instead of extracting a PDF or office file
   * on the spot, reserve its slot and list it here for asynchronous
   * extraction under a time budget.
   */
  defer?: Array<{ slot: number; path: string }>;
}

/** A short reason for a filesystem error: EACCES reads as "permission denied", not a stack trace. */
function fsReason(e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return "not found";
  if (code === "EACCES" || code === "EPERM") return "permission denied";
  if (code === "ENOTDIR") return "not a directory";
  if (code === "EISDIR") return "is a directory";
  if (code === "ELOOP") return "too many symlinks";
  return code ? `unreadable (${code})` : `unreadable (${(e as Error)?.message ?? e})`;
}

/**
 * Read files and directories (recursively, skipping build and dependency
 * folders, hidden entries, binaries, secrets files, and anything past the size
 * limits) into sources. `skipped` says what was left out and why, so nothing
 * vanishes silently.
 *
 * A path named here is read even through a symlink; a symlink met inside a
 * folder is not followed, as git does not follow one either. A link out of
 * the folder would pack files nobody named (a tracked link to /etc/hosts, or
 * to a secret beside the repo), a link to a parent loops, and what a link
 * inside points at is read under its own name (or left out by .gitignore).
 *
 * An unreadable entry (permission denied, a device, /dev/fd) is reported as
 * skipped, never thrown: one locked file must not lose the rest of a folder.
 */
export function readSources(
  paths: string[],
  cwdOrOptions: string | ReadSourcesOptions = process.cwd()
): { sources: PackSource[]; skipped: string[] } {
  const options: ReadSourcesOptions = typeof cwdOrOptions === "string" ? { cwd: cwdOrOptions } : cwdOrOptions;
  const cwd = options.cwd ?? process.cwd();
  const includeSecrets = options.includeSecrets === true;
  const secretsHint = options.secretsHint ?? "";
  const denied = includeSecrets ? [] : sensitiveDirs();
  const sources: PackSource[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  // Real paths already packed: a file reached twice ("." and "guide.md") is packed once, not twice under one id.
  // Only packed ones: a binary passed over inside a folder and then named outright still gets its message.
  const seen = new Set<string>();
  // Real location of the path being read: a link out of it is reported, not just dropped.
  let root = "";
  // Hidden files and folders passed over in a walk outside git, per named folder.
  let hidden = 0;
  // Whether the folder being walked was listed by git (hidden tracked files are source there).
  let insideGit = false;
  const realOf = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const visit = (p: string, top: boolean) => {
    if (sources.length >= PACK_LIMITS.files) {
      if (top || skipped.length < 20) skipped.push(`${p}: over ${PACK_LIMITS.files} files`);
      return;
    }
    let st;
    try {
      st = top ? statSync(p) : lstatSync(p);
    } catch (e) {
      skipped.push(`${p}: ${fsReason(e)}`);
      return;
    }
    if (st.isSymbolicLink()) {
      let target: string | undefined;
      try {
        target = realpathSync(p);
      } catch {
        return; // dangling: nothing to read
      }
      if (!within(root, target)) skipped.push(`${p}: symlink pointing outside the folder (not followed)`);
      return;
    }
    if (denied.length > 0) {
      const dir = inSensitiveDir(realOf(p), denied);
      if (dir) {
        // Once per named path: a folder of keys is one refusal, not one per key.
        if (top) skipped.push(`${p}: refused, ${dir} holds credentials${secretsHint}`);
        return;
      }
    }
    if (st.isDirectory()) {
      const name = basename(p);
      if (!top && SKIP_DIRS.has(name)) return;
      if (!top && name.startsWith(".")) {
        hidden++;
        return;
      }
      // Inside a git repository the repository says what is source: tracked
      // files plus untracked ones not ignored, so .gitignore'd build output,
      // data dumps and secrets stay out. Elsewhere, walk with SKIP_DIRS.
      const listed = top ? gitFiles(p) : undefined;
      if (top) insideGit = listed !== undefined;
      if (listed) {
        // A folder named outright that git lists nothing in is still not read
        // (that is the .gitignore guarantee), but the user hears why.
        if (listed.length === 0 && gitIgnoresSome(p)) {
          skipped.push(`${p}: ignored by git (.gitignore); pack reads folders as git does, so ignored files stay out. Name a file to pack it anyway`);
        }
        for (const f of listed) visit(join(p, f), false);
        return;
      }
      let entries: string[];
      try {
        entries = readdirSync(p).sort();
      } catch (e) {
        skipped.push(`${p}: ${fsReason(e)}`);
        return;
      }
      for (const e of entries) visit(join(p, e), false);
      return;
    }
    if (!st.isFile()) {
      if (top) skipped.push(`${p}: not a regular file`);
      return;
    }
    if (!includeSecrets) {
      const why = secretFileReason(p);
      if (why) {
        skipped.push(`${p}: ${why}, likely holding secrets; not packed${secretsHint}`);
        return;
      }
    }
    // Outside git, a hidden file is passed over like a hidden folder (.DS_Store,
    // editor state, tool configs with tokens in them). Named outright, it is read.
    if (!top && basename(p).startsWith(".") && !insideGit) {
      hidden++;
      return;
    }
    const real = realOf(p);
    if (seen.has(real)) return;
    if (st.size > PACK_LIMITS.fileBytes || bytes + st.size > PACK_LIMITS.totalBytes) {
      skipped.push(`${p}: too large (${Math.round(st.size / 1024)} KB)`);
      return;
    }
    const rel = relative(cwd, p);
    const name = rel && !rel.startsWith("..") ? rel : p;
    if (EXTRACTABLE.has(extname(p).toLowerCase())) {
      if (options.defer) {
        bytes += st.size;
        seen.add(real);
        sources.push({ name, text: "" });
        options.defer.push({ slot: sources.length - 1, path: p });
        return;
      }
      const got = extractText(p);
      if ("error" in got) skipped.push(`${p}: ${got.error}`);
      else {
        bytes += st.size;
        seen.add(real);
        sources.push({ name, text: got.text });
      }
      return;
    }
    let buf: Buffer;
    try {
      buf = readFileSync(p);
    } catch (e) {
      skipped.push(`${p}: ${fsReason(e)}`);
      return;
    }
    if (buf.subarray(0, 8000).includes(0)) {
      if (top) skipped.push(`${p}: binary (pack reads text, PDF and Word/PowerPoint/ODT files)`);
      return;
    }
    bytes += st.size;
    seen.add(real);
    sources.push({ name, text: buf.toString("utf8") });
  };
  for (const p of paths) {
    if (!existsSync(p)) {
      skipped.push(`${p}: not found`);
      continue;
    }
    root = realOf(p);
    hidden = 0;
    insideGit = false;
    visit(p, true);
    if (hidden > 0) skipped.push(`${p}: ${hidden} hidden file(s) or folder(s) not read (name one to pack it)`);
  }
  return { sources, skipped };
}

/**
 * readSources for a server: the same walk, with PDFs and office documents
 * extracted asynchronously and all of them within one time budget, so a slow
 * or hostile document neither blocks the event loop nor holds the call.
 */
export async function readSourcesAsync(
  paths: string[],
  options: Omit<ReadSourcesOptions, "defer"> & { budgetMs?: number } = {}
): Promise<{ sources: PackSource[]; skipped: string[] }> {
  const defer: Array<{ slot: number; path: string }> = [];
  const { sources, skipped } = readSources(paths, { ...options, defer });
  const deadline = Date.now() + (options.budgetMs ?? EXTRACT_BUDGET_MS);
  const failed = new Set<number>();
  for (const d of defer) {
    const got = await extractTextAsync(d.path, deadline);
    if ("error" in got) {
      skipped.push(`${d.path}: ${got.error}`);
      failed.add(d.slot);
    } else sources[d.slot].text = got.text;
  }
  return { sources: sources.filter((_, i) => !failed.has(i)), skipped };
}
