/**
 * Codex's footer, drawn by our MCP server (ROADMAP G5).
 *
 * Codex 0.171.0 lets an MCP tool be a status line, behind its
 * `tui_extensions_statusline` experiment (`/experimental`, Custom status
 * line). The shapes here are Codex's own (openai/codex, codex-rs, read
 * 2026-11-20): `tui/src/statusline_provider/descriptor.rs` takes a tool
 * whose `_meta["openai/ui"].entrypoints` holds exactly one
 * `{ type: "statusline", resourceUri: "ui://..." }`, the tool's title being
 * its name in the `/statusline` picker; `tui/src/chatwidget/statusline_reader.rs`
 * then reads that resource with the displayed thread's snapshot in
 * `params._meta["com.openai/codex-statusline-state"]`, gives each read one
 * second, waits a second and reads again; `statusline_reader/resource.rs`
 * wants exactly one text content at the advertised URI, `application/json`,
 * holding a UI tree (`tui/src/ui_tree.rs`: unknown fields refused, 64 KiB,
 * 256 non-null nodes, depth 16, 16 KiB of text; `null` clears the footer).
 * An error or a timeout stops the polling until the person picks the
 * provider again, so a read here never fails: at worst it answers the last
 * line it drew, or `null`.
 *
 * What it shows, short and plain, only what is known:
 *   context 412k of 1.0M (41%)   $3.21 this session   limits: 5h 23%, weekly 41%
 * The context and the plan's windows are the snapshot's own figures. The
 * dollars are the session's price as `spend` and the every-prompt hook count
 * it, at list prices, the agents the thread spawned included (sessionTotal,
 * sharing the hook's per-session entries). That reads the thread's rollout,
 * whole on a change, which on a 70 MB rollout takes longer than a footer
 * may wait, so it runs in a worker thread, at most one at a time, cached
 * per thread and refreshed when the thread's token totals move; a read
 * waits for it at most READ_BUDGET_MS and otherwise draws the last price
 * it had, or, before the first, the snapshot's own totals priced at the
 * model's rates (the thread alone).
 *
 * Nothing is drawn unasked: Codex shows it only to someone who turned the
 * experiment on and picked it in `/statusline`, and the tool is listed only
 * to Codex (mcp.ts).
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { codexDir } from "./codexdir.js";
import { codexSessionsRoot, rolloutFiles } from "./limits.js";
import { openAIUsage, rateCard, ratesAt, usageCost } from "./pricing.js";
import { formatTokens } from "./tokens.js";

/** The resource Codex reads; the tool advertises it. */
export const CODEX_STATUSLINE_URI = "ui://context-doctor/statusline";
/** Where Codex puts the displayed thread's snapshot in a read's `params._meta`. */
export const CODEX_STATUSLINE_STATE = "com.openai/codex-statusline-state";
/** The tool's `_meta`: exactly one statusline entrypoint (Codex ignores a tool with two). */
export const CODEX_STATUSLINE_META = { "openai/ui": { entrypoints: [{ type: "statusline", resourceUri: CODEX_STATUSLINE_URI }] } };
/** The worker thread's role, passed as its `workerData`. */
export const PRICE_WORKER_ROLE = "context-doctor/codex-statusline-price";

/** Codex gives a read one second; this answers well inside it. */
export const READ_BUDGET_MS = 200;
/** The session's price is re-read at least this often while the footer shows (subagents move it too). */
const PRICE_TTL_MS = 30_000;
/** A price the worker has not answered in this long is given up on. */
const ASK_TIMEOUT_MS = 60_000;
/** And no sooner than this after the last, whatever moved. */
const PRICE_MIN_GAP_MS = 3_000;

// -- The UI tree (codex-rs/tui/src/ui_tree.rs) ---------------------------------

type Color = string;
export type UiNode =
  | string
  | { type: "text"; props?: { color?: Color | null; weight?: "normal" | "bold" | null }; children: Array<UiNode | null> }
  | { type: "row"; props: { gap: number; wrap?: "nowrap" | "wrap"; justify?: "start" | "center" | "end" | "between" }; children: Array<UiNode | null> };

/** Codex's limits on a tree's JSON (ui_tree/decode.rs). */
export const TREE_LIMITS = { bytes: 64 * 1024, nodes: 256, depth: 16, textBytes: 16 * 1024 };

