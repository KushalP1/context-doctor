/**
 * Codex's auto-compact limit: what an earlier compaction would have saved on
 * the user's Codex rollouts, and the `codex-compact` lever of `fix`.
 *
 * Verified 2026-11-04 against codex-cli 0.153.4 (the ChatGPT app's binary)
 * and openai/codex main (config.schema.json, protocol/src/openai_models.rs,
 * models-manager/src/model_info.rs) and the config reference at
 * developers.openai.com/codex/config-reference:
 *  - `model_auto_compact_token_limit`, a top-level integer in
 *    ~/.codex/config.toml (CODEX_HOME), is the token count that triggers an
 *    automatic compaction. Unset, it is 90% of the model's context window
 *    (244,800 on a 272k window: gpt-5.5, gpt-6); set, the smaller of the two,
 *    so it can only bring compaction earlier. `..._scope` ("total", the
 *    default, or "body_after_prefix") says what it counts.
 *  - A rollout records each request as a `token_count` event (the last
 *    request's input, cached input and output, and `model_context_window`,
 *    95% of the window), and a compaction as a `compacted` item (its
 *    replacement history) followed by a `context_compacted` event. On the
 *    author's one compaction the next request's input fell from 243,893 to
 *    22,507 tokens. The compaction's own request is not recorded.
 *
 * The replay walks each rollout's requests twice: as billed, and compacting
 * whenever the context reaches the candidate limit. Context a simulated
 * compaction removed is priced at each later request as that request billed
 * it (cached tokens at the cached rate, the rest at the input rate), until a
 * real compaction; the request after a simulated one pays the input rate on
 * its whole (now small) context, and each simulated compaction pays one
 * request reading the context and a summary at the output rate (an estimate:
 * Codex does not record it). What the summary dropped, and the model reading
 * files again because of it, is not priced.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { codexDir } from "./codexdir.js";
import { codexEventKey, codexSessionsRoot, rolloutFiles } from "./limits.js";
import { openAIUsage, pricingFor, usageCost } from "./pricing.js";
import { pick, rowsOf } from "./scan.js";
import { tilde } from "./claudedir.js";
/** The config.toml key the lever writes. */
export const CODEX_COMPACT_KEY = "model_auto_compact_token_limit";
/** The limit `fix` offers, and the others the replay shows. */
export const CODEX_COMPACT_LIMIT = 150_000;
export const CODEX_COMPACT_LIMITS = [100_000, 150_000, 200_000];
/** Codex's own trigger, unset: 90% of the context window. */
const DEFAULT_SHARE = 0.9;
/** The window a rollout records is 95% of the model's. */
const RECORDED_SHARE = 0.95;
/** A 272k window, when a rollout records none (gpt-5.5, gpt-6). */
const DEFAULT_WINDOW = 272_000;
/** Context right after a compaction when the user's own rollouts show none: system prompt, tools, summary, recent messages. */
const AFTER_COMPACT = 25_000;
/** Output a compaction's summary costs (an estimate: Codex does not record the compaction's request). */
const SUMMARY_OUTPUT = 5_000;
/**
 * What the replay takes from a rollout: each model change, every request's
 * usage (token_count: time, running total, the fork key, the window), and
 * each compaction. No text.
 */
