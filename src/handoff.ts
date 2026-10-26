/**
 * Handoffs: the only real cut a chat app allows.
 *
 * In Claude Desktop, claude.ai and ChatGPT nothing can edit a chat's history:
 * a model that summarizes a 30k paste stops quoting it, but the paste is
 * still re-read on every turn. Moving to a new chat is the cut. A handoff is
 * what the new chat starts from: a dense brief the HOST model writes in its
 * own turn (goal, decisions, current state, open items, key identifiers; no
 * API key here, the calling model does the language work) plus the few
 * blocks that must stay exact (code, config, numbers).
 *
 * This module stores and reads them; it imports nothing from the MCP SDK so
 * the CLI (`context-doctor handoff`) can use it too. Layout, one folder per
 * handoff, under the home directory (os.homedir(), so a sandboxed HOME or
 * USERPROFILE is respected):
 *
 *   ~/.context-doctor/handoffs/<yyyymmdd-hhmmss>-<slug>/handoff.md
 *   ~/.context-doctor/handoffs/<yyyymmdd-hhmmss>-<slug>/meta.json
 *
 * Folders are 0700 and files 0600: a handoff holds chat content. Secret-looking
 * strings are masked before anything is written, and the caller is told.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { estimateTokens, formatTokens } from "./tokens.js";
import { formatUsd, inputCostUsd, pricingFor } from "./pricing.js";
import { exchangeTokens } from "./sketch.js";

/** Bounds on what a handoff may hold. The brief's target is ≤400 tokens; the cap is a hard stop. */
export const HANDOFF_LIMITS = {
  briefTargetTokens: 400,
  briefChars: 6_000,
  titleChars: 80,
  blocks: 20,
  labelChars: 80,
  blockChars: 20_000,
  totalChars: 60_000,
  /** Newest handoffs kept on disk; older ones are removed when a new one is saved. */
  kept: 100,
  /** Largest handoff.md read back (a hand-edited file could be anything). */
  readBytes: 512 * 1024,
} as const;

export interface VerbatimBlock {
  label: string;
  text: string;
}

export interface HandoffInput {
  brief: string;
  verbatim?: VerbatimBlock[];
  title?: string;
  model?: string;
  /** The current chat's size, when the model has a profile_context figure. */
  chatTokens?: number;
  /** Exchanges so far, for an estimate when there is no figure. */
  turns?: number;
}

export interface HandoffMeta {
  id: string;
  title: string;
  /** ISO timestamp. */
  created: string;
  model?: string;
  /** The whole handoff.md, i.e. what a new chat starts with. */
  tokens: number;
  briefTokens: number;
  blocks: Array<{ label: string; tokens: number }>;
  /** Secret-looking strings replaced before saving. */
  masked: number;
}

export interface HandoffMath {
  /** Tokens the current chat re-reads per turn, when known. */
  now?: number;
  nowSource?: "given" | "turns";
  /** Tokens a new chat starting from the handoff re-reads. */
  after: number;
  nowUsd?: number;
  afterUsd?: number;
  nowCachedUsd?: number;
  afterCachedUsd?: number;
}

export interface SavedHandoff {
  meta: HandoffMeta;
  markdown: string;
  /** Folder it was written to; undefined when it was not stored. */
  dir?: string;
  maskedKinds: string[];
  math: HandoffMath;
  /** Folders removed to keep the newest HANDOFF_LIMITS.kept. */
  rotated: number;
}

/** ~/.context-doctor/handoffs, under whatever home this process has. */
export function handoffDir(home = homedir()): string {
  return join(home, ".context-doctor", "handoffs");
}

/** yyyymmdd-hhmmss-slug, optionally with a -n suffix for a second save in the same second. */
const ID_RE = /^\d{8}-\d{6}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isHandoffId(id: unknown): id is string {
  return typeof id === "string" && id.length <= 80 && ID_RE.test(id);
}