/** A tree's JSON measured as Codex measures it; `ok` when it is within every limit. */
export function measureTree(json: string): { ok: boolean; bytes: number; nodes: number; depth: number; textBytes: number } {
  const bytes = Buffer.byteLength(json, "utf8");
  let nodes = 0, depth = 0, textBytes = 0;
  const walk = (n: unknown, d: number): void => {
    if (n === null || n === undefined) return;
    nodes++;
    depth = Math.max(depth, d);
    if (typeof n === "string") { textBytes += Buffer.byteLength(n, "utf8"); return; }
    for (const c of (n as { children?: unknown[] }).children ?? []) walk(c, d + 1);
  };
  walk(JSON.parse(json), 0);
  return { ok: bytes <= TREE_LIMITS.bytes && nodes <= TREE_LIMITS.nodes && depth <= TREE_LIMITS.depth && textBytes <= TREE_LIMITS.textBytes, bytes, nodes, depth, textBytes };
}

// -- The snapshot (codex-rs/skills/.../create-statusline/references/statusline.d.ts) --

interface RateLimitWindow { used_percent?: number; window_minutes?: number | null; resets_at?: number | null }
/** The parts of Codex's `StatuslineState` this reads. Everything optional: a field Codex leaves out is simply not shown. */
export interface CodexStatuslineState {
  account?: { rate_limits?: Array<{ limit_id?: string; primary_limit?: RateLimitWindow | null; secondary_limit?: RateLimitWindow | null }> };
  thread?: {
    id?: string;
    model?: { id?: string; display_name?: string };
    usage?: {
      context?: { context_window_size?: number; used_tokens?: number; used_percentage?: number };
      total?: { total_input_tokens?: number; cache_read_input_tokens?: number; cache_write_input_tokens?: number; other_input_tokens?: number; output_tokens?: number };
      cost?: { total_cost_usd?: number; total_credits?: number };
    };
  };
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;

/** "$3.21", "$0.42", "$1,240": the session's cost as the footer shows it. */
function dollars(n: number): string {
  if (n >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  return `$${n.toFixed(2)}`;
}

/** "5h", "weekly", "30d": a window's name from its length. */
function windowName(minutes: number | null | undefined): string | undefined {
  if (!positive(minutes)) return undefined;
  if (minutes === 300) return "5h";
  if (minutes === 10_080) return "weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** "14:32" local, or "Fri 14:32" when it is not today. */
function resetClock(epochSeconds: number, nowMs: number): string | undefined {
  const d = new Date(epochSeconds * 1000);
  if (!Number.isFinite(d.getTime()) || d.getTime() <= nowMs || d.getTime() > nowMs + 31 * 86_400_000) return undefined;
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date(nowMs).toDateString() ? hm : `${d.toLocaleDateString("en-US", { weekday: "short" })} ${hm}`;
}

/**
 * The thread's own token totals priced at its model's list rates, the tier
 * of its current context: the price before the rollout's is known. The
 * thread alone (no spawned agents); undefined for a model with no price.
 */
export function snapshotUsd(state: CodexStatuslineState, at = Date.now()): number | undefined {
  const t = state.thread?.usage?.total;
  const model = state.thread?.model?.id;
  if (!t || !model) return undefined;
  const card = rateCard(model, undefined, at);
  if (!card) return undefined;
  const u = openAIUsage({ input_tokens: t.total_input_tokens, cached_input_tokens: t.cache_read_input_tokens, cache_write_input_tokens: t.cache_write_input_tokens, output_tokens: t.output_tokens });
  const usd = usageCost(u, ratesAt(card, finite(state.thread?.usage?.context?.used_tokens) ? state.thread!.usage!.context!.used_tokens! : 0)).totalUsd;
  return finite(usd) && usd > 0 ? usd : undefined;
}

/**
 * The footer for one snapshot, or null when nothing is known (Codex then
 * clears it). `sessionUsd`: the session's price, when known; otherwise the
 * snapshot's totals priced, then Codex's own figure.
 */
export function renderCodexStatusline(state: CodexStatuslineState | undefined, sessionUsd?: number, nowMs = Date.now()): UiNode | null {
  if (!state || typeof state !== "object") return null;
  const items: UiNode[] = [];
  const text = (s: string, color?: Color): UiNode => ({ type: "text", ...(color ? { props: { color } } : {}), children: [s] });

  const ctx = state.thread?.usage?.context;
  const used = ctx?.used_tokens, size = ctx?.context_window_size;
  if (positive(used)) {
    const pct = finite(ctx?.used_percentage) ? ctx!.used_percentage! : positive(size) ? (used / size) * 100 : undefined;
    const of = positive(size) ? ` of ${formatTokens(size)}` : "";
    const share = pct !== undefined ? ` (${Math.round(pct)}%)` : "";
    items.push(text(`context ${formatTokens(used)}${of}${share}${pct !== undefined && pct >= 70 ? " ⚠" : ""}`, pct !== undefined && pct >= 70 ? "yellow" : "status-usage"));
  }

  const own = state.thread?.usage?.cost?.total_cost_usd;
  const usd = positive(sessionUsd) ? sessionUsd : (snapshotUsd(state, nowMs) ?? (positive(own) ? own : undefined));
  if (usd !== undefined && usd >= 0.005) items.push(text(`${dollars(usd)} this session`, "status-usage"));

  const windows: string[] = [];
  let worst = 0;
  for (const rl of state.account?.rate_limits ?? []) {
    if (rl?.limit_id !== undefined && rl.limit_id !== "codex") continue;
    for (const w of [rl?.primary_limit, rl?.secondary_limit]) {
      if (!w || !finite(w.used_percent) || w.used_percent < 0) continue;
      const name = windowName(w.window_minutes);
      if (!name) continue;
      const pct = Math.round(w.used_percent);
      worst = Math.max(worst, pct);
      // Near the end of a window, when it comes back is what the person needs.
      const back = pct >= 80 && finite(w.resets_at) ? resetClock(w.resets_at, nowMs) : undefined;
      windows.push(`${name} ${pct}%${back ? ` (resets ${back})` : ""}`);
    }
  }
  if (windows.length) items.push(text(`limits: ${windows.join(", ")}`, worst >= 90 ? "red" : worst >= 70 ? "yellow" : "status-limit"));

  return items.length ? { type: "row", props: { gap: 3 }, children: items } : null;
}

// -- The session's price, off the main thread ------------------------------------

/** UUIDv7 thread ids carry their creation time: the rollout's day folder. */
function threadBorn(id: string): number | undefined {
  const m = /^([0-9a-f]{8})-([0-9a-f]{4})-7/i.exec(id);
  if (!m) return undefined;
  const ms = parseInt(m[1] + m[2], 16);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * The rollout of a Codex thread: `sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`
 * in the day folders around the time its id was made (local and UTC), then
 * the archive, then every session folder.
 */
export function rolloutFor(threadId: string, home = homedir()): string | undefined {
  if (!/^[0-9a-f-]{8,64}$/i.test(threadId)) return undefined;
  const suffix = `-${threadId}.jsonl`;
  const root = codexSessionsRoot(home);
  const look = (dir: string): string | undefined => {
    try {
      const f = readdirSync(dir).find((n) => n.startsWith("rollout-") && n.endsWith(suffix));
      return f ? join(dir, f) : undefined;
    } catch {
      return undefined;
    }
  };
  const born = threadBorn(threadId);
  if (born !== undefined) {
    const days = new Set<string>();
    for (const shift of [0, -86_400_000, 86_400_000]) {
      const d = new Date(born + shift);
      days.add(join(String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")));
      days.add(join(String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0")));
    }
    for (const day of days) {
      const hit = look(join(root, day));
      if (hit) return hit;
    }
  }
  const archived = look(join(codexDir(home), "archived_sessions"));
  if (archived) return archived;
  if (!existsSync(root)) return undefined;
  return rolloutFiles(root, 0).find((f) => f.endsWith(suffix));
}

/** The worker side: prices a thread's session on request (sessionprice.ts), one at a time. */
export async function servePriceWorker(): Promise<void> {
  const { parentPort } = await import("node:worker_threads");
  const { sessionTotal } = await import("./sessionprice.js");
  if (!parentPort) return;
  const paths = new Map<string, string>();
  parentPort.on("message", (m: { id: number; thread: string }) => {
    let reply: { id: number; usd?: number } = { id: m.id };
    try {
      const file = paths.get(m.thread) ?? rolloutFor(m.thread);
      if (file) {
        paths.set(m.thread, file);
        const t = sessionTotal({ sessionId: m.thread, transcript: file });
        // Codex's entries are read whole on a change, so there is nothing to keep (saveIfWorthIt).
        if (finite(t.usd)) reply = { id: m.id, usd: t.usd };
      }
    } catch { /* unpriced this time */ }
    parentPort.postMessage(reply);
  });
}

interface Priced { usd?: number; at: number; key: string; tookMs: number }

/**
 * One per server process: what each thread's session has cost, kept, and
 * the worker that reads it. `spawn` starts the worker (mcp.ts knows the
 * file it runs from); undefined, or a worker that fails, leaves the
 * snapshot's own figures.
 */
export class CodexStatusline {
  private worker: Worker | undefined;
  private broken = false;
  private next = 1;
  private waiting = new Map<number, (usd: number | undefined) => void>();
  private inFlight = new Map<string, Promise<void>>();
  private prices = new Map<string, Priced>();
  private lastGood = new Map<string, string>();

  constructor(private spawn?: () => Worker) {}

  private ask(thread: string): Promise<number | undefined> {
    if (!this.worker && !this.broken && this.spawn) {
      try {
        const w = this.spawn();
        w.unref();
        w.on("message", (r: { id: number; usd?: number }) => {
          const done = this.waiting.get(r?.id);
          this.waiting.delete(r?.id);
          done?.(finite(r?.usd) ? r.usd : undefined);
        });
        const fail = () => {
          this.broken = true;
          this.worker = undefined;
          for (const done of this.waiting.values()) done(undefined);
          this.waiting.clear();
        };
        w.on("error", fail);
        w.on("exit", fail);
        this.worker = w;
      } catch {
        this.broken = true;
      }
    }
    const w = this.worker;
    if (!w) return Promise.resolve(undefined);
    const id = this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      // A worker that never answers frees the thread for the next try.
      setTimeout(() => {
        if (this.waiting.delete(id)) resolve(undefined);
      }, ASK_TIMEOUT_MS).unref();
      w.postMessage({ id, thread });
    });
  }

  /** The thread's session price: cached, refreshed in the background, waited for at most `budgetMs`. */
  private async price(thread: string, key: string, budgetMs: number, now: number): Promise<number | undefined> {
    const have = this.prices.get(thread);
    const gap = Math.max(PRICE_MIN_GAP_MS, (have?.tookMs ?? 0) * 10);
    const due = !have || ((have.key !== key || now - have.at >= PRICE_TTL_MS) && now - have.at >= gap);
    if (due && !this.inFlight.has(thread)) {
      const started = Date.now();
      const run = this.ask(thread).then((usd) => {
        this.prices.set(thread, { usd: usd ?? have?.usd, at: Date.now(), key, tookMs: Date.now() - started });
        this.inFlight.delete(thread);
      });
      this.inFlight.set(thread, run);
    }
    const pending = this.inFlight.get(thread);
    if (pending && !have) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([pending, new Promise<void>((r) => { timer = setTimeout(r, budgetMs); })]);
      clearTimeout(timer);
    }
    return this.prices.get(thread)?.usd;
  }

  /**
   * The resource's text for one read: a UI tree's JSON, or "null". Never
   * throws and answers within about `budgetMs`: a failure answers the last
   * line drawn for the thread.
   */
  async read(rawState: unknown, budgetMs = READ_BUDGET_MS): Promise<string> {
    const state = (rawState && typeof rawState === "object" ? rawState : undefined) as CodexStatuslineState | undefined;
    const thread = typeof state?.thread?.id === "string" ? state.thread.id : "";
    try {
      const t = state?.thread?.usage?.total;
      const key = t ? `${t.total_input_tokens}/${t.output_tokens}` : "";
      const usd = thread && this.spawn ? await this.price(thread, key, budgetMs, Date.now()) : undefined;
      const json = JSON.stringify(renderCodexStatusline(state, usd));
      if (!measureTree(json).ok) return this.lastGood.get(thread) ?? "null";
      this.lastGood.set(thread, json);
      return json;
    } catch {
      return this.lastGood.get(thread) ?? "null";
    }
  }

  /** Stops the worker (tests). */
  async close(): Promise<void> {
    const w = this.worker;
    this.worker = undefined;
    this.broken = true;
    if (w) await w.terminate();
  }
}