export const CODEX_COMPACT_ROWS = {
    id: "codex-compact.1",
    init: () => null,
    line(line, row, out) {
        if (!line.includes('"token_count"') && !line.includes('"turn_context"') && !line.includes('"compacted"') && !line.includes('"context_compacted"'))
            return;
        let e;
        try {
            e = row();
        }
        catch {
            return;
        }
        if (!e || typeof e !== "object")
            return;
        if (e.type === "compacted") {
            out.push({ k: "c" });
            return;
        }
        const p = e.payload;
        if (!p || typeof p !== "object")
            return;
        if (e.type === "turn_context") {
            if (typeof p.model === "string")
                out.push({ k: "model", model: p.model });
            return;
        }
        if (e.type !== "event_msg")
            return;
        if (p.type === "context_compacted") {
            out.push({ k: "c" });
            return;
        }
        if (p.type !== "token_count")
            return;
        const last = p.info?.last_token_usage;
        if (!last || typeof last !== "object")
            return;
        const total = p.info?.total_token_usage?.total_tokens;
        const win = p.info?.model_context_window;
        out.push({ k: "t", ts: String(e.timestamp ?? ""), total: typeof total === "number" ? total : 0, key: codexEventKey(p.info?.total_token_usage, last), ...(typeof win === "number" && win > 0 ? { win } : {}), u: pick(last, ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "input_tokens_details", "prompt_tokens", "prompt_tokens_details", "completion_tokens"]) });
    },
};
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
/** One rollout's requests and compactions; a request a forked rollout copied from its parent (`seen`) is marked, not dropped. */
function readSteps(file, seen) {
    const steps = [];
    let model;
    let total = -1;
    for (const r of rowsOf(file, CODEX_COMPACT_ROWS)) {
        if (r?.k === "model") {
            model = r.model;
            continue;
        }
        if (r?.k === "c") {
            // A compaction is written twice (the item and its event): one boundary.
            if (steps[steps.length - 1]?.k !== "c")
                steps.push({ k: "c" });
            continue;
        }
        if (r?.k !== "t")
            continue;
        // A token_count event repeats the last request when only the limits were refreshed.
        const runTotal = num(r.total);
        if (num(r.u?.input_tokens) === 0 || (runTotal !== 0 && runTotal === total))
            continue;
        total = runTotal;
        const at = Date.parse(r.ts);
        if (!Number.isFinite(at))
            continue;
        const u = openAIUsage(r.u);
        const price = pricingFor(model);
        const copy = !!r.key && seen.has(r.key);
        if (r.key)
            seen.add(r.key);
        const window = num(r.win) ? num(r.win) / RECORDED_SHARE : DEFAULT_WINDOW;
        steps.push({
            k: "r", at, copy,
            prompt: num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens),
            cached: num(u.cache_read_input_tokens),
            out: num(u.output_tokens),
            inPerM: price?.inputPerM ?? 0, readPerM: price?.cacheReadPerM ?? 0, outPerM: price?.outputPerM ?? 0,
            billedUsd: price ? usageCost(u, price).promptUsd : 0,
            trigger: DEFAULT_SHARE * window,
        });
    }
    return steps;
}
/**
 * One rollout at `limit`: as billed and with compaction at the limit, in USD
 * over the requests in [since, until) that are not a fork's copy. Codex
 * compacts when a turn's input and output reach the limit, which is never
 * above its own trigger; with the `body_after_prefix` scope, when what the
 * turn holds beyond the first request of its window (the session's start or
 * the last compaction) reaches it (codex-rs session/context_window.rs).
 */
