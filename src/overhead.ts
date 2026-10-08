/**
 * `context-doctor overhead`: what every request pays before you type.
 *
 * Each request an agent sends re-sends the same front matter: the harness's
 * system prompt, tool and MCP schemas, skills, and the memory files the user
 * wrote (CLAUDE.md and its imports, rules, auto memory, AGENTS.md, Cursor
 * rules, GEMINI.md). It is cached, so each read is cheap, but it is read on
 * every request of every session, and at full write price after every cold
 * start. Nobody sees it: transcripts do not contain it.
 *
 * Two measurements, both local:
 *  - the fixed overhead itself, from the first request of each Claude Code
 *    session (the API's own count, minus the first user message);
 *  - the memory files that load in a directory, sized with Claude's ratios and
 *    priced per month from the user's own request and cold-start counts.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { forEachLine, listSessions } from "./session.js";
import { estimateTokens, formatTokens } from "./tokens.js";
import { formatUsd, pricingFor } from "./pricing.js";

export type Agent = "Claude Code" | "Codex" | "Cursor" | "Gemini CLI";

export interface MemoryFile {
  agent: Agent;
  path: string;
  tokens: number;
  /** Why it loads: "project", "user", "import", "rules", "auto memory". */
  via: string;
}

export interface OverheadFinding {
  severity: "warn" | "info";
  message: string;
  suggestion: string;
}

export interface Baseline {
  sessions: number;
  /** Median tokens of the first request, minus the first user message. */
  median: number;
  p90: number;
  requests: number;
  coldStarts: number;
  days: number;
  model?: string;
  /** USD a month for each 1,000 tokens of fixed overhead, at this usage. */
  usdPerKPerMonth?: number;
}

export interface OverheadReport {
  cwd: string;
  baseline?: Baseline;
  files: MemoryFile[];
  findings: OverheadFinding[];
  mcpServers: string[];
}

const TTL_MS = 3_600_000;
const CLAUDE = "claude-opus-5"; // Claude's tokenizer ratios; the model only picks the provider here.

function readText(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Directories from `cwd` up to (and including) the filesystem root. */
function ancestors(cwd: string): string[] {
  const out: string[] = [];
  let d = resolve(cwd);
  for (;;) {
    out.push(d);
    const up = dirname(d);
    if (up === d) return out;
    d = up;
  }
}

function mdFiles(dir: string, ext = /\.md$/): string[] {
  const out: string[] = [];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...mdFiles(p, ext));
      else if (ext.test(e.name)) out.push(p);
    }
  } catch {
    /* absent */
  }
  return out.sort();
}

