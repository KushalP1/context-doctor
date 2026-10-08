/**
 * Optional semantic ranking for `pack`, through a local Ollama.
 *
 * BM25 misses pure paraphrase ("how long before the cache goes cold" against
 * `COLD_IDLE_MS = 65 * 60_000`). When Ollama runs on this machine with an
 * embedding model, `pack --semantic` embeds the question and the chunks and
 * merges the two rankings by reciprocal rank fusion, which needs no
 * calibration between BM25 scores and cosine similarities. Never required:
 * without Ollama or an embedding model, pack stays lexical and says why.
 *
 * Local only (OLLAMA_HOST, default 127.0.0.1:11434), no key. Chunk vectors are
 * cached on disk by model and text hash, so packing the same folder again
 * embeds only what changed.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Chunk } from "./pack.js";

const EMBED_NAME = /embed|bge|e5-|gte|minilm|nomic|mxbai|arctic|snowflake/i;
const BATCH = 64;
const CACHE_CAP = 50_000;

export interface SemanticResult {
  used: boolean;
  model?: string;
  /** Why semantic ranking was not used, or what it did. */
  note: string;
}

function host(): string {
  const h = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  return h.startsWith("http") ? h.replace(/\/$/, "") : `http://${h}`;
}

async function getJson(path: string, body?: unknown, timeoutMs = 60_000): Promise<any> {
  const r = await fetch(host() + path, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

/** The embedding model to use: the one asked for, else the first installed model that looks like one. */
export async function findEmbeddingModel(preferred?: string): Promise<string | undefined> {
  const tags = await getJson("/api/tags", undefined, 2_000);
  const names: string[] = (tags.models ?? []).map((m: any) => String(m.name));
  if (preferred) return names.find((n) => n === preferred || n.startsWith(preferred + ":")) ?? preferred;
  return names.find((n) => EMBED_NAME.test(n));
}

function cachePath(): string {
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "context-doctor", "embeddings.json");
}

function loadCache(): Record<string, number[]> {
  try {
    return existsSync(cachePath()) ? JSON.parse(readFileSync(cachePath(), "utf8")) : {};
  } catch {
    return {};
  }
}

function saveCache(cache: Record<string, number[]>): void {
  try {
    const keys = Object.keys(cache);
    // Oldest entries go first once the cache passes its cap (insertion order).
    if (keys.length > CACHE_CAP) for (const k of keys.slice(0, keys.length - CACHE_CAP)) delete cache[k];
    mkdirSync(join(cachePath(), ".."), { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(cache));
  } catch {
    /* a cache is an optimization */
  }
}

async function embed(model: string, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const r = await getJson("/api/embed", { model, input: texts.slice(i, i + BATCH), truncate: true });
    out.push(...(r.embeddings as number[][]));
  }
  return out;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Re-score `chunks` in place: score = RRF(BM25 rank) + RRF(embedding rank),
 * k = 60. A chunk BM25 never matched can still rank by meaning alone.
 */
export async function semanticRerank(chunks: Chunk[], query: string, opts: { model?: string } = {}): Promise<SemanticResult> {
  let model: string | undefined;
  try {
    model = await findEmbeddingModel(opts.model);
  } catch {
    return { used: false, note: `semantic ranking off: no Ollama at ${host()} (keyword ranking only)` };
  }
  if (!model) return { used: false, note: "semantic ranking off: Ollama has no embedding model; run `ollama pull nomic-embed-text` (keyword ranking only)" };

  const cache = loadCache();
  const key = (t: string) => createHash("sha1").update(model + "\u0000" + t).digest("hex");
  const texts = chunks.map((c) => (c.heading ? c.heading + "\n" : "") + c.text);
  const missing = [...new Set(texts.filter((t) => !cache[key(t)]))];
  let vectors: number[][];
  let queryVec: number[];
  try {
    const fresh = await embed(model, [query, ...missing]);
    queryVec = fresh[0];
    missing.forEach((t, i) => (cache[key(t)] = fresh[i + 1]));
    vectors = texts.map((t) => cache[key(t)]);
  } catch (e) {
    return { used: false, model, note: `semantic ranking off: ${model} failed (${(e as Error).message}); keyword ranking only` };
  }
  if (missing.length) saveCache(cache);

  const K = 60;
  const lexRank = new Map([...chunks].filter((c) => c.score > 0).sort((a, b) => b.score - a.score).map((c, i) => [c, i]));
  const sims = chunks.map((c, i) => ({ c, s: cosine(queryVec, vectors[i]) })).sort((a, b) => b.s - a.s);
  const semRank = new Map(sims.map((x, i) => [x.c, i]));
  for (const c of chunks) {
    const l = lexRank.get(c);
    c.score = (l === undefined ? 0 : 1 / (K + l)) + 1 / (K + semRank.get(c)!);
  }
  return { used: true, model, note: `semantic ranking: ${model}, ${missing.length} of ${texts.length} chunks embedded (rest cached)` };
}
