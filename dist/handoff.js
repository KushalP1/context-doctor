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
};
/** ~/.context-doctor/handoffs, under whatever home this process has. */
export function handoffDir(home = homedir()) {
    return join(home, ".context-doctor", "handoffs");
}
/** yyyymmdd-hhmmss-slug, optionally with a -n suffix for a second save in the same second. */
const ID_RE = /^\d{8}-\d{6}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function isHandoffId(id) {
    return typeof id === "string" && id.length <= 80 && ID_RE.test(id);
}
export function slugify(title) {
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
function stamp(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}
/** Problems with an input, or an empty list. Enforced here too, not only by the MCP schema. */
export function validateHandoff(input) {
    const errs = [];
    const L = HANDOFF_LIMITS;
    if (typeof input?.brief !== "string" || !input.brief.trim())
        errs.push("`brief` is empty: write the handoff brief first.");
    else if (input.brief.length > L.briefChars)
        errs.push(`\`brief\` is ${input.brief.length} characters; the limit is ${L.briefChars} (aim for ≤${L.briefTargetTokens} tokens).`);
    if (input.title !== undefined && (typeof input.title !== "string" || input.title.length > L.titleChars))
        errs.push(`\`title\` must be a string of at most ${L.titleChars} characters.`);
    const blocks = input.verbatim ?? [];
    if (!Array.isArray(blocks))
        errs.push("`verbatim` must be a list of {label, text}.");
    else {
        if (blocks.length > L.blocks)
            errs.push(`${blocks.length} verbatim blocks; the limit is ${L.blocks}. Keep only what must stay exact.`);
        let total = typeof input.brief === "string" ? input.brief.length : 0;
        blocks.forEach((b, i) => {
            if (typeof b?.label !== "string" || !b.label.trim() || b.label.length > L.labelChars)
                errs.push(`verbatim[${i}].label must be 1-${L.labelChars} characters.`);
            if (typeof b?.text !== "string" || !b.text.trim())
                errs.push(`verbatim[${i}].text is empty.`);
            else if (b.text.length > L.blockChars)
                errs.push(`verbatim[${i}] ("${String(b.label).slice(0, 40)}") is ${b.text.length} characters; the limit is ${L.blockChars}. Summarize it, or keep only the exact lines needed.`);
            else
                total += b.text.length;
        });
        if (total > L.totalChars)
            errs.push(`The handoff is ${total} characters; the limit is ${L.totalChars}. A handoff that big is not a cut.`);
    }
    for (const n of ["chatTokens", "turns"]) {
        const v = input[n];
        if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100_000_000))
            errs.push(`\`${n}\` must be a non-negative number.`);
    }
    return errs;
}
const MASK = "masked by context-doctor";
const whole = (kind, re, accept = () => true) => ({
    kind,
    re,
    replace: (m) => (accept(m[0]) ? `[${kind.replace(/^an? /, "")} ${MASK}]` : undefined),
});
/** OpenAI keys mix cases and digits; `sk-spinner-wave-12345` (a CSS class) does not. */
const mixed = (t) => /[0-9]/.test(t) && /[A-Z]/.test(t) && /[a-z]/.test(t);
const SECRET_MASKERS = [
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
const SECRET_KEY_NAME = "(?:password|passwd|passphrase|pwd|secret|secret[_-]?key|secret[_-]?access[_-]?key|access[_-]?key|client[_-]?secret|api[_-]?key|apikey|" +
    "access[_-]?token|auth[_-]?token|authtoken|refresh[_-]?token|bearer[_-]?token|token|private[_-]?key|account[_-]?key|shared[_-]?access[_-]?key|credentials?)";
// The key: an identifier whose LAST segment names a secret (DB_PASSWORD,
// OPENAI_API_KEY, _authToken), so token_count or max_tokens are not keys.
const ASSIGNMENT = new RegExp(`(?<![A-Za-z0-9])((?:[A-Za-z0-9]+[_.-])*${SECRET_KEY_NAME}["']?\\s*[:=]\\s*["']?)([^\\s"'\`,;()<>{}\\[\\]]{3,})(?=$|[\\s"'\`,;)\\]}])`, "gim");
const NOT_A_VALUE = /^(?:string|str|number|int|integer|bool|boolean|any|null|nil|none|undefined|true|false|required|optional|empty|redacted|hidden|secret|password|\*+|x{3,}|\.{3,})$/i;
const PLACEHOLDER = /^(?:your[_-]|<|\$\{?|%|\{\{|changeme|placeholder|example|dummy)|(?:[_-]here)(?:[_-]?\d+)?$/i;
function isRealValue(v) {
    if (NOT_A_VALUE.test(v) || PLACEHOLDER.test(v))
        return false;
    if (/^(?:\/|~\/|\.{1,2}\/|[A-Za-z]:\\)/.test(v))
        return false; // a path (pwd: /home/...)
    if (/^(?:process\.env|os\.environ|env\.|ENV\[|getenv)/i.test(v))
        return false;
    if (/^[A-Za-z_$][\w$]*(?:\.[\w$]+)+$/.test(v) && !/[0-9]/.test(v))
        return false; // config.apiKey
    if (/^\d{1,7}$/.test(v))
        return false; // a count, a port
    return true;
}
/** Mask secret-looking strings. Returns the text, how many were masked, and of what kinds. */
export function maskSecrets(text) {
    let count = 0;
    const kinds = new Set();
    let out = String(text ?? "");
    for (const m of SECRET_MASKERS) {
        out = out.replace(m.re, (...args) => {
            const groups = args.slice(0, -2).filter((a) => typeof a === "string" || a === undefined);
            const r = m.replace(groups);
            if (r === undefined)
                return groups[0];
            count++;
            kinds.add(m.kind);
            return r;
        });
    }
    out = out.replace(ASSIGNMENT, (whole, key, value) => {
        if (!isRealValue(value))
            return whole;
        count++;
        kinds.add("a password or secret assignment");
        return `${key}[${MASK}]`;
    });
    return { text: out, count, kinds: [...kinds] };
}
/** A code fence longer than any backtick run inside `text`, so the block cannot close early. */
function fenceFor(text) {
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
    return "`".repeat(Math.max(3, longest + 1));
}
function oneLine(s, max) {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
/** The text a new chat starts from: what is attached, pasted or copied. */
export function renderHandoffMarkdown(title, created, brief, blocks) {
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
export function handoffMath(handoffTokens, input) {
    const math = { after: handoffTokens };
    if (input.chatTokens !== undefined && input.chatTokens > 0) {
        math.now = Math.round(input.chatTokens);
        math.nowSource = "given";
    }
    else if (input.turns !== undefined && input.turns > 0) {
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
export function renderMath(m) {
    const price = (usd, cached) => (usd !== undefined ? ` (${formatUsd(usd)} at list price, ${formatUsd(cached ?? 0)} cached)` : "");
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
export function listHandoffs(home = homedir()) {
    const dir = handoffDir(home);
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return [];
    }
    const metas = [];
    for (const name of names) {
        if (!isHandoffId(name))
            continue;
        const folder = join(dir, name);
        try {
            if (!lstatSync(folder).isDirectory())
                continue;
            const meta = JSON.parse(readFileSync(join(folder, "meta.json"), "utf8"));
            if (meta?.id !== name)
                continue;
            metas.push(meta);
        }
        catch {
            continue;
        }
    }
    return metas.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}
/** `inner` is `root` itself or somewhere under it. */
function within(root, inner) {
    const rel = relative(root, inner);
    return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}
/**
 * One handoff by id, or the newest for "latest". Undefined for anything that
 * is not a well-formed id of a saved handoff: no path from a caller (a
 * resource URI, a CLI argument) ever reaches the filesystem as given.
 */
export function readHandoff(idOrLatest, home = homedir()) {
    const id = idOrLatest === "latest" ? listHandoffs(home)[0]?.id : idOrLatest;
    if (!isHandoffId(id))
        return undefined;
    const dir = handoffDir(home);
    const folder = join(dir, id);
    const file = join(folder, "handoff.md");
    if (!within(dir, file))
        return undefined;
    try {
        const st = lstatSync(file);
        if (!st.isFile() || st.size > HANDOFF_LIMITS.readBytes || !lstatSync(folder).isDirectory())
            return undefined;
        const meta = JSON.parse(readFileSync(join(folder, "meta.json"), "utf8"));
        if (meta?.id !== id)
            return undefined;
        return { meta, markdown: readFileSync(file, "utf8") };
    }
    catch {
        return undefined;
    }
}
/** Keep the newest `kept` handoffs; remove older folders that are ours (named like one, with a meta.json). */
function rotate(home, kept) {
    const all = listHandoffs(home);
    let removed = 0;
    for (const meta of all.slice(kept)) {
        const folder = join(handoffDir(home), meta.id);
        if (!within(handoffDir(home), folder) || !existsSync(join(folder, "meta.json")))
            continue;
        try {
            rmSync(folder, { recursive: true, force: true });
            removed++;
        }
        catch {
            // Best effort: a locked folder stays until next time.
        }
    }
    return removed;
}
/**
 * Build a handoff, and store it unless `store` is false (the HTTP server keeps
 * nothing by default). Throws with the validation problems on bad input.
 */
export function saveHandoff(input, { home = homedir(), now = new Date(), store = true } = {}) {
    const errs = validateHandoff(input);
    if (errs.length)
        throw new Error(errs.join(" "));
    const kinds = new Set();
    let masked = 0;
    const mask = (s) => {
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
    const meta = {
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
    if (!store)
        return { meta, markdown, maskedKinds: [...kinds], math, rotated: 0 };
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
        }
        catch (e) {
            if (e.code !== "EEXIST")
                throw e;
        }
    }
    if (!folder)
        throw new Error(`Could not create a handoff folder in ${dir}.`);
    // "wx": fail rather than write through anything already at that path.
    writeFileSync(join(folder, "handoff.md"), markdown, { mode: 0o600, flag: "wx" });
    writeFileSync(join(folder, "meta.json"), JSON.stringify(meta, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    const rotated = rotate(home, HANDOFF_LIMITS.kept);
    return { meta, markdown, dir: folder, maskedKinds: [...kinds], math, rotated };
}
/** Where a path sits, with the home directory shown as ~. */
export function tildify(path, home = homedir()) {
    return path.startsWith(home) ? "~" + path.slice(home.length) : path;
}
/** `context-doctor handoff list`. */
export function renderHandoffList(metas, home = homedir()) {
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