function replay(steps, limit, since, until, after, scope = "total") {
    let billed = 0, sim = 0, extra = 0, actual = 0;
    let removed = 0, fresh = false, prevCounted = false;
    // The input of the window's first request: what body_after_prefix does not count.
    let prefill;
    for (const s of steps) {
        if (s.k === "c") {
            // A compaction after a fork's copy of its parent's requests is the parent's, counted there.
            if (prevCounted)
                actual++;
            removed = 0;
            fresh = false;
            prefill = undefined;
            continue;
        }
        const counted = s.at >= since && s.at < until && !s.copy;
        prevCounted = counted;
        let ctx = s.prompt - removed;
        // The real context fell below what was removed (a rewind with no compaction recorded): back in step.
        if (removed > 0 && ctx < after) {
            removed = 0;
            ctx = s.prompt;
            fresh = false;
        }
        let cost = s.billedUsd;
        if (fresh)
            cost = (ctx * s.inPerM) / 1e6;
        else if (removed > 0) {
            const fromCache = Math.min(removed, s.cached);
            cost = Math.max(0, s.billedUsd - (fromCache * s.readPerM + (removed - fromCache) * s.inPerM) / 1e6);
        }
        fresh = false;
        prefill ??= ctx;
        if (counted) {
            billed += s.billedUsd;
            sim += cost;
        }
        const reached = scope === "body_after_prefix"
            ? ctx + s.out - prefill >= limit && ctx + s.out < s.trigger
            : ctx + s.out >= Math.min(limit, s.trigger) && limit < s.trigger;
        if (reached) {
            // Compacted after this turn: one request reading the context, a summary written; the next starts from `after`.
            if (counted) {
                sim += (ctx * s.readPerM + SUMMARY_OUTPUT * s.outPerM) / 1e6;
                extra++;
            }
            removed = s.prompt + s.out - after;
            fresh = true;
            prefill = undefined;
        }
    }
    return { billed, sim, extra, actual };
}
export const CODEX_COMPACT_SCOPE_KEY = "model_auto_compact_token_limit_scope";
/** Codex rollouts written since `since`: the live ones and the archived. */
export function codexRollouts(since, home = homedir()) {
    const roots = [codexSessionsRoot(home), join(codexDir(home), "archived_sessions")];
    // Oldest first by name (rollout-YYYY-MM-DDThh-mm-ss-…): a parent before the forks that copy it.
    return roots.filter((r) => existsSync(r)).flatMap((r) => rolloutFiles(r, since)).sort((a, b) => basename(a).localeCompare(basename(b)));
}
/** Replay Codex's rollouts of the last `days` at each limit. */
export function replayCodexCompact(opts) {
    const now = opts.now ?? Date.now();
    const scope = opts.scope ?? codexCompactScope(opts.home);
    const since = now - opts.days * 86_400_000;
    const paths = opts.paths ?? codexRollouts(since, opts.home);
    const seen = new Set();
    const all = [];
    for (const p of paths) {
        try {
            all.push(readSteps(p, seen));
        }
        catch { /* unreadable: skipped */ }
    }
    // The context right after each of the user's own compactions.
    const afters = [];
    let requests = 0, unpriced = 0;
    for (const steps of all) {
        steps.forEach((s, i) => {
            if (s.k === "c") {
                const n = steps[i + 1];
                if (n?.k === "r" && !n.copy)
                    afters.push(n.prompt);
                return;
            }
            if (s.at >= since && !s.copy) {
                requests++;
                if (!s.billedUsd && !s.inPerM)
                    unpriced++;
            }
        });
    }
    afters.sort((a, b) => a - b);
    const after = afters.length ? afters[Math.floor(afters.length / 2)] : AFTER_COMPACT;
    let billedUsd = 0, actual = 0;
    const estimates = (opts.limits ?? CODEX_COMPACT_LIMITS).map((limit, i) => {
        let billed = 0, sim = 0, extra = 0;
        for (const steps of all) {
            const r = replay(steps, limit, since, Infinity, after, scope);
            billed += r.billed;
            sim += r.sim;
            extra += r.extra;
            if (i === 0)
                actual += r.actual;
        }
        if (i === 0)
            billedUsd = billed;
        return { limit, savedUsd: billed - sim, savedShare: billed > 0 ? (billed - sim) / billed : 0, compactions: extra };
    });
    return { days: opts.days, scope, rollouts: paths.length, requests, billedUsd, unpriced, actualCompactions: actual, afterCompact: after, estimates };
}
/**
 * What a limit set at `since` saved: each compaction since that came before
 * the old trigger (`previous`, or Codex's own), priced as the context it took
 * off every later request until the session would have reached the old
 * trigger, less the compaction's request and summary (an estimate, as in
 * the replay).
 */
