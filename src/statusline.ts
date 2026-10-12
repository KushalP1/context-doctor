/**
 * `context-doctor statusline` — live context health in Claude Code's status bar.
 *
 * Claude Code's `statusLine` setting runs a command on every refresh and shows
 * its first line of stdout. That is "context health where the work happens"
 * without an editor extension: the number that matters, visible while typing.
 *
 * It has to be fast and silent. Fast: the status payload on stdin carries the
 * live context size in recent versions; when it does not, only the tail of the
 * transcript is read (last 256KB, ~1ms on a 20MB file). Silent: any failure
 * prints nothing at all, because a status line that shows an error is worse
 * than one that shows nothing.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { contextWindowFor, formatTokens } from "./tokens.js";
import { formatUsd } from "./pricing.js";

/** The parts of Claude Code's status payload this reads. All optional. */
interface StatusInput {
  transcript_path?: string;
  model?: { id?: string; display_name?: string };
  cost?: { total_cost_usd?: number };
  context_window?: {
    /** Not read: stale after /compact (and a running total in some versions). */
    total_input_tokens?: number;
    context_window_size?: number;
    /** The last request's usage; null right after /compact, /clear and in a new session. */
    current_usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null;
  };
}

interface LiveUsage {
  tokens: number;
  cacheShare?: number;
  model?: string;
}

/** Newest assistant usage from the END of a transcript, without reading the file. */
export function tailUsage(path: string, tailBytes = 256 * 1024): LiveUsage | undefined {
  try {
    const size = statSync(path).size;
    const n = Math.min(size, tailBytes);
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(n);
    try {
      readSync(fd, buf, 0, n, size - n);
    } finally {
      closeSync(fd);
    }
    for (const line of buf.toString("utf8").split("\n").reverse()) {
      let entry: { type?: string; subtype?: string; isCompactSummary?: boolean; isSidechain?: boolean; message?: { usage?: Record<string, number>; model?: string } };
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // the first line of a tail is usually a partial one
      }
      // Compacted since the last reply: that reply's usage is the context
      // BEFORE the compaction, and the new size is unknown until the next one.
      if ((entry.type === "system" && entry.subtype === "compact_boundary") || entry.isCompactSummary) return undefined;
      // A subagent's usage describes its own context window, not this one.
      if (entry.isSidechain) continue;
      const usage = entry.type === "assistant" ? entry.message?.usage : undefined;
      if (!usage) continue;
      const read = usage.cache_read_input_tokens ?? 0;
      const tokens = (usage.input_tokens ?? 0) + read + (usage.cache_creation_input_tokens ?? 0);
      if (tokens > 0) return { tokens, cacheShare: read / tokens, model: entry.message?.model };
    }
  } catch {
    /* unreadable: the caller shows nothing */
  }
  return undefined;
}

/** Ten-cell bar; the visual half of the number. */
function bar(pct: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return "▮".repeat(filled) + "░".repeat(10 - filled);
}

/** Build the status line, or null when there is nothing trustworthy to show. */
export function renderStatusLine(input: StatusInput): string | null {
  let live: LiveUsage | undefined;
  const cw = input.context_window;
  // Only current_usage is the context. total_input_tokens is a running total
  // in some Claude Code versions and the last response's figure in others;
  // either way it outlives a /compact (current_usage is null until the next
  // reply), and it was shown as "ctx 187k/200k 94% ⚠" over an emptied window.
  // So it is never a fallback.
  const cu = cw?.current_usage;
  const fromPayload = cu ? (cu.input_tokens ?? 0) + (cu.cache_read_input_tokens ?? 0) + (cu.cache_creation_input_tokens ?? 0) : 0;
  if (cu && fromPayload > 0) {
    const read = cu.cache_read_input_tokens;
    live = { tokens: fromPayload, cacheShare: read !== undefined ? read / fromPayload : undefined, model: input.model?.id };
  } else if (input.transcript_path) {
    live = tailUsage(input.transcript_path);
  }

  const parts: string[] = [];
  if (live) {
    const window = cw?.context_window_size ?? contextWindowFor(live.model ?? input.model?.id);
    if (window) {
      const pct = (live.tokens / window) * 100;
      parts.push(`ctx ${formatTokens(live.tokens)}/${formatTokens(window)} ${bar(pct)} ${pct.toFixed(0)}%${pct >= 70 ? " ⚠" : ""}`);
    } else {
      parts.push(`ctx ${formatTokens(live.tokens)}`);
    }
    if (live.cacheShare !== undefined) parts.push(`cache ${Math.round(live.cacheShare * 100)}%`);
  }
  // The session's cost is true whatever the context is; show it on its own.
  if (input.cost?.total_cost_usd && input.cost.total_cost_usd > 0) parts.push(formatUsd(input.cost.total_cost_usd));
  return parts.length > 0 ? parts.join(" · ") : null;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function runStatusLine(): Promise<void> {
  try {
    const input = JSON.parse(await readStdin()) as StatusInput;
    const line = renderStatusLine(input);
    if (line) console.log(line);
  } catch {
    /* silent by design */
  }
}
