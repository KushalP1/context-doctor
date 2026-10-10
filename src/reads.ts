/**
 * `context-doctor reads`: the same files, read into session after session.
 *
 * Agents orient themselves by reading the same files at the start of most
 * sessions: the README, the main module, a config. Each read is written into
 * that session's context and re-read on every later request, and the next
 * session pays for it again. This counts Read calls across recent Claude Code
 * transcripts, groups them by file, and says per file whether a short summary
 * in the project's CLAUDE.md would pay (read in most of the project's
 * sessions) or not (CLAUDE.md is paid on every request, so an occasional read
 * is cheaper left as a read; `pack` can cut it to the part a question needs).
 */

import { forEachLine, listSessions } from "./session.js";
import { estimateTokens, formatTokens } from "./tokens.js";
import { formatUsd, pricingFor } from "./pricing.js";

const CLAUDE = "claude-opus-5";
/** An image in a tool result bills as an image (~1.6k tokens for a full-size screenshot), not as its base64. */
const IMAGE_TOKENS = 1600;

function resultTokens(content: unknown): number {
  if (typeof content === "string") return estimateTokens(content, CLAUDE);
  if (!Array.isArray(content)) return estimateTokens(JSON.stringify(content ?? ""), CLAUDE);
  let n = 0;
  for (const part of content as Array<Record<string, unknown>>) {
    if (part?.type === "image") n += IMAGE_TOKENS;
    else if (typeof part?.text === "string") n += estimateTokens(part.text, CLAUDE);
    else n += estimateTokens(JSON.stringify(part ?? ""), CLAUDE);
  }
  return n;
}

export interface RepeatedRead {
  path: string;
  project: string;
  /** Sessions that read it at least once. */
  sessions: number;
  /** Sessions of that project in the period. */
  projectSessions: number;
  reads: number;
  /** Tokens of all its results, summed over every read. */
  tokens: number;
  /** Floor of the cost: each read written to the prompt cache once (1.25x input). */
  usd?: number;
  advice: "summarize" | "pack";
}

export interface ReadsReport {
  days: number;
  sessions: number;
  reads: number;
  readTokens: number;
  files: RepeatedRead[];
}

/** Read calls in one transcript: path -> {reads, tokens}, plus the session's model and project directory. */
function sessionReads(path: string): { cwd?: string; model?: string; files: Map<string, { reads: number; tokens: number }> } {
  const pending = new Map<string, string>();
  const files = new Map<string, { reads: number; tokens: number }>();
  let cwd: string | undefined;
  let model: string | undefined;
  forEachLine(path, (line) => {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"') && cwd !== undefined) return;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (!e || e.isSidechain) return;
    if (!cwd && typeof e.cwd === "string") cwd = e.cwd;
    const content = e.message?.content;
    if (!Array.isArray(content)) return;
    if (e.type === "assistant") {
      if (typeof e.message.model === "string") model = e.message.model;
      for (const b of content) {
        if (b?.type === "tool_use" && b.name === "Read" && typeof b.input?.file_path === "string") pending.set(b.id, b.input.file_path);
      }
    } else if (e.type === "user") {
      for (const b of content) {
        if (b?.type !== "tool_result") continue;
        const file = pending.get(b.tool_use_id);
        if (!file) continue;
        pending.delete(b.tool_use_id);
        const f = files.get(file) ?? { reads: 0, tokens: 0 };
        f.reads++;
        f.tokens += resultTokens(b.content);
        files.set(file, f);
      }
    }
  });
  return { cwd, model, files };
}