export function slugify(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || "handoff";
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** Problems with an input, or an empty list. Enforced here too, not only by the MCP schema. */
export function validateHandoff(input: HandoffInput): string[] {
  const errs: string[] = [];
  const L = HANDOFF_LIMITS;
  if (typeof input?.brief !== "string" || !input.brief.trim()) errs.push("`brief` is empty: write the handoff brief first.");
  else if (input.brief.length > L.briefChars) errs.push(`\`brief\` is ${input.brief.length} characters; the limit is ${L.briefChars} (aim for ≤${L.briefTargetTokens} tokens).`);
  if (input.title !== undefined && (typeof input.title !== "string" || input.title.length > L.titleChars)) errs.push(`\`title\` must be a string of at most ${L.titleChars} characters.`);
  const blocks = input.verbatim ?? [];
  if (!Array.isArray(blocks)) errs.push("`verbatim` must be a list of {label, text}.");
  else {
    if (blocks.length > L.blocks) errs.push(`${blocks.length} verbatim blocks; the limit is ${L.blocks}. Keep only what must stay exact.`);
    let total = typeof input.brief === "string" ? input.brief.length : 0;
    blocks.forEach((b, i) => {
      if (typeof b?.label !== "string" || !b.label.trim() || b.label.length > L.labelChars) errs.push(`verbatim[${i}].label must be 1-${L.labelChars} characters.`);
      if (typeof b?.text !== "string" || !b.text.trim()) errs.push(`verbatim[${i}].text is empty.`);
      else if (b.text.length > L.blockChars) errs.push(`verbatim[${i}] ("${String(b.label).slice(0, 40)}") is ${b.text.length} characters; the limit is ${L.blockChars}. Summarize it, or keep only the exact lines needed.`);
      else total += b.text.length;
    });
    if (total > L.totalChars) errs.push(`The handoff is ${total} characters; the limit is ${L.totalChars}. A handoff that big is not a cut.`);
  }
  for (const n of ["chatTokens", "turns"] as const) {
    const v = input[n];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100_000_000)) errs.push(`\`${n}\` must be a non-negative number.`);
  }
  return errs;
}

