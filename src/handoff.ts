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

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  modelChars: 100,
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
  /** Save order on this machine (wall clock in µs plus a counter): breaks ties between saves with the same `created`. */
  order?: number;
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
  if (input.model !== undefined && typeof input.model !== "string") errs.push("`model` must be a string.");
  for (const n of ["chatTokens", "turns"] as const) {
    const v = input[n];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100_000_000)) errs.push(`\`${n}\` must be a non-negative number.`);
  }
  return errs;
}

// Secret-looking strings, in three passes (a QA pass found the first
// version missed half of a realistic sample and masked a CSS class):
//  1. whole tokens by their published shapes (provider keys, private key
//     blocks, JWTs), replaced outright;
//  2. secrets inside a larger string: URL credentials (scheme://user:pass@),
//     Authorization Bearer/Basic values, `mysql -p<password>`, Slack webhooks;
//  3. assignments whose key names a secret (password, DB_PASSWORD, apiKey,
//     AWS_SECRET_ACCESS_KEY, client_secret, TOKEN, AccountKey, ...): the key
//     names it, so any real value is masked, however short (`password:
//     hunter2`), but not paths (`pwd: /home/...`), type names
//     (`password: string`), environment references (`process.env.X`),
//     calls (`getSecret(...)`) or placeholders (`YOUR_API_KEY_HERE`).
type Masker = { kind: string; re: RegExp; replace: (m: RegExpExecArray | string[]) => string | undefined };

const MASK = "masked by context-doctor";
const whole = (kind: string, re: RegExp, accept: (token: string) => boolean = () => true): Masker => ({
  kind,
  re,
  replace: (m) => (accept(m[0]) ? `[${kind.replace(/^an? /, "")} ${MASK}]` : undefined),
});
/** OpenAI keys mix cases and digits; `sk-spinner-wave-12345` (a CSS class) does not. */
const mixed = (t: string) => /[0-9]/.test(t) && /[A-Z]/.test(t) && /[a-z]/.test(t);

const SECRET_MASKERS: Masker[] = [
  whole("a private key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g),
  whole("an Anthropic key", /(?<![A-Za-z0-9_.-])sk-ant-[A-Za-z0-9_-]{20,}/g),
  whole("an OpenAI key", /(?<![A-Za-z0-9_.-])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, mixed),
  whole("an AWS access key", /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g),
  whole("a GitHub token", /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g),
  whole("a GitLab token", /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g),
  whole("a Slack token", /(?<![A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/g),
  whole("a Slack webhook", /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]+/g),
  whole("a Google API key", /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/g),
  whole("an npm token", /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g),
  whole("a Stripe key", /(?<![A-Za-z0-9])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g),
  whole("a Stripe webhook secret", /(?<![A-Za-z0-9])whsec_[A-Za-z0-9]{20,}/g),
  whole("a Hugging Face token", /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{30,}/g),
  whole("a SendGrid key", /(?<![A-Za-z0-9])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g),
  whole("a Twilio key", /(?<![A-Za-z0-9])SK[0-9a-f]{32}(?![A-Za-z0-9])/g),
  whole("a JWT", /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g),
  {
    kind: "a password in a URL",
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]*):([^\s@/]+)@/gi,
    replace: (m) => `${m[1]}${m[2]}:[${MASK}]@`,
  },
  {
    kind: "a bearer token",
    re: /\b(Bearer|Basic|Token)(\s+)([A-Za-z0-9._~+/=-]{16,})/g,
    replace: (m) => `${m[1]}${m[2]}[${MASK}]`,
  },
  {
    kind: "a database password",
    re: /(\bmysql(?:dump|admin)?\b[^\n]*?\s-p)([^\s-][^\s]*)/g,
    replace: (m) => `${m[1]}[${MASK}]`,
  },
];

const SECRET_KEY_NAME =
  "(?:password|passwd|passphrase|pwd|secret|secret[_-]?key|secret[_-]?access[_-]?key|access[_-]?key|client[_-]?secret|api[_-]?key|apikey|" +
  "access[_-]?token|auth[_-]?token|authtoken|refresh[_-]?token|bearer[_-]?token|token|private[_-]?key|account[_-]?key|shared[_-]?access[_-]?key|credentials?)";