export function repeatedReads(days = 30, paths?: string[], minSessions = 3): ReadsReport {
  const since = Date.now() - days * 86_400_000;
  const list = paths ?? listSessions(10_000).filter((s) => s.path.includes(".claude") && s.modifiedAt.getTime() >= since).map((s) => s.path);
  const byFile = new Map<string, { project: string; sessions: number; reads: number; tokens: number; usd: number; priced: boolean }>();
  const projectSessions = new Map<string, number>();
  let reads = 0, readTokens = 0;
  for (const p of list) {
    const s = sessionReads(p);
    const project = s.cwd ?? "?";
    projectSessions.set(project, (projectSessions.get(project) ?? 0) + 1);
    const price = pricingFor(s.model);
    for (const [file, f] of s.files) {
      reads += f.reads;
      readTokens += f.tokens;
      const agg = byFile.get(file) ?? { project, sessions: 0, reads: 0, tokens: 0, usd: 0, priced: false };
      agg.sessions++;
      agg.reads += f.reads;
      agg.tokens += f.tokens;
      if (price) {
        agg.usd += (f.tokens * 1.25 * price.inputPerM) / 1e6;
        agg.priced = true;
      }
      byFile.set(file, agg);
    }
  }
  const files: RepeatedRead[] = [...byFile.entries()]
    .filter(([, a]) => a.sessions >= minSessions)
    .map(([path, a]) => {
      const ps = projectSessions.get(a.project) ?? a.sessions;
      return {
        path,
        project: a.project,
        sessions: a.sessions,
        projectSessions: ps,
        reads: a.reads,
        tokens: a.tokens,
        usd: a.priced ? a.usd : undefined,
        // In most of the project's sessions: a summary in CLAUDE.md is read anyway, so it replaces the reads.
        advice: a.sessions / ps >= 0.5 ? ("summarize" as const) : ("pack" as const),
      };
    })
    .sort((a, b) => b.tokens - a.tokens);
  return { days, sessions: list.length, reads, readTokens, files };
}

export function renderReads(r: ReadsReport, limit = 15, home = process.env.HOME ?? ""): string {
  const short = (p: string) => (home && p.startsWith(home) ? "~" + p.slice(home.length) : p);
  const out = ["FILES READ INTO SESSION AFTER SESSION", "═".repeat(56)];
  out.push(`Claude Code, last ${r.days} days: ${r.reads.toLocaleString("en-US")} file reads across ${r.sessions} sessions, ~${formatTokens(r.readTokens)} tokens.`);
  if (r.files.length === 0) {
    out.push("No file was read in 3 or more sessions. Nothing to consolidate.");
    return out.join("\n");
  }
  const repeated = r.files.reduce((s, f) => s + f.tokens, 0);
  out.push(`${r.files.length} files were read in 3+ sessions: ~${formatTokens(repeated)} tokens of reads (${Math.round((repeated / Math.max(1, r.readTokens)) * 100)}% of all read tokens).`, "");
  for (const f of r.files.slice(0, limit)) {
    const usd = f.usd !== undefined ? `  ≥${formatUsd(f.usd)}` : "";
    out.push(`  ${String(f.sessions).padStart(3)}/${f.projectSessions} sessions  ${String(f.reads).padStart(4)} reads  ~${formatTokens(f.tokens).padStart(6)}${usd.padEnd(10)}  ${short(f.path)}`);
  }
  if (r.files.length > limit) out.push(`  … ${r.files.length - limit} more (--json for all)`);
  const summarize = r.files.filter((f) => f.advice === "summarize").slice(0, 5);
  out.push("");
  if (summarize.length) {
    out.push(
      `Read in most of their project's sessions: ${summarize.map((f) => short(f.path)).join(", ")}.`,
      "   → A few lines in that project's CLAUDE.md saying what sessions need from each file replace most of these reads (CLAUDE.md is read on every request, so keep it to what is needed each time)."
    );
  }
  out.push("   → For the rest, read the part a task needs: `pack_context` (MCP) or `context-doctor pack <file> -q \"…\"` returns the relevant chunks with line ranges.");
  out.push("   (≥ = floor of the cost: each read written to the prompt cache once; every later request of that session re-reads it too.)");
  return out.join("\n");
}
