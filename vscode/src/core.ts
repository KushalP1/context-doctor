/**
 * The pure half of the extension: everything that can be tested without an
 * editor. Given a workspace folder, find the newest Claude Code transcript for
 * it and turn its last usage into the status bar text. No VS Code imports here.
 *
 * Deliberately self-contained rather than importing the context-doctor npm
 * package: an extension has to work on a machine that never ran
 * `npm i context-doctor`, and the two functions it needs are forty lines.
 */

import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Claude Code keys its per-project directory by the folder path with every non-alphanumeric turned into '-'. */
export function projectDirFor(workspaceFolder: string, home = homedir()): string {
  return join(home, ".claude", "projects", workspaceFolder.replace(/[^A-Za-z0-9-]/g, "-"));
}

/** The transcript most recently written to in a project directory, or undefined. */
export function newestTranscript(projectDir: string): string | undefined {
  if (!existsSync(projectDir)) return undefined;
  let best: { path: string; mtime: number } | undefined;
  for (const name of readdirSync(projectDir)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(projectDir, name);
    try {
      const mtime = statSync(path).mtimeMs;
      if (!best || mtime > best.mtime) best = { path, mtime };
    } catch {
      /* raced with a delete */
    }
  }
  return best?.path;
}

export interface LiveUsage {
  tokens: number;
  cacheShare?: number;
  model?: string;
}

/** Newest assistant usage from the END of a transcript (last 256KB, ~1ms on 20MB). */
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
      let entry: { type?: string; message?: { usage?: Record<string, number>; model?: string } };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const usage = entry.type === "assistant" ? entry.message?.usage : undefined;
      if (!usage) continue;
      const read = usage.cache_read_input_tokens ?? 0;
      const tokens = (usage.input_tokens ?? 0) + read + (usage.cache_creation_input_tokens ?? 0);
      if (tokens > 0) return { tokens, cacheShare: read / tokens, model: entry.message?.model };
    }
  } catch {
    /* unreadable */
  }
  return undefined;
}

/** Context windows by model family; matches context-doctor's table. */
export function contextWindowFor(model?: string): number | undefined {
  const m = (model ?? "").toLowerCase();
  if (!m) return undefined;
  if (m.includes("haiku")) return 200_000;
  if (m.includes("claude")) return 1_000_000;
  if (/gpt-4o|gpt-4\.1|gpt-5|^o\d/.test(m)) return m.includes("4.1") ? 1_000_000 : 128_000;
  if (m.includes("gemini")) return 1_000_000;
  return undefined;
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export interface StatusText {
  /** Short text for the status bar item. */
  text: string;
  /** Multi-line tooltip. */
  tooltip: string;
  /** True once the context passes the warning threshold. */
  warn: boolean;
  percent?: number;
}

export function statusFor(usage: LiveUsage, warnAtPercent: number): StatusText {
  const window = contextWindowFor(usage.model);
  const percent = window ? (usage.tokens / window) * 100 : undefined;
  const warn = percent !== undefined && percent >= warnAtPercent;
  const parts = [`ctx ${formatTokens(usage.tokens)}`];
  if (percent !== undefined) parts.push(`${percent.toFixed(0)}%`);
  if (usage.cacheShare !== undefined) parts.push(`cache ${Math.round(usage.cacheShare * 100)}%`);
  const tooltip = [
    `Claude Code context: ${usage.tokens.toLocaleString()} tokens${window ? ` of ${window.toLocaleString()} (${percent!.toFixed(1)}%)` : ""}`,
    usage.cacheShare !== undefined ? `Served from prompt cache: ${(usage.cacheShare * 100).toFixed(1)}%` : undefined,
    usage.model ? `Model: ${usage.model}` : undefined,
    warn ? `Above ${warnAtPercent}% of the window. Quality degrades before the hard limit; consider summarizing or a fresh session.` : undefined,
    "Click to profile this session with context-doctor.",
  ].filter(Boolean).join("\n");
  return { text: `$(pulse) ${parts.join(" · ")}${warn ? " $(warning)" : ""}`, tooltip, warn, percent };
}

/** One call that does the whole lookup for a workspace folder. */
export function statusForWorkspace(workspaceFolder: string, warnAtPercent: number, home = homedir()): { status?: StatusText; transcript?: string; reason?: string } {
  const dir = projectDirFor(workspaceFolder, home);
  const transcript = newestTranscript(dir);
  if (!transcript) return { reason: "no Claude Code session for this folder yet" };
  const usage = tailUsage(transcript);
  if (!usage) return { transcript, reason: "session has no API usage yet" };
  return { status: statusFor(usage, warnAtPercent), transcript };
}