// The key: an identifier whose LAST segment names a secret (DB_PASSWORD,
// OPENAI_API_KEY, _authToken), so token_count or max_tokens are not keys.
const ASSIGNMENT = new RegExp(
  `(?<![A-Za-z0-9])((?:[A-Za-z0-9]+[_.-])*${SECRET_KEY_NAME}["']?\\s*[:=]\\s*["']?)([^\\s"'\`,;()<>{}\\[\\]]{3,})(?=$|[\\s"'\`,;)\\]}])`,
  "gim"
);
const NOT_A_VALUE = /^(?:string|str|number|int|integer|bool|boolean|any|null|nil|none|undefined|true|false|required|optional|empty|redacted|hidden|secret|password|\*+|x{3,}|\.{3,})$/i;
const PLACEHOLDER = /^(?:your[_-]|<|\$\{?|%|\{\{|changeme|placeholder|example|dummy)|(?:[_-]here)(?:[_-]?\d+)?$/i;

function isRealValue(v: string): boolean {
  if (NOT_A_VALUE.test(v) || PLACEHOLDER.test(v)) return false;
  if (/^(?:\/|~\/|\.{1,2}\/|[A-Za-z]:\\)/.test(v)) return false; // a path (pwd: /home/...)
  if (/^(?:process\.env|os\.environ|env\.|ENV\[|getenv)/i.test(v)) return false;
  if (/^[A-Za-z_$][\w$]*(?:\.[\w$]+)+$/.test(v) && !/[0-9]/.test(v)) return false; // config.apiKey
  if (/^\d{1,7}$/.test(v)) return false; // a count, a port
  return true;
}

/** Mask secret-looking strings. Returns the text, how many were masked, and of what kinds. */
export function maskSecrets(text: string): { text: string; count: number; kinds: string[] } {
  let count = 0;
  const kinds = new Set<string>();
  let out = String(text ?? "");
  for (const m of SECRET_MASKERS) {
    out = out.replace(m.re, (...args: unknown[]) => {
      const groups = args.slice(0, -2).filter((a) => typeof a === "string" || a === undefined) as string[];
      const r = m.replace(groups);
      if (r === undefined) return groups[0];
      count++;
      kinds.add(m.kind);
      return r;
    });
  }
  out = out.replace(ASSIGNMENT, (whole: string, key: string, value: string) => {
    if (!isRealValue(value)) return whole;
    count++;
    kinds.add("a password or secret assignment");
    return `${key}[${MASK}]`;
  });
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

/** `inner` is `root` itself or somewhere under it. */
function within(root: string, inner: string): boolean {
  const rel = relative(root, inner);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

/** An error whose message names paths relative to the home directory, never absolutely. */
class HandoffError extends Error {}

/**
 * The handoffs folder, if it is safe to use: ~/.context-doctor and its
 * handoffs folder must be real directories (not symbolic links) whose real
 * path is inside the home directory's. With `create`, missing ones are made
 * (0700), one level at a time, and checked after. Otherwise undefined (read)
 * or a HandoffError (create). A QA pass pointed handoffs at another folder
 * with a link, and rotation deleted a folder outside the home directory.
 */
function safeHandoffDir(home: string, create: boolean): string | undefined {
  const refuse = (why: string) => {
    if (create) throw new HandoffError(why);
    return undefined;
  };
  let realHome: string;
  try {
    realHome = realpathSync(home);
  } catch {
    return refuse("the home directory cannot be read");
  }
  const parent = join(home, ".context-doctor");
  const dir = handoffDir(home);
  for (const d of [parent, dir]) {
    let st;
    try {
      st = lstatSync(d);
    } catch {
      if (!create) return undefined;
      try {
        mkdirSync(d, { mode: 0o700 });
        st = lstatSync(d);
      } catch (e) {
        return refuse(`cannot create ${tildify(d, home)} (${(e as NodeJS.ErrnoException).code ?? "error"})`);
      }
    }
    if (st.isSymbolicLink()) return refuse(`${tildify(d, home)} is a symbolic link; handoffs are only written to a real folder in the home directory`);
    if (!st.isDirectory()) return refuse(`${tildify(d, home)} is not a folder`);
    let real: string;
    try {
      real = realpathSync(d);
    } catch {
      return refuse(`${tildify(d, home)} cannot be read`);
    }
    if (!within(realHome, real)) return refuse(`${tildify(d, home)} resolves outside the home directory`);
  }
  return dir;
}

/** Ordering time: a handoff dated in the future (clock skew, a planted folder) sorts as the oldest, never the newest. */
function sortTime(meta: HandoffMeta, now: number): number {
  const t = Date.parse(meta.created);
  return Number.isFinite(t) && t <= now + 60_000 ? t : 0;
}

/** Newest first by `created` (future dates last), then by save order, then by id. Never by the id string alone. */
function newestFirst(now: number) {
  const order = (m: HandoffMeta) => (typeof m.order === "number" && Number.isFinite(m.order) ? m.order : 0);
  return (a: HandoffMeta, b: HandoffMeta) => sortTime(b, now) - sortTime(a, now) || order(b) - order(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

let saveCounter = 0;

/** Every saved handoff, newest first. Entries that are not ours (bad name, symlink, no meta) are skipped. */
export function listHandoffs(home = homedir()): HandoffMeta[] {
  const dir = safeHandoffDir(home, false);
  if (!dir) return [];
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
      const metaPath = join(folder, "meta.json");
      if (!lstatSync(metaPath).isFile()) continue;
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as HandoffMeta;
      if (meta?.id !== name || typeof meta.created !== "string") continue;
      metas.push(meta);
    } catch {
      continue;
    }
  }
  return metas.sort(newestFirst(Date.now()));
}

/**
 * One handoff by id, or the newest for "latest". Undefined for anything that
 * is not a well-formed id of a saved handoff: no path from a caller (a
 * resource URI, a CLI argument) ever reaches the filesystem as given.
 */
export function readHandoff(idOrLatest: string, home = homedir()): { meta: HandoffMeta; markdown: string } | undefined {
  const id = idOrLatest === "latest" ? listHandoffs(home)[0]?.id : idOrLatest;
  if (!isHandoffId(id)) return undefined;
  const dir = safeHandoffDir(home, false);
  if (!dir) return undefined;
  const folder = join(dir, id);
  const file = join(folder, "handoff.md");
  if (!within(dir, file)) return undefined;
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > HANDOFF_LIMITS.readBytes || !lstatSync(folder).isDirectory() || !lstatSync(join(folder, "meta.json")).isFile()) return undefined;
    const meta = JSON.parse(readFileSync(join(folder, "meta.json"), "utf8")) as HandoffMeta;
    if (meta?.id !== id) return undefined;
    return { meta, markdown: readFileSync(file, "utf8") };
  } catch {
    return undefined;
  }
}

/**
 * Keep the newest `kept` handoffs, the one just written always among them;
 * remove older folders that are ours: named like one, a real directory (not
 * a link) in the real handoffs folder, with our meta.json naming it.
 */
function rotate(home: string, kept: number, justWritten: string): number {
  const dir = safeHandoffDir(home, false);
  if (!dir) return 0;
  const others = listHandoffs(home).filter((m) => m.id !== justWritten);
  let removed = 0;
  for (const meta of others.slice(Math.max(0, kept - 1))) {
    const folder = join(dir, meta.id);
    try {
      if (!within(dir, folder) || !lstatSync(folder).isDirectory() || !lstatSync(join(folder, "meta.json")).isFile()) continue;
      if (!within(realpathSync(dir), realpathSync(folder))) continue;
      rmSync(folder, { recursive: true, force: true });
      removed++;
    } catch {
      // Best effort: a locked folder stays until next time.
    }
  }
  return removed;
}

/**
 * C0 and C1 control characters out, so a title or brief cannot drive a
 * terminal (escape sequences that retitle a window or clear the screen) when
 * the CLI prints it. Newlines and tabs stay; CRLF becomes LF.
 */
export function stripControls(text: string, { keepNewlines = true }: { keepNewlines?: boolean } = {}): string {
  const t = String(text ?? "").replace(/\r\n?/g, "\n");
  // eslint-disable-next-line no-control-regex
  return keepNewlines ? t.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "") : t.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

/**
 * Build a handoff, and store it unless `store` is false (the HTTP server keeps
 * nothing by default). Throws with the validation problems on bad input, and
 * with a message that names no absolute path when the folder is unsafe.
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
  const brief = mask(stripControls(input.brief));
  // Untitled: the brief's first line, which is already masked.
  const title = oneLine(input.title?.trim() ? mask(stripControls(input.title, { keepNewlines: false })) : brief.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "") || "handoff", HANDOFF_LIMITS.titleChars);
  const blocks = (input.verbatim ?? []).map((b) => ({ label: oneLine(mask(stripControls(b.label, { keepNewlines: false })), HANDOFF_LIMITS.labelChars), text: mask(stripControls(b.text)) }));
  // The model name is the caller's string: capped, cleaned and masked like the rest.
  const model = input.model === undefined ? undefined : mask(stripControls(String(input.model), { keepNewlines: false })).slice(0, HANDOFF_LIMITS.modelChars) || undefined;
  const created = now.toISOString();
  const markdown = renderHandoffMarkdown(title, created, brief, blocks);
  const base = `${stamp(now)}-${slugify(title)}`;
  const meta: HandoffMeta = {
    id: base,
    title,
    created,
    model,
    tokens: estimateTokens(markdown, model),
    briefTokens: estimateTokens(brief, model),
    blocks: blocks.map((b) => ({ label: b.label, tokens: estimateTokens(b.text, model) })),
    masked,
    order: Date.now() * 1000 + (saveCounter++ % 1000),
  };
  const math = handoffMath(meta.tokens, { ...input, model });
  if (!store) return { meta, markdown, maskedKinds: [...kinds], math, rotated: 0 };

  const dir = safeHandoffDir(home, true)!;
  // A second save in the same second gets -2, -3, …: never overwrite one.
  let folder = "";
  for (let n = 1; n <= 200; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    const candidate = join(dir, id);
    try {
      mkdirSync(candidate, { mode: 0o700 });
      meta.id = id;
      folder = candidate;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new HandoffError(`cannot create a handoff folder in ${tildify(dir, home)} (${(e as NodeJS.ErrnoException).code ?? "error"})`);
    }
  }
  if (!folder) throw new HandoffError(`too many handoffs saved in the same second in ${tildify(dir, home)}`);
  try {
    // "wx": fail rather than write through anything already at that path.
    writeFileSync(join(folder, "handoff.md"), markdown, { mode: 0o600, flag: "wx" });
    writeFileSync(join(folder, "meta.json"), JSON.stringify(meta, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  } catch (e) {
    throw new HandoffError(`cannot write the handoff in ${tildify(folder, home)} (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  const rotated = rotate(home, HANDOFF_LIMITS.kept, meta.id);
  if (!existsSync(join(folder, "handoff.md"))) throw new HandoffError(`the handoff in ${tildify(folder, home)} is gone`);
  return { meta, markdown, dir: folder, maskedKinds: [...kinds], math, rotated };
}

/** Where a path sits, with the home directory shown as ~. */
export function tildify(path: string, home = homedir()): string {
  return home && path.startsWith(home) ? "~" + path.slice(home.length) : path;
}

/** Every absolute mention of the home directory in `text` as ~ (error messages that reach a client). */
export function tildifyAll(text: string, home = homedir()): string {
  return home && home.length > 1 ? String(text).split(home).join("~") : String(text);
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
    return `  ${m.id}  ~${formatTokens(m.tokens)}${blocks}  ${oneLine(stripControls(String(m.title ?? ""), { keepNewlines: false }), 60)}`;
  });
  return [
    `${metas.length} handoff(s), newest first (${tildify(handoffDir(home), home)}; the newest ${HANDOFF_LIMITS.kept} are kept):`,
    ...lines,
    "",
    "Show one: context-doctor handoff show <id>. The newest: context-doctor handoff latest [--copy], then paste it as the first message of a new chat.",
  ].join("\n");
}