// Secret-looking strings: provider keys by their published prefixes, private
// keys, JWTs, and "password = <value>" style assignments whose value looks like
// a token (an env-var reference such as process.env.API_KEY is left alone).
const SECRET_PATTERNS: Array<[kind: string, re: RegExp, keepGroup?: boolean]> = [
  ["a private key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g],
  ["an Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["an OpenAI key", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g],
  ["an AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g],
  ["a GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ["a Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["an npm token", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["a Stripe key", /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g],
  ["a JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  [
    "a password or secret assignment",
    /\b((?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)["']?\s*[:=]\s*["']?)([A-Za-z0-9_\-+/=!@#$%^&*.]{12,})/gi,
    true,
  ],
];

/** Mask secret-looking strings. Returns the text, how many were masked, and of what kinds. */
export function maskSecrets(text: string): { text: string; count: number; kinds: string[] } {
  let count = 0;
  const kinds = new Set<string>();
  let out = text;
  for (const [kind, re, keep] of SECRET_PATTERNS) {
    out = out.replace(re, (...m: string[]) => {
      if (keep) {
        const value = m[2];
        // A value that is a word or a dotted reference (process.env.X) is not a secret.
        if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value) || /^[A-Za-z_][\w]*(?:\.[\w]+)+$/.test(value)) return m[0];
        count++;
        kinds.add(kind);
        return `${m[1]}[masked by context-doctor]`;
      }
      count++;
      kinds.add(kind);
      return `[${kind.replace(/^an? /, "")} masked by context-doctor]`;
    });
  }
  return { text: out, count, kinds: [...kinds] };
}

/** A code fence longer than any backtick run inside `text`, so the block cannot close early. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  return "`".repeat(Math.max(3, longest + 1));
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** The text a new chat starts from: what is attached, pasted or copied. */
export function renderHandoffMarkdown(title: string, created: string, brief: string, blocks: VerbatimBlock[]): string {
  const lines = [
    `# Handoff: ${title}`,
    "",
    `Continue from this handoff (written ${created.slice(0, 16).replace("T", " ")} UTC, saved by context-doctor). It replaces the earlier chat; ask for anything it does not cover.`,
    "",
    brief.trim(),
  ];
  if (blocks.length) {
    lines.push("", "## Verbatim (keep exact)");
    for (const b of blocks) {
      const fence = fenceFor(b.text);
      lines.push("", `### ${oneLine(b.label, HANDOFF_LIMITS.labelChars)}`, "", fence, b.text.replace(/\s+$/, ""), fence);
    }
  }
  return lines.join("\n") + "\n";
}

/** What the current chat costs per turn vs a new chat that starts from the handoff. */
export function handoffMath(handoffTokens: number, input: Pick<HandoffInput, "chatTokens" | "turns" | "model">): HandoffMath {
  const math: HandoffMath = { after: handoffTokens };
  if (input.chatTokens !== undefined && input.chatTokens > 0) {
    math.now = Math.round(input.chatTokens);
    math.nowSource = "given";
  } else if (input.turns !== undefined && input.turns > 0) {
    math.now = Math.round(input.turns) * exchangeTokens(input.model);
    math.nowSource = "turns";
  }
  const pricing = pricingFor(input.model);
  if (pricing) {
    math.afterUsd = inputCostUsd(math.after, pricing);
    math.afterCachedUsd = (math.after / 1_000_000) * pricing.cacheReadPerM;
    if (math.now !== undefined) {
      math.nowUsd = inputCostUsd(math.now, pricing);
      math.nowCachedUsd = (math.now / 1_000_000) * pricing.cacheReadPerM;
    }
  }
  return math;
}

/** "Now ~48k tokens re-read every turn … after ~600" lines, or a hint when the size is unknown. */
export function renderMath(m: HandoffMath): string {
  const price = (usd?: number, cached?: number) => (usd !== undefined ? ` (${formatUsd(usd)} at list price, ${formatUsd(cached ?? 0)} cached)` : "");
  if (m.now === undefined) {
    return `A new chat starts from ~${formatTokens(m.after)} tokens${price(m.afterUsd, m.afterCachedUsd)}, plus the app's own system prompt. Pass chat_tokens (from profile_context) to see the per-turn saving.`;
  }
  const est = m.nowSource === "turns" ? " (estimated from the turn count)" : "";
  const saved = Math.max(0, m.now - m.after);
  return [
    `Now: ~${formatTokens(m.now)} tokens re-read on every turn${est}${price(m.nowUsd, m.nowCachedUsd)}.`,
    `After: ~${formatTokens(m.after)} in a new chat${price(m.afterUsd, m.afterCachedUsd)}, plus the app's own system prompt, which every chat carries.`,
    `Saves ~${formatTokens(saved)} tokens per further turn${m.now > 0 ? ` (${Math.round((saved / m.now) * 100)}%)` : ""}; on a subscription that is usage limit.`,
  ].join("\n");
}

/** Every saved handoff, newest first. Entries that are not ours (bad name, symlink, no meta) are skipped. */
export function listHandoffs(home = homedir()): HandoffMeta[] {
  const dir = handoffDir(home);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const metas: HandoffMeta[] = [];
  for (const name of names) {
    if (!isHandoffId(name)) continue;
    const folder = join(dir, name);
    try {
      if (!lstatSync(folder).isDirectory()) continue;
      const meta = JSON.parse(readFileSync(join(folder, "meta.json"), "utf8")) as HandoffMeta;
      if (meta?.id !== name) continue;
      metas.push(meta);
    } catch {
      continue;
    }
  }
  return metas.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** `inner` is `root` itself or somewhere under it. */
function within(root: string, inner: string): boolean {
  const rel = relative(root, inner);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

/**
 * One handoff by id, or the newest for "latest". Undefined for anything that
 * is not a well-formed id of a saved handoff: no path from a caller (a
 * resource URI, a CLI argument) ever reaches the filesystem as given.
 */
export function readHandoff(idOrLatest: string, home = homedir()): { meta: HandoffMeta; markdown: string } | undefined {
  const id = idOrLatest === "latest" ? listHandoffs(home)[0]?.id : idOrLatest;
  if (!isHandoffId(id)) return undefined;
  const dir = handoffDir(home);
  const folder = join(dir, id);
  const file = join(folder, "handoff.md");
  if (!within(dir, file)) return undefined;
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > HANDOFF_LIMITS.readBytes || !lstatSync(folder).isDirectory()) return undefined;
    const meta = JSON.parse(readFileSync(join(folder, "meta.json"), "utf8")) as HandoffMeta;
    if (meta?.id !== id) return undefined;
    return { meta, markdown: readFileSync(file, "utf8") };
  } catch {
    return undefined;
  }
}

/** Keep the newest `kept` handoffs; remove older folders that are ours (named like one, with a meta.json). */
function rotate(home: string, kept: number): number {
  const all = listHandoffs(home);
  let removed = 0;
  for (const meta of all.slice(kept)) {
    const folder = join(handoffDir(home), meta.id);
    if (!within(handoffDir(home), folder) || !existsSync(join(folder, "meta.json"))) continue;
    try {
      rmSync(folder, { recursive: true, force: true });
      removed++;
    } catch {
      // Best effort: a locked folder stays until next time.
    }
  }
  return removed;
}

/**
 * Build a handoff, and store it unless `store` is false (the HTTP server keeps
 * nothing by default). Throws with the validation problems on bad input.
 */
export function saveHandoff(
  input: HandoffInput,
  { home = homedir(), now = new Date(), store = true }: { home?: string; now?: Date; store?: boolean } = {}
): SavedHandoff {
  const errs = validateHandoff(input);
  if (errs.length) throw new Error(errs.join(" "));
  const kinds = new Set<string>();
  let masked = 0;
  const mask = (s: string) => {
    const m = maskSecrets(s);
    masked += m.count;
    m.kinds.forEach((k) => kinds.add(k));
    return m.text;
  };
  const brief = mask(input.brief);
  // Untitled: the brief's first line, which is already masked.
  const title = oneLine(input.title?.trim() ? mask(input.title) : brief.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "") || "handoff", HANDOFF_LIMITS.titleChars);
  const blocks = (input.verbatim ?? []).map((b) => ({ label: oneLine(mask(b.label), HANDOFF_LIMITS.labelChars), text: mask(b.text) }));
  const created = now.toISOString();
  const markdown = renderHandoffMarkdown(title, created, brief, blocks);
  const base = `${stamp(now)}-${slugify(title)}`;
  const meta: HandoffMeta = {
    id: base,
    title,
    created,
    model: input.model,
    tokens: estimateTokens(markdown, input.model),
    briefTokens: estimateTokens(brief, input.model),
    blocks: blocks.map((b) => ({ label: b.label, tokens: estimateTokens(b.text, input.model) })),
    masked,
  };
  const math = handoffMath(meta.tokens, input);
  if (!store) return { meta, markdown, maskedKinds: [...kinds], math, rotated: 0 };

  const dir = handoffDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A second save in the same second gets -2, -3, …: never overwrite one.
  let folder = "";
  for (let n = 1; n <= 50; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    const candidate = join(dir, id);
    try {
      mkdirSync(candidate, { mode: 0o700 });
      meta.id = id;
      folder = candidate;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  if (!folder) throw new Error(`Could not create a handoff folder in ${dir}.`);
  // "wx": fail rather than write through anything already at that path.
  writeFileSync(join(folder, "handoff.md"), markdown, { mode: 0o600, flag: "wx" });
  writeFileSync(join(folder, "meta.json"), JSON.stringify(meta, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  const rotated = rotate(home, HANDOFF_LIMITS.kept);
  return { meta, markdown, dir: folder, maskedKinds: [...kinds], math, rotated };
}

/** Where a path sits, with the home directory shown as ~. */
export function tildify(path: string, home = homedir()): string {
  return path.startsWith(home) ? "~" + path.slice(home.length) : path;
}

/** `context-doctor handoff list`. */
export function renderHandoffList(metas: HandoffMeta[], home = homedir()): string {
  if (metas.length === 0) {
    return [
      "No handoffs saved yet.",
      "In Claude Desktop pick the `handoff` prompt from the + menu (context-doctor); elsewhere ask the assistant for a handoff, and it calls save_handoff.",
      `They are kept in ${tildify(handoffDir(home), home)}.`,
    ].join("\n");
  }
  const lines = metas.map((m) => {
    const blocks = m.blocks.length ? `, ${m.blocks.length} verbatim` : "";
    return `  ${m.id}  ~${formatTokens(m.tokens)}${blocks}  ${oneLine(m.title, 60)}`;
  });
  return [
    `${metas.length} handoff(s), newest first (${tildify(handoffDir(home), home)}; the newest ${HANDOFF_LIMITS.kept} are kept):`,
    ...lines,
    "",
    "Show one: context-doctor handoff show <id>. The newest: context-doctor handoff latest [--copy], then paste it as the first message of a new chat.",
  ].join("\n");
}