/** `@path` imports in a CLAUDE.md, outside code spans and fences, resolved relative to the file. */
function imports(text: string, from: string, home: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    for (const m of line.replace(/`[^`]*`/g, "").matchAll(/(?:^|\s)@((?:~\/|\.{0,2}\/|[\w.-]+\/)[^\s)]+|[\w.-]+\.\w+)/g)) {
      const raw = m[1];
      out.push(raw.startsWith("~/") ? join(home, raw.slice(2)) : isAbsolute(raw) ? raw : resolve(dirname(from), raw));
    }
  }
  return out;
}

/** Claude Code's auto-memory index for a directory (it loads MEMORY.md, first 200 lines). */
function autoMemoryPath(cwd: string, home: string): string {
  return join(home, ".claude", "projects", resolve(cwd).replace(/[^A-Za-z0-9]/g, "-"), "memory", "MEMORY.md");
}

/** Every memory file the four agents load for a session started in `cwd`. */
export function findMemoryFiles(cwd = process.cwd(), home = homedir()): MemoryFile[] {
  const files: MemoryFile[] = [];
  const seen = new Set<string>();
  const add = (agent: Agent, path: string, via: string, text?: string) => {
    const key = `${agent}:${resolve(path)}`;
    if (seen.has(key)) return undefined;
    text ??= readText(path);
    if (text === undefined || !text.trim()) return undefined;
    seen.add(key);
    files.push({ agent, path, via, tokens: estimateTokens(text, CLAUDE) });
    return text;
  };
  const addClaude = (path: string, via: string, depth = 0) => {
    const text = add("Claude Code", path, via);
    if (text === undefined || depth >= 4) return;
    for (const p of imports(text, path, home)) addClaude(p, "import", depth + 1);
  };

  // Claude Code: user memory and rules, then each directory from the root down.
  addClaude(join(home, ".claude", "CLAUDE.md"), "user");
  for (const p of mdFiles(join(home, ".claude", "rules"))) addClaude(p, "rules");
  for (const d of ancestors(cwd).reverse()) {
    addClaude(join(d, "CLAUDE.md"), "project");
    addClaude(join(d, ".claude", "CLAUDE.md"), "project");
    addClaude(join(d, "CLAUDE.local.md"), "project (local)");
    if (d !== home) for (const p of mdFiles(join(d, ".claude", "rules"))) addClaude(p, "rules");
  }
  const auto = readText(autoMemoryPath(cwd, home));
  if (auto) add("Claude Code", autoMemoryPath(cwd, home), "auto memory", auto.split("\n").slice(0, 200).join("\n"));

  // Codex: global AGENTS.md, then each directory down to cwd (it stops at the git root; root-ward extras are rare).
  add("Codex", join(home, ".codex", "AGENTS.md"), "user");
  for (const d of ancestors(cwd).reverse()) {
    if (d === home) continue;
    add("Codex", join(d, "AGENTS.override.md"), "project") ?? add("Codex", join(d, "AGENTS.md"), "project");
  }

  // Cursor: legacy .cursorrules and always-applied project rules.
  add("Cursor", join(cwd, ".cursorrules"), "project");
  for (const p of mdFiles(join(cwd, ".cursor", "rules"), /\.mdc?$/)) {
    const text = readText(p) ?? "";
    if (/^alwaysApply:\s*true/m.test(text)) add("Cursor", p, "rules (always)", text);
  }

  // Gemini CLI: global, then each directory down to cwd.
  add("Gemini CLI", join(home, ".gemini", "GEMINI.md"), "user");
  for (const d of ancestors(cwd).reverse()) if (d !== home) add("Gemini CLI", join(d, "GEMINI.md"), "project");
  return files;
}

/**
 * Fixed overhead per session, measured: the first main-chain request's input
 * (input + cache read + cache write) minus the first user message, plus the
 * request and cold-start counts that turn tokens into a monthly bill.
 */
export function measureBaseline(days = 30, paths?: string[]): Baseline | undefined {
  const since = Date.now() - days * 86_400_000;
  const files = paths ?? listSessions(10_000).filter((s) => s.path.includes(".claude") && s.modifiedAt.getTime() >= since).map((s) => s.path);
  const firsts: number[] = [];
  let requests = 0, coldStarts = 0;
  const models = new Map<string, number>();
  for (const path of files) {
    let firstUser: string | undefined;
    let first: number | undefined;
    let lastId: string | undefined;
    let prevAt: number | undefined;
    forEachLine(path, (line) => {
      let e: any;
      try { e = JSON.parse(line); } catch { return; }
      if (!e || e.isSidechain) return;
      if (e.type === "user" && first === undefined && firstUser === undefined && !e.isMeta) {
        const c = e.message?.content;
        const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n") : "";
        if (text) firstUser = text;
        return;
      }
      if (e.type !== "assistant" || !e.message?.usage || e.message.id === lastId) return;
      lastId = e.message.id;
      const u = e.message.usage;
      const prompt = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      const at = Date.parse(e.timestamp);
      if (!(prompt > 0) || !Number.isFinite(at)) return;
      if (first === undefined) first = Math.max(0, prompt - estimateTokens(firstUser ?? "", CLAUDE));
      if (at >= since) {
        requests++;
        if (prevAt === undefined || at - prevAt > TTL_MS) coldStarts++;
        if (e.message.model) models.set(e.message.model, (models.get(e.message.model) ?? 0) + 1);
      }
      prevAt = at;
    });
    if (first !== undefined && first > 1000) firsts.push(first);
  }
  if (firsts.length === 0) return undefined;
  firsts.sort((a, b) => a - b);
  const model = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const price = pricingFor(model);
  // Each overhead token is a cache read on warm requests and a cache write
  // (1.25x input) after every cold start.
  const usdPerKPerMonth = price
    ? ((1000 * ((requests - coldStarts) * price.cacheReadPerM + coldStarts * 1.25 * price.inputPerM)) / 1e6) * (30 / days)
    : undefined;
  return {
    sessions: firsts.length,
    median: firsts[Math.floor(firsts.length / 2)],
    p90: firsts[Math.min(firsts.length - 1, Math.floor(firsts.length * 0.9))],
    requests,
    coldStarts,
    days,
    model,
    usdPerKPerMonth,
  };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** What is worth changing in the memory files. */
export function overheadFindings(files: MemoryFile[], baseline?: Baseline): OverheadFinding[] {
  const out: OverheadFinding[] = [];
  const cost = (tok: number) => (baseline?.usdPerKPerMonth ? ` (~${formatUsd((tok / 1000) * baseline.usdPerKPerMonth)}/month at your usage)` : "");
  for (const f of files) {
    if (f.tokens >= 2000) {
      out.push({
        severity: f.tokens >= 5000 ? "warn" : "info",
        message: `${f.path} is ~${formatTokens(f.tokens)} tokens, read on every ${f.agent} request${f.agent === "Claude Code" ? cost(f.tokens) : ""}.`,
        suggestion: "Keep rules the agent needs on most requests; move reference material into files it reads when relevant (link them by path, not @import).",
      });
    }
  }
  // Paragraphs repeated across files of the same agent load twice.
  const byPara = new Map<string, Set<string>>();
  for (const f of files) {
    const text = readText(f.path) ?? "";
    for (const p of text.split(/\n\s*\n/)) {
      const n = normalize(p);
      if (n.length < 120) continue;
      const k = `${f.agent}\u0000${n}`;
      (byPara.get(k) ?? byPara.set(k, new Set()).get(k)!).add(f.path);
    }
  }
  const dup = new Map<string, { tokens: number; count: number }>();
  for (const [k, set] of byPara) {
    if (set.size < 2) continue;
    const key = [...set].sort().join(" + ");
    const d = dup.get(key) ?? { tokens: 0, count: 0 };
    d.tokens += estimateTokens(k.split("\u0000")[1], CLAUDE) * (set.size - 1);
    d.count++;
    dup.set(key, d);
  }
  for (const [key, d] of dup) {
    out.push({
      severity: "info",
      message: `${d.count} paragraph(s) appear in more than one loaded file (${key}): ~${formatTokens(d.tokens)} tokens read twice.`,
      suggestion: "Keep each rule in one file.",
    });
  }
  // Big fenced blocks: examples and reference code rarely need to ride on every request.
  for (const f of files) {
    const text = readText(f.path) ?? "";
    let total = 0;
    for (const m of text.matchAll(/```[\s\S]*?```/g)) total += estimateTokens(m[0], CLAUDE);
    if (total >= 800) {
      out.push({
        severity: "info",
        message: `${f.path} carries ~${formatTokens(total)} tokens of code blocks.`,
        suggestion: "Move long examples to a file the agent opens when the task needs them.",
      });
    }
  }
  return out;
}

/** MCP servers Claude Code starts in `cwd`: user scope, project scope (~/.claude.json) and .mcp.json. */
export function claudeMcpServers(cwd = process.cwd(), home = homedir()): string[] {
  const names = new Set<string>();
  try {
    const cfg = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    for (const n of Object.keys(cfg.mcpServers ?? {})) names.add(n);
    for (const n of Object.keys(cfg.projects?.[resolve(cwd)]?.mcpServers ?? {})) names.add(n);
  } catch {
    /* absent */
  }
  try {
    for (const n of Object.keys(JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8")).mcpServers ?? {})) names.add(n);
  } catch {
    /* absent */
  }
  return [...names].sort();
}

export function overheadReport(opts: { cwd?: string; home?: string; days?: number; paths?: string[] } = {}): OverheadReport {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const files = findMemoryFiles(cwd, home);
  const baseline = measureBaseline(opts.days ?? 30, opts.paths);
  return { cwd, baseline, files, findings: overheadFindings(files, baseline), mcpServers: claudeMcpServers(cwd, home) };
}

export function renderOverhead(r: OverheadReport, home = homedir()): string {
  const out: string[] = [];
  const short = (p: string) => (p.startsWith(home) ? "~" + p.slice(home.length) : relative(r.cwd, p) || p);
  out.push("FIXED OVERHEAD: what every request re-reads before your message", "═".repeat(56));
  const b = r.baseline;
  const claudeTokens = r.files.filter((f) => f.agent === "Claude Code").reduce((s, f) => s + f.tokens, 0);
  if (b) {
    out.push(
      `Claude Code, last ${b.days} days: ${b.sessions} sessions start at a median ~${formatTokens(b.median)} tokens (p90 ~${formatTokens(b.p90)}) before the first message.`,
      `Memory files loaded here are ~${formatTokens(claudeTokens)} of that; the rest is Claude Code's system prompt, tools, skills and MCP schemas.`
    );
    if (b.usdPerKPerMonth !== undefined) {
      out.push(
        `At your usage (${b.requests.toLocaleString("en-US")} requests, ${b.coldStarts.toLocaleString("en-US")} cold starts, ${b.model} list prices) every 1k tokens of it costs ~${formatUsd(b.usdPerKPerMonth)} a month;`,
        `the whole overhead ~${formatUsd((b.median / 1000) * b.usdPerKPerMonth)} a month.`
      );
    }
  } else {
    out.push("No Claude Code sessions in the period to measure; memory files are sized below.");
  }
  if (r.mcpServers.length) out.push(`MCP servers configured for Claude Code here: ${r.mcpServers.join(", ")} (their tool schemas are part of the rest).`);
  out.push("", "Memory files loaded in this directory", "─".repeat(56));
  if (r.files.length === 0) out.push("  none");
  for (const f of r.files) {
    const usd = f.agent === "Claude Code" && b?.usdPerKPerMonth !== undefined ? `  ${formatUsd((f.tokens / 1000) * b.usdPerKPerMonth)}/mo` : "";
    out.push(`  ${f.agent.padEnd(11)} ~${formatTokens(f.tokens).padStart(5)}${usd.padEnd(12)}  ${short(f.path)}${f.via === "project" ? "" : `  (${f.via})`}`);
  }
  out.push("", `Findings (${r.findings.length})`, "─".repeat(56));
  if (r.findings.length === 0) out.push("  Nothing to trim. The memory files are lean.");
  for (const f of r.findings) out.push(`${f.severity === "warn" ? "▲" : "ℹ"} ${f.message.replace(home, "~")}`, `   → ${f.suggestion}`);
  return out.join("\n");
}