export function codexCompactSavedSince(since, previous, paths) {
    const seen = new Set();
    let usd = 0, compactions = 0;
    for (const p of paths ?? codexRollouts(since)) {
        let steps;
        try {
            steps = readSteps(p, seen);
        }
        catch {
            continue;
        }
        let last;
        let episode;
        let pending = false;
        for (const s of steps) {
            if (s.k === "c") {
                episode = undefined;
                pending = !!last && last.at >= since && !last.copy;
                continue;
            }
            if (pending && last) {
                pending = false;
                const pre = last.prompt + last.out;
                const trigger = Math.min(previous ?? Infinity, last.trigger);
                if (pre < 0.9 * trigger) {
                    episode = { pre, post: s.prompt, trigger };
                    compactions++;
                    usd -= (pre * last.readPerM + SUMMARY_OUTPUT * last.outPerM) / 1e6;
                }
            }
            else if (episode?.post !== undefined && !s.copy) {
                const would = episode.pre + Math.max(0, s.prompt - episode.post);
                if (would >= episode.trigger)
                    episode = undefined;
                else
                    usd += ((would - s.prompt) * s.readPerM) / 1e6;
            }
            last = s;
        }
    }
    return { usd, compactions };
}
// -- config.toml, key by key ---------------------------------------------------------
const HEADER = /^\s*\[/;
const keyLine = (key) => new RegExp(String.raw `^\s*(?:${key}|"${key}"|'${key}')\s*=\s*([^#\r]*?)\s*(?:#[^\r]*)?\r?$`);
/** A TOML integer as written (`150000`, `150_000`, `+150000`), or undefined. */
const tomlInt = (raw) => (/^[+-]?\d[\d_]*$/.test(raw.trim()) ? Number(raw.trim().replace(/_/g, "")) : undefined);
const BOM = "﻿";
/**
 * For each line, whether it starts a statement (a key, a [table], a comment
 * or a blank) rather than continuing a value that spans lines: a multi-line
 * string ("""…""", '''…''') or an array or inline table left open. A
 * `[x]` or `key = 1` inside one of those is the value's text, not a table or
 * a key, and a line put there would land inside the user's value.
 */
function statementStarts(lines) {
    const out = [];
    let depth = 0;
    let ml;
    for (const line of lines) {
        out.push(depth === 0 && ml === undefined);
        let i = 0;
        while (i < line.length) {
            const c = line[i];
            if (ml !== undefined) {
                if (ml === '"""' && c === "\\") {
                    i += 2;
                    continue;
                }
                if (line.startsWith(ml, i)) {
                    // Up to two quotes more belong to the string: `""""` ends it with one.
                    let j = i + 3;
                    while (j < line.length && j < i + 5 && line[j] === ml[0])
                        j++;
                    ml = undefined;
                    i = j;
                }
                else
                    i++;
                continue;
            }
            if (c === "#")
                break;
            if (c === '"' || c === "'") {
                if (line.startsWith(c.repeat(3), i)) {
                    ml = c.repeat(3);
                    i += 3;
                    continue;
                }
                let j = i + 1;
                while (j < line.length && line[j] !== c)
                    j += c === '"' && line[j] === "\\" ? 2 : 1;
                i = j + 1;
                continue;
            }
            if (c === "[" || c === "{")
                depth++;
            else if ((c === "]" || c === "}") && depth > 0)
                depth--;
            i++;
        }
    }
    return out;
}
/** The lines, which of them start a statement, and the first [table] (lines.length when none). */
function tomlLayout(toml) {
    const lines = toml.split("\n");
    const starts = statementStarts(lines);
    const header = lines.findIndex((l, i) => starts[i] && HEADER.test(l));
    return { lines, starts, header: header === -1 ? lines.length : header };
}
/** The top-level value of `key` (before the first [table]): as written, and as a number when it is one. */
export function topLevelValue(toml, key = CODEX_COMPACT_KEY) {
    const re = keyLine(key);
    const { lines, starts, header } = tomlLayout(toml.startsWith(BOM) ? toml.slice(1) : toml);
    for (let i = 0; i < header; i++) {
        const m = starts[i] ? re.exec(lines[i]) : null;
        if (m)
            return { raw: m[1], value: tomlInt(m[1]) };
    }
    return undefined;
}
/**
 * Set (or with undefined, remove) a top-level integer key, touching no other
 * byte: a line replaced keeps its line end; a new line goes after the last
 * top-level statement (or at the top, after a byte order mark), with the
 * file's own line ends, never inside a multi-line string or array. A
 * missing file (undefined) becomes the one line.
 */
export function setTopLevelInt(toml, key, value) {
    if (toml === undefined || toml === "")
        return value === undefined ? "" : `${key} = ${value}\n`;
    const bom = toml.startsWith(BOM) ? BOM : "";
    const { lines, starts, header: end } = tomlLayout(toml.slice(bom.length));
    const cr = toml.includes("\r\n") ? "\r" : "";
    const re = keyLine(key);
    const at = lines.slice(0, end).findIndex((l, i) => starts[i] && re.test(l));
    if (at >= 0) {
        if (value === undefined)
            lines.splice(at, 1);
        else
            lines[at] = `${key} = ${value}${lines[at].endsWith("\r") ? "\r" : ""}`;
        return bom + lines.join("\n");
    }
    if (value === undefined)
        return toml;
    // After the last top-level statement (all of its lines), so a comment above a [table] stays with it.
    let pos = 0;
    for (let i = 0; i < end; i++) {
        if (!starts[i] || !/^\s*[^\s#[]/.test(lines[i]))
            continue;
        pos = i + 1;
        while (pos < end && !starts[pos])
            pos++;
    }
    lines.splice(pos, 0, `${key} = ${value}${cr}`);
    return bom + lines.join("\n");
}
/** A profile name as a TOML key part: bare, "quoted" or 'quoted'. */
const PROFILE = String.raw `(?:"([^"]+)"|'([^']+)'|([\w-]+))`;
/**
 * Profiles that set `key`, and the profile the file selects by default:
 * `[profiles.<name>]` tables, a `[profiles]` table's `<name>.key`, and a
 * top-level `profiles.<name>.key`.
 */
export function profileValues(toml, key = CODEX_COMPACT_KEY) {
    const re = keyLine(key);
    const { lines, starts, header } = tomlLayout(toml.startsWith(BOM) ? toml.slice(1) : toml);
    const name = (m) => m?.slice(1, 4).find((x) => x !== undefined);
    let selected;
    for (let i = 0; i < header && selected === undefined; i++)
        if (starts[i])
            selected = /^\s*profile\s*=\s*["']([^"']+)["']/.exec(lines[i])?.[1];
    const dotted = (prefix) => new RegExp(String.raw `^\s*${prefix}${PROFILE}\s*\.\s*(?:${key}|"${key}"|'${key}')\s*=\s*([^#\r]*?)\s*(?:#[^\r]*)?\r?$`);
    const top = dotted(String.raw `profiles\s*\.\s*`);
    const inProfiles = dotted("");
    const out = [];
    // undefined: the top level; "": the [profiles] table; a name: [profiles.<name>]; null: any other table.
    let table;
    lines.forEach((line, i) => {
        if (!starts[i])
            return;
        if (HEADER.test(line)) {
            table = /^\s*\[\s*profiles\s*\]/.test(line) ? "" : name(new RegExp(String.raw `^\s*\[\s*profiles\s*\.\s*${PROFILE}\s*\]`).exec(line)) ?? null;
            return;
        }
        let profile, raw;
        if (table) {
            const m = re.exec(line);
            if (m) {
                profile = table;
                raw = m[1];
            }
        }
        else if (table === "" || table === undefined) {
            const m = (table === "" ? inProfiles : top).exec(line);
            if (m) {
                profile = name(m);
                raw = m[4];
            }
        }
        if (profile !== undefined && raw !== undefined)
            out.push({ profile, raw, selected: profile === selected });
    });
    return out;
}
/** ~/.codex/config.toml (CODEX_HOME honoured for this user). */
export function codexConfigPath(home) {
    return join(codexDir(home), "config.toml");
}
/** The limit the user set at the top of config.toml, as written. */
export function currentCodexCompact(home) {
    const p = codexConfigPath(home);
    let text;
    try {
        text = readFileSync(p, "utf8");
    }
    catch {
        return undefined;
    }
    const v = topLevelValue(text);
    return v ? { ...v, where: tilde(p) } : undefined;
}
/** model_auto_compact_token_limit_scope at the top of config.toml: "body_after_prefix", else Codex's default, "total". */
export function codexCompactScope(home) {
    let text;
    try {
        text = readFileSync(codexConfigPath(home), "utf8");
    }
    catch {
        return "total";
    }
    const raw = topLevelValue(text, CODEX_COMPACT_SCOPE_KEY)?.raw.trim().replace(/^["']|["']$/g, "");
    return raw === "body_after_prefix" ? "body_after_prefix" : "total";
}
/** What would keep a top-level limit from applying: a profile's own, a project's config.toml. */
export function codexCompactOverrides(home, cwd = process.cwd()) {
    const out = [];
    const p = codexConfigPath(home);
    let user;
    try {
        user = readFileSync(p, "utf8");
    }
    catch { /* none */ }
    if (user !== undefined) {
        for (const v of profileValues(user))
            out.push(`${CODEX_COMPACT_KEY} = ${v.raw} in [profiles.${v.profile}] of ${tilde(p)} (${v.selected ? "the profile it selects" : `when Codex runs with --profile ${v.profile}`})`);
    }
    // Closest folder first: the one whose value Codex applies last.
    for (const dir of [...projectConfigFolders(cwd, rootMarkers(user))].reverse()) {
        const project = join(dir, ".codex", "config.toml");
        if (resolve(project) === resolve(p))
            continue;
        try {
            const v = topLevelValue(readFileSync(project, "utf8"));
            if (v)
                out.push(`${CODEX_COMPACT_KEY} = ${v.raw} in ${tilde(project)} (this project's, when Codex trusts it)`);
        }
        catch { /* none */ }
    }
    return out;
}
/** `project_root_markers` at the top of the user's config.toml (strings of a one-line array), else Codex's default, [".git"]. */
function rootMarkers(toml) {
    const raw = toml === undefined ? undefined : topLevelValue(toml, "project_root_markers")?.raw.trim();
    if (!raw || !raw.startsWith("[") || !raw.endsWith("]"))
        return [".git"];
    return [...raw.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
}
/**
 * The folders whose `.codex/config.toml` Codex layers over the user's, root
 * first (codex-rs config/src/loader/mod.rs, discover_project_layers): from
 * the project root (the closest folder holding a root marker; a `.git`
 * folder counts only with a HEAD in it) down to `cwd`; with no root, `cwd`
 * alone.
 */
export function projectConfigFolders(cwd, markers = [".git"]) {
    const dirs = [];
    let dir = resolve(cwd);
    for (;;) {
        dirs.push(dir);
        const isRoot = markers.some((m) => {
            const at = join(dir, m);
            try {
                return m === ".git" && statSync(at).isDirectory() ? existsSync(join(at, "HEAD")) : existsSync(at);
            }
            catch {
                return false;
            }
        });
        if (isRoot)
            return dirs.reverse();
        const up = dirname(dir);
        if (up === dir)
            return [resolve(cwd)];
        dir = up;
    }
}
const usd = (n) => (Math.abs(n) >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);
const k = (n) => `${Math.round(n / 1000)}k`;
/** The lines under the lever in `fix`: each limit tried. */
export function renderCodexLimits(r, offered) {
    const weeks = r.days / 7;
    const out = [`${"limit".padEnd(10)}${"saved".padStart(10)}   compactions a week (now ${(r.actualCompactions / weeks).toFixed(1)})`];
    for (const e of r.estimates)
        out.push(`${k(e.limit).padEnd(10)}${usd(e.savedUsd).padStart(10)}   ${(e.compactions / weeks).toFixed(1)}${e.limit === offered ? "  ←" : ""}`);
    return out;
}
