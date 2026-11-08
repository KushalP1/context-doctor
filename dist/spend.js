/**
 * `context-doctor spend`: one bill across every AI coding tool on this
 * machine, at list prices.
 *
 * Each tool keeps its own record of what it sent, and none adds them up:
 *
 *  - Claude Code: every reply's `usage` in its transcripts, the main
 *    conversation, each subagent's (`<session>/subagents/agent-*.jsonl`)
 *    and each workflow agent's (`<session>/subagents/workflows/<run>/`),
 *    read as `limits` reads them (claudeFileUsage): each reply once, its
 *    output settled on its last row, a fork's copy of its parent counted once.
 *  - Codex: the `token_count` events of its rollouts (~/.codex/sessions and
 *    archived_sessions), a request each time the running total moves, as
 *    `limits` counts them; the model from `turn_context`, the folder from
 *    `session_meta`.
 *  - Gemini CLI: each `gemini` message's `tokens` in ~/.gemini/tmp/<project>/chats,
 *    the last copy of a message written twice. A message later rewound was
 *    still billed, so it is counted.
 *  - Cursor: the `tokenCount` on its agent replies (cursorUsage). It records
 *    no cache split, so every input token is priced uncached: an estimate,
 *    and an upper bound. Replies on Auto ("default") have no list price and
 *    are counted, not priced.
 *
 * Priced at pricing.ts's list prices with what each request recorded that
 * changes its bill (requestCost: fast mode, US-only inference, a long
 * prompt's tier, web searches, a price past its end date), as every report
 * here is; the report says what the modifiers added.
 * Claude Code, Codex and Gemini CLI are read through the shared scan
 * (scan.ts), so a second run reads only what was appended since; Cursor's
 * replies are kept per chat until the chat changes.
 *
 * `savings` bills a narrower slice of the same Claude Code requests: the main
 * conversation's input (cache writes and reads included, output not), in
 * sessions with 10+ requests. `spend` counts every request, its output and
 * subagents too; on the requests both count, the dollars are the same.
 */
import { basename, dirname, join } from "node:path";
import { codexDir } from "./codexdir.js";
import { homedir } from "node:os";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { claudeFileUsage, claudeUsageFiles, codexEventKey, codexSessionsRoot, rolloutFiles } from "./limits.js";
import { listGeminiChats, readGeminiMessages } from "./gemini.js";
import { cursorClaudeId, cursorUsage, SqliteUnavailableError } from "./cursor.js";
import { addModifiers, isUnbilledModel, NO_MODIFIERS, openAIUsage, priceChangedText, requestCost } from "./pricing.js";
import { pick, rowsOf } from "./scan.js";
import { formatTokens } from "./tokens.js";
import { withInvocation } from "./invocation.js";
const DAY = 86_400_000;
export const TOOLS = ["claude", "codex", "gemini", "cursor"];
export const TOOL_NAME = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI", cursor: "Cursor" };
/**
 * A project folder's name (its path with "-" for separators, as Claude Code
 * names its projects/ folders) less the home folder: "-Users-<you>-" on
 * macOS, "-home-<you>-" (or "-root-") on Linux, "C--Users-<you>-" on Windows.
 * Only macOS's was stripped, so on Linux and Windows every project read
 * "home-kp-app" or "C--Users-kp-app".
 */
export function projectFromDir(dir) {
    return dir.replace(/^(?:[A-Za-z]-)?-(?:Users|home)-[^-]+-/, "").replace(/^-root-/, "").replace(/^-/, "") || dir;
}
/** A project's name as `savings` shows it: the folder's path with "-" for separators, less the home folder. */
export function projectName(folder) {
    return projectFromDir(folder.replace(/[^A-Za-z0-9]/g, "-"));
}
/** A Claude Code transcript's project: its folder under projects/, named as `savings` names it. */
function claudeProject(top) {
    return projectFromDir(basename(dirname(top)));
}
/** Whether a request's modifiers added anything (kept on an item only then). */
export const anyModifier = (m) => Boolean(m && (m.fastUsd || m.geoUsd || m.longUsd || m.webSearchUsd || m.webSearches));
/** An estimate's labels, and what the modifiers added, onto an item. */
function label(item, c) {
    if (c.estimated)
        item.estimated = true;
    if (c.changedOn)
        item.changedOn = c.changedOn;
    if (anyModifier(c.modifiers))
        item.modifiers = c.modifiers;
    return item;
}
/** `priceAs`: the id to price it by, when the model's own name is not one the table knows (Cursor's names for Claude). */
function priced(base, u, priceAs = base.model) {
    const c = requestCost(priceAs, u, base.ts);
    if (!c)
        return { ...base, usd: 0, inputUsd: 0, writeUsd: 0, readUsd: 0, outputUsd: 0, priced: false };
    return label({ ...base, usd: c.totalUsd, inputUsd: c.inputUsd, writeUsd: c.writeUsd, readUsd: c.readUsd, outputUsd: c.outputUsd, priced: true }, c);
}
// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------
/**
 * Claude Code's requests between `since` and `until`, main threads and
 * subagents, over `tops` (default: every transcript written since `since`).
 */
export function claudeSpend(since, until = Infinity, tops, onProgress) {
    const out = [];
    const runRows = new Set();
    const files = claudeUsageFiles(since, tops);
    for (const [i, f] of files.entries()) {
        onProgress?.(i, files.length);
        let reqs;
        try {
            reqs = claudeFileUsage(f.file, since, until, runRows);
        }
        catch {
            continue; // one unreadable transcript must not sink the report
        }
        const project = claudeProject(f.top);
        const session = basename(f.top, ".jsonl");
        for (const r of reqs) {
            const price = r.rates;
            // claudeFileUsage priced it (requestCost: writes by TTL, its modifiers); the split is what the drivers show.
            const inputUsd = price ? (r.input * price.inputPerM) / 1e6 : 0;
            const readUsd = price ? (r.read * price.cacheReadPerM) / 1e6 : 0;
            const item = {
                tool: "claude", ts: r.ts, project, session, input: r.input, read: r.read, write: r.write, output: r.output,
                usd: r.usd, inputUsd, readUsd, writeUsd: Math.max(0, r.promptUsd - inputUsd - readUsd), outputUsd: Math.max(0, r.usd - r.promptUsd - r.modifiers.webSearchUsd), priced: Boolean(price),
            };
            label(item, r);
            if (r.model)
                item.model = r.model;
            if (f.run)
                item.workflow = `${session}/${f.run}`;
            else if (f.subagent || r.sidechain)
                item.subagent = true;
            if (r.uuid)
                item.key = r.uuid;
            out.push(item);
        }
    }
    onProgress?.(files.length, files.length);
    return out;
}
// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------
/**
 * A spawned Codex agent's rollout names the thread that spawned it in its
 * own (first) session_meta: `parent_thread_id`, also under
 * `source.subagent.thread_spawn` (Codex Desktop 0.146, seen on the author's
 * machine; a forked one starts with a copy of its parent's history, its
 * session_meta rows included, which name no parent of theirs). A thread the
 * user forked names only `forked_from_id`: a session of its own.
 */
function spawnedBy(p) {
    const parent = p.parent_thread_id ?? p.source?.subagent?.thread_spawn?.parent_thread_id;
    return typeof parent === "string" && parent ? parent : undefined;
}
/**
 * What `spend` takes from a Codex rollout: its folder, its own id and the
 * thread that spawned it (the first session_meta), each model change, and
 * every token_count event's last request and running total.
 */
export const CODEX_SPEND_ROWS = {
    id: "codex-spend.3",
    init: () => ({}),
    line(line, row, out, st) {
        if (!line.includes('"token_count"') && !line.includes('"turn_context"') && !line.includes('"session_meta"'))
            return;
        let e;
        try {
            e = row();
        }
        catch {
            return;
        }
        const p = e?.payload;
        if (!p || typeof p !== "object")
            return;
        if (e.type === "session_meta" && !st.m) {
            st.m = 1;
            const parent = spawnedBy(p);
            if (typeof p.id === "string")
                out.push({ k: "meta", id: p.id, ...(parent ? { parent } : {}) });
        }
        if (e.type === "session_meta" || e.type === "turn_context") {
            if (typeof p.cwd === "string")
                out.push({ k: "cwd", cwd: p.cwd });
            if (e.type === "turn_context" && typeof p.model === "string")
                out.push({ k: "model", model: p.model });
            return;
        }
        if (e.type !== "event_msg" || p.type !== "token_count")
            return;
        const last = p.info?.last_token_usage;
        if (!last || typeof last !== "object")
            return;
        const total = p.info?.total_token_usage?.total_tokens;
        out.push({ k: "t", ts: String(e.timestamp ?? ""), total: typeof total === "number" ? total : 0, key: codexEventKey(p.info?.total_token_usage, last), u: pick(last, ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "input_tokens_details", "prompt_tokens", "prompt_tokens_details", "completion_tokens"]) });
    },
};
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
/** The requests of one Codex rollout since `since`. Throws when it cannot be read. */
export function codexFileSpend(file, since, until = Infinity) {
    const out = [];
    let model, cwd;
    let total = -1;
    for (const r of rowsOf(file, CODEX_SPEND_ROWS)) {
        if (r.k === "meta")
            continue;
        if (r.k === "cwd") {
            cwd = cwd ?? r.cwd;
            continue;
        }
        if (r.k === "model") {
            model = r.model;
            continue;
        }
        // A token_count event repeats the last request when only the limits were refreshed.
        const runTotal = num(r.total);
        if (num(r.u?.input_tokens) === 0 || (runTotal !== 0 && runTotal === total))
            continue;
        total = runTotal;
        const ts = Date.parse(r.ts);
        if (!Number.isFinite(ts) || ts < since || ts > until || isUnbilledModel(model))
            continue;
        const u = openAIUsage(r.u);
        out.push(priced({ tool: "codex", ts, project: cwd ? projectName(cwd) : "codex", session: basename(file, ".jsonl"), ...(model ? { model } : {}), input: num(u.input_tokens), read: num(u.cache_read_input_tokens), write: num(u.cache_creation_input_tokens), output: num(u.output_tokens), ...(r.key ? { key: r.key } : {}) }, u));
    }
    return out;
}
/** Codex rollouts written since `since`: the live ones and the archived. */
export function codexFiles(since, home = homedir()) {
    const roots = [codexSessionsRoot(home), join(codexDir(home), "archived_sessions")];
    return roots.filter((r) => existsSync(r)).flatMap((r) => rolloutFiles(r, since));
}
/** A Codex rollout's own thread id and the thread that spawned it, when one did (spawnedBy). Throws when it cannot be read. */
export function codexRolloutMeta(file) {
    const m = rowsOf(file, CODEX_SPEND_ROWS).find((r) => r?.k === "meta");
    return m ? { id: m.id, ...(m.parent ? { parent: m.parent } : {}) } : {};
}
/**
 * Every Codex request in the window, once: a forked rollout's copy of its
 * parent's (codexEventKey) counts at the earliest time met. A spawned
 * agent's requests are its session's (the thread at the top of its
 * parents, when its rollout is among the window's), marked `subagent`: they
 * bill to the same work, as a Claude Code subagent's do.
 */
export function codexSpend(since, until = Infinity, home = homedir()) {
    const all = [];
    const files = new Map();
    const byFile = [];
    for (const f of codexFiles(since, home)) {
        try {
            const items = codexFileSpend(f, since, until);
            const meta = codexRolloutMeta(f);
            if (meta.id && !files.has(meta.id))
                files.set(meta.id, { file: f, ...(meta.parent ? { parent: meta.parent } : {}) });
            byFile.push([f, items]);
        }
        catch { /* unreadable: skipped */ }
    }
    // Each spawned rollout's top known parent: its session.
    const sessionOf = new Map();
    for (const { file, parent } of files.values()) {
        let top;
        for (let p = parent, hops = 0; p && files.has(p) && hops < 32; p = files.get(p).parent, hops++)
            top = p;
        if (top)
            sessionOf.set(file, basename(files.get(top).file, ".jsonl"));
    }
    for (const [f, items] of byFile) {
        const session = sessionOf.get(f);
        for (const it of items)
            all.push(session ? { ...it, session, subagent: true } : it);
    }
    const seen = new Set();
    return all.sort((a, b) => a.ts - b.ts).filter((it) => !it.key || (!seen.has(it.key) && Boolean(seen.add(it.key))));
}
/** Rollout names end in the thread's id: rollout-<time>-<id>.jsonl. */
const rolloutId = (file) => /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(basename(file))?.[1];
/** The first line's start of a rollout (its own session_meta), as much as `bytes` holds. */
function rolloutHead(file, bytes = 16 * 1024) {
    const fd = openSync(file, "r");
    try {
        const buf = Buffer.alloc(bytes);
        const n = readSync(fd, buf, 0, bytes, 0);
        const text = buf.subarray(0, n).toString("utf8");
        const nl = text.indexOf("\n");
        return nl >= 0 ? text.slice(0, nl) : text;
    }
    finally {
        closeSync(fd);
    }
}
/** The thread a rollout's head says spawned it (spawnedBy), read from its first line without parsing the rest. */
function headParent(file) {
    const head = rolloutHead(file);
    try {
        const p = JSON.parse(head)?.payload ?? {};
        return { id: typeof p.id === "string" ? p.id : undefined, parent: spawnedBy(p) };
    }
    catch {
        // The line goes on past what was read (its instructions): its first fields are enough.
        return { id: /"id":"([^"]+)"/.exec(head)?.[1], parent: /"parent_thread_id":"([^"]+)"/.exec(head)?.[1] };
    }
}
/**
 * The rollouts of the agents a Codex thread spawned (and theirs), for the
 * session price: those written since the thread began in its own folder,
 * the day folders from then to `now` (by local and UTC date) and the
 * archive. Only each candidate's first line is read.
 */
export function codexSpawnedRollouts(parent, now = Date.now(), home = homedir()) {
    const id = rolloutId(parent);
    if (!id)
        return [];
    let born;
    try {
        born = statSync(parent).birthtimeMs || statSync(parent).mtimeMs;
    }
    catch {
        return [];
    }
    const m = /rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(basename(parent));
    if (m)
        born = Math.min(born, new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime());
    const root = codexSessionsRoot(home);
    const dirs = new Set([dirname(parent), join(codexDir(home), "archived_sessions")]);
    // A long session's days, a day either side; bounded, so a bad clock is not a walk of years.
    for (let t = Math.max(born, now - 90 * DAY) - DAY; t <= now + DAY; t += 3_600_000) {
        const d = new Date(t);
        for (const [y, mo, dd] of [[d.getFullYear(), d.getMonth() + 1, d.getDate()], [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]])
            dirs.add(join(root, String(y), String(mo).padStart(2, "0"), String(dd).padStart(2, "0")));
    }
    const heads = new Map();
    for (const dir of dirs) {
        let names;
        try {
            names = readdirSync(dir);
        }
        catch {
            continue;
        }
        for (const n of names) {
            const f = join(dir, n);
            if (!n.startsWith("rollout-") || !n.endsWith(".jsonl") || f === parent || heads.has(f))
                continue;
            try {
                if (statSync(f).mtimeMs < born)
                    continue;
                heads.set(f, headParent(f));
            }
            catch { /* vanished */ }
        }
    }
    // Children, then theirs.
    const mine = new Set([id]);
    const out = [];
    for (let grew = true; grew;) {
        grew = false;
        for (const [f, h] of heads) {
            if (!h.parent || !mine.has(h.parent) || !h.id || mine.has(h.id))
                continue;
            mine.add(h.id);
            out.push(f);
            grew = true;
        }
    }
    return out.sort((a, b) => basename(a).localeCompare(basename(b)));
}
// ---------------------------------------------------------------------------
// Gemini CLI
// ---------------------------------------------------------------------------
/**
 * What `spend` takes from a Gemini CLI chat (JSONL): each `gemini` message's
 * id, time, model and token counts. A message without a time of its own
 * takes the last time met before it.
 */
export const GEMINI_SPEND_ROWS = {
    id: "gemini-spend.1",
    init: () => ({ ts: "" }),
    line(line, row, out, st) {
        if (!line.includes('"tokens"') && !line.includes('"timestamp"') && !line.includes('"startTime"'))
            return;
        let r;
        try {
            r = row();
        }
        catch {
            return;
        }
        if (!r || typeof r !== "object")
            return;
        const at = typeof r.timestamp === "string" ? r.timestamp : typeof r.startTime === "string" ? r.startTime : "";
        if (at)
            st.ts = at;
        if (r.type !== "gemini" || !r.tokens || typeof r.tokens !== "object")
            return;
        const rec = { ts: st.ts, t: pick(r.tokens, ["input", "output", "cached", "thoughts"]) };
        if (typeof r.id === "string")
            rec.id = r.id;
        if (typeof r.model === "string")
            rec.model = r.model;
        out.push(rec);
    },
};
/** Gemini's counts as recorded usage: `input` includes the cached part; thoughts bill as output. */
function geminiUsage(t) {
    const input = num(t.input), cached = Math.min(input, num(t.cached));
    return { input_tokens: input - cached, cache_read_input_tokens: cached, cache_creation_input_tokens: 0, output_tokens: num(t.output) + num(t.thoughts) };
}
/** The billed messages of one Gemini CLI chat since `since`. Throws when it cannot be read. */
export function geminiFileSpend(file, since, until = Infinity) {
    // A message written again (its tokens arrive after its text) replaces the earlier copy.
    const byId = new Map();
    let anon = 0;
    if (file.endsWith(".jsonl")) {
        for (const r of rowsOf(file, GEMINI_SPEND_ROWS))
            byId.set(r.id ?? `anon-${anon++}`, r);
    }
    else {
        // Older Gemini CLI: one JSON document, small, read whole.
        let last = "";
        for (const m of readGeminiMessages(file)) {
            if (typeof m?.timestamp === "string")
                last = m.timestamp;
            if (m?.type === "gemini" && m.tokens && typeof m.tokens === "object")
                byId.set(typeof m.id === "string" ? m.id : `anon-${anon++}`, { ts: last, t: m.tokens, model: typeof m.model === "string" ? m.model : undefined });
        }
    }
    const project = basename(dirname(dirname(file)));
    const out = [];
    let model, mtime;
    for (const r of byId.values()) {
        model = r.model ?? model;
        // No time anywhere before it: the chat's last write.
        const ts = Date.parse(r.ts) || (mtime ??= statSync(file).mtimeMs);
        if (ts < since || ts > until || isUnbilledModel(model))
            continue;
        const u = geminiUsage(r.t);
        if (num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.output_tokens) === 0)
            continue;
        out.push(priced({ tool: "gemini", ts, project: /^[0-9a-f]{40,}$/.test(project) ? project.slice(0, 8) : project, session: basename(file).replace(/\.jsonl?$/, ""), ...(model ? { model } : {}), input: num(u.input_tokens), read: num(u.cache_read_input_tokens), write: 0, output: num(u.output_tokens) }, u));
    }
    return out;
}
export function geminiFiles(since, home = homedir()) {
    return listGeminiChats(home).filter((s) => s.modifiedAt.getTime() >= since).map((s) => s.path);
}
export function geminiSpend(since, until = Infinity, home = homedir()) {
    const out = [];
    for (const f of geminiFiles(since, home)) {
        try {
            out.push(...geminiFileSpend(f, since, until));
        }
        catch { /* unreadable: skipped */ }
    }
    return out;
}
// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------
export function cursorSpend(since, until = Infinity) {
    const out = [];
    for (const r of cursorUsage(since)) {
        if (r.ts > until || isUnbilledModel(r.model))
            continue;
        // No cache split: every input token at the uncached rate. Cursor's own
        // names for Claude ("claude-4.6-opus-high-thinking") are priced as the
        // Claude id they stand for, shown as Cursor wrote them.
        out.push(priced({ tool: "cursor", ts: r.ts, project: r.folder ? projectName(r.folder) : "(no folder)", session: r.composerId, ...(r.model ? { model: r.model } : {}), input: r.input, read: 0, write: 0, output: r.output }, { input_tokens: r.input, output_tokens: r.output }, cursorClaudeId(r.model) ?? r.model));
    }
    return out;
}
/** The local calendar day of `ts`, "YYYY-MM-DD". */
export function localDay(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function add(map, key, it) {
    const r = map.get(key) ?? map.set(key, { usd: 0, requests: 0, byTool: {} }).get(key);
    r.usd += it.usd;
    r.requests++;
    r.byTool[it.tool] = (r.byTool[it.tool] ?? 0) + it.usd;
}
/** "1 run", "12 runs": workflow runs. */
const runsText = (n) => `${n.toLocaleString("en-US")} ${n === 1 ? "run" : "runs"}`;
/** Add up priced requests into the report. */
export function summarizeSpend(items, days, since, until, skipped = []) {
    const tools = new Map();
    const projects = new Map(), models = new Map(), daily = new Map();
    const sessions = new Map();
    const sessionModels = new Map();
    const parts = { inputUsd: 0, writeUsd: 0, readUsd: 0, outputUsd: 0 };
    const runs = new Set();
    const mods = { ...NO_MODIFIERS };
    const changed = new Map();
    for (const it of items) {
        if (it.modifiers)
            addModifiers(mods, it.modifiers);
        if (it.changedOn) {
            const k = `${it.model}\u0000${it.changedOn}`;
            const c = changed.get(k) ?? changed.set(k, { model: it.model ?? "unknown", on: it.changedOn, requests: 0, usd: 0 }).get(k);
            c.requests++;
            c.usd += it.usd;
        }
        const t = tools.get(it.tool) ?? tools.set(it.tool, { tool: it.tool, name: TOOL_NAME[it.tool], usd: 0, requests: 0, tokens: { input: 0, read: 0, write: 0, output: 0 }, unpriced: 0, unpricedTokens: 0, unpricedModels: [], ...(it.tool === "cursor" ? { estimate: true } : {}), ...(it.tool === "claude" ? { subagentUsd: 0 } : {}) }).get(it.tool);
        t.usd += it.usd;
        t.requests++;
        t.tokens.input += it.input;
        t.tokens.read += it.read;
        t.tokens.write += it.write;
        t.tokens.output += it.output;
        if (it.subagent)
            t.subagentUsd = (t.subagentUsd ?? 0) + it.usd;
        if (it.workflow) {
            t.workflowUsd = (t.workflowUsd ?? 0) + it.usd;
            runs.add(it.workflow);
            t.workflowRuns = runs.size;
        }
        if (!it.priced) {
            t.unpriced++;
            t.unpricedTokens += it.input + it.read + it.write + it.output;
            const m = it.model ?? "unknown";
            if (!t.unpricedModels.includes(m))
                t.unpricedModels.push(m);
        }
        else if (it.estimated && !it.changedOn) {
            const e = (t.estimated ??= { requests: 0, usd: 0, models: [] });
            e.requests++;
            e.usd += it.usd;
            const m = it.model ?? "unknown";
            if (!e.models.includes(m))
                e.models.push(m);
        }
        add(projects, it.project, it);
        add(models, it.model ?? "unknown", it);
        add(daily, localDay(it.ts), it);
        parts.inputUsd += it.inputUsd;
        parts.writeUsd += it.writeUsd;
        parts.readUsd += it.readUsd;
        parts.outputUsd += it.outputUsd;
        const sk = `${it.tool}\u0000${it.session}`;
        const s = sessions.get(sk) ?? sessions.set(sk, { tool: it.tool, project: it.project, session: it.session, usd: 0, requests: 0, first: it.ts, last: it.ts }).get(sk);
        s.usd += it.usd;
        s.requests++;
        s.first = Math.min(s.first, it.ts);
        s.last = Math.max(s.last, it.ts);
        if (it.model) {
            const ms = sessionModels.get(sk) ?? sessionModels.set(sk, new Map()).get(sk);
            ms.set(it.model, (ms.get(it.model) ?? 0) + it.usd);
        }
    }
    // Each session's model: the one it spent most on.
    for (const [sk, ms] of sessionModels)
        sessions.get(sk).model = [...ms].sort((a, b) => b[1] - a[1])[0][0];
    const byUsd = (a, b) => b.usd - a.usd || b.requests - a.requests;
    // Every day of the window, the empty ones too: a day off reads as a day off.
    const days_ = [];
    const s0 = new Date(since);
    for (const d = new Date(s0.getFullYear(), s0.getMonth(), s0.getDate()); d.getTime() <= until; d.setDate(d.getDate() + 1)) {
        const day = localDay(d.getTime());
        days_.push({ day, ...(daily.get(day) ?? { usd: 0, requests: 0, byTool: {} }) });
    }
    if (mods.webSearchUsd > 0)
        parts.webSearchUsd = mods.webSearchUsd;
    return {
        days, since, until,
        usd: items.reduce((n, it) => n + it.usd, 0),
        requests: items.length,
        tools: TOOLS.filter((t) => tools.has(t)).map((t) => tools.get(t)).sort(byUsd),
        projects: [...projects].map(([project, r]) => ({ project, ...r })).sort(byUsd),
        models: [...models].map(([model, r]) => ({ model, ...r })).sort(byUsd),
        daily: days_,
        parts,
        ...(anyModifier(mods) ? { modifiers: mods } : {}),
        ...(changed.size ? { priceChanged: [...changed.values()].sort((a, b) => b.usd - a.usd) } : {}),
        sessions: [...sessions.values()].sort(byUsd),
        skipped,
    };
}
/**
 * The longest window: ten years, older than any history these tools keep.
 * Unbounded, `--days 10000000` listed every empty day of it (51 s, and
 * --json died on a string too long), and 1e9 days fell off the calendar.
 */
export const MAX_SPEND_DAYS = 3650;
/** The last `days` days, every tool on this machine. A tool with nothing on disk is just absent. */
export function spendReport(days = 30, opts = {}) {
    days = Math.min(days, MAX_SPEND_DAYS);
    const until = opts.now ?? Date.now();
    const since = until - days * DAY;
    const home = opts.home ?? homedir();
    const items = [...claudeSpend(since, until, opts.claudePaths, opts.onProgress), ...codexSpend(since, until, home), ...geminiSpend(since, until, home)];
    const skipped = [];
    try {
        items.push(...cursorSpend(since, until));
    }
    catch (e) {
        if (e instanceof SqliteUnavailableError)
            skipped.push({ tool: "cursor", reason: "reading Cursor's history needs SQLite: Node 22.13+ or the sqlite3 command" });
    }
    return summarizeSpend(items, days, since, until, skipped);
}
// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
export const usd = (n) => (n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : n > 0 && n < 0.005 ? "<$0.01" : `$${n.toFixed(2)}`);
const share = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDay = (day) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(8, 10)}`;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
/** "fast mode +$4.10, US-only +$0.93, web searches $0.12 (12), long-prompt tier +$0.40": what each billing modifier added, the ones that added anything. */
export function modifiersText(m) {
    return [
        m.fastUsd > 0 ? `fast mode +${usd(m.fastUsd)}` : "",
        m.geoUsd > 0 ? `US-only +${usd(m.geoUsd)}` : "",
        m.webSearches > 0 ? `web searches ${usd(m.webSearchUsd)} (${m.webSearches.toLocaleString("en-US")})` : "",
        m.longUsd > 0 ? `long-prompt tier +${usd(m.longUsd)}` : "",
    ].filter(Boolean).join(", ");
}
/** The full report, kept within 80 columns. `top`: rows per list. */
export function renderSpend(r, top = 8) {
    const lines = [];
    if (r.requests === 0) {
        lines.push(`No usage in the last ${r.days} days from Claude Code, Codex, Gemini CLI or Cursor on this machine.`);
        for (const s of r.skipped)
            lines.push(`${TOOL_NAME[s.tool]} not read: ${s.reason}.`);
        return lines.join("\n");
    }
    lines.push("What your AI coding cost, across every tool here");
    lines.push(`Last ${r.days === 1 ? "day" : `${r.days} days`}, at list prices`);
    lines.push("─".repeat(60));
    for (const t of r.tools) {
        const unit = t.tool === "cursor" ? "replies" : "requests";
        const notes = [t.estimate ? "estimate, no cache split" : t.subagentUsd ? `subagents ${usd(t.subagentUsd)}` : "", t.workflowUsd ? `workflows ${usd(t.workflowUsd)} (${runsText(t.workflowRuns ?? 0)})` : "", t.unpriced ? `${t.unpriced.toLocaleString("en-US")} not priced` : ""].filter(Boolean);
        const note = notes.length ? `  ${notes.join(", ")}` : "";
        lines.push(`${t.name.padEnd(14)}${`${t.estimate ? "~" : ""}${usd(t.usd)}`.padStart(11)}  ${`${t.requests.toLocaleString("en-US")} ${unit}`.padEnd(16)}${note}`);
    }
    if (r.tools.length > 1)
        lines.push(`${"Total".padEnd(14)}${usd(r.usd).padStart(11)}`);
    const list = (title, rows, more) => {
        lines.push("", title);
        for (const x of rows)
            lines.push(`  ${clip(x.name, 34).padEnd(34)}${usd(x.usd).padStart(10)}  ${share(x.usd, r.usd).padStart(4)}${x.tail ? `  ${x.tail}` : ""}`);
        if (more > 0)
            lines.push(`  … and ${more} more`);
    };
    const toolsOf = (byTool) => (r.tools.length > 1 ? TOOLS.filter((t) => (byTool[t] ?? 0) > 0).map((t) => TOOL_NAME[t]).join(", ") : undefined);
    list("By project", r.projects.slice(0, top).map((p) => ({ name: p.project, usd: p.usd, tail: toolsOf(p.byTool) })), r.projects.length - top);
    // A model with no list price reads "not priced", not a $0.00 that looks free.
    const unpricedModels = new Set(r.tools.flatMap((t) => t.unpricedModels));
    // One priced by its family's row reads as the estimate it is.
    const estimatedModels = new Set(r.tools.flatMap((t) => t.estimated?.models ?? []));
    // One priced past the day its price changed, likewise.
    const changedOn = new Map((r.priceChanged ?? []).map((c) => [c.model, c.on]));
    list("By model", r.models.slice(0, top).map((m) => ({ name: m.model, usd: m.usd, ...(m.usd === 0 && unpricedModels.has(m.model) ? { tail: `not priced, ${m.requests.toLocaleString("en-US")} ${m.requests === 1 ? "request" : "requests"}` } : estimatedModels.has(m.model) ? { tail: "estimate: its family's price" } : changedOn.has(m.model) ? { tail: `estimate: price changed ${changedOn.get(m.model)}` } : {}) })), r.models.length - top);
    // The last two weeks of the window, a bar each, scaled to the busiest.
    const recent = r.daily.slice(-14);
    const peak = Math.max(...recent.map((d) => d.usd), 0);
    lines.push("", `By day${r.daily.length > recent.length ? " (last 14; all in --json)" : ""}`);
    for (const d of recent)
        lines.push(`  ${shortDay(d.day)}  ${usd(d.usd).padStart(9)}  ${peak > 0 ? "▮".repeat(Math.round((d.usd / peak) * 30)) : ""}`);
    lines.push("", "Where it goes");
    const parts = [["cache writes", r.parts.writeUsd], ["cache reads", r.parts.readUsd], ["output", r.parts.outputUsd], ["uncached input", r.parts.inputUsd], ["web searches", r.parts.webSearchUsd ?? 0]];
    const partText = parts.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${usd(v)} (${share(v, r.usd)})`);
    for (let i = 0; i < partText.length; i += 2)
        lines.push(`  ${partText.slice(i, i + 2).join(", ")}`);
    // What the requests' own billing added to the list rates, already in the parts above.
    if (r.modifiers)
        lines.push(`  Of it, billed above list rates: ${modifiersText(r.modifiers)}`);
    const claude = r.tools.find((t) => t.tool === "claude");
    if (claude?.subagentUsd)
        lines.push(`  Claude Code subagents ${usd(claude.subagentUsd)} (${share(claude.subagentUsd, r.usd)}): context-doctor subagents says which paid off`);
    if (claude?.workflowUsd)
        lines.push(`  Claude Code workflow agents ${usd(claude.workflowUsd)} (${share(claude.workflowUsd, r.usd)}), in ${runsText(claude.workflowRuns ?? 0)}`);
    lines.push("  Biggest sessions:");
    for (const s of r.sessions.slice(0, Math.min(top, 5))) {
        const when = shortDay(localDay(s.last));
        lines.push(`  ${usd(s.usd).padStart(9)}  ${clip(s.project, 26).padEnd(26)} ${clip(s.model ?? "", 18).padEnd(18)} ${when}${r.tools.length > 1 ? `  ${TOOL_NAME[s.tool]}` : ""}`);
    }
    const notes = [];
    for (const t of r.tools) {
        if (t.unpriced === 0)
            continue;
        const auto = t.tool === "cursor" && t.unpricedModels.every((m) => m === "default" || m === "auto");
        notes.push(`${t.unpriced.toLocaleString("en-US")} ${t.name} ${t.tool === "cursor" ? "replies" : "requests"} (${formatTokens(t.unpricedTokens)} tokens) not priced:`);
        notes.push(`  ${auto ? "on Auto, which Cursor bills from your plan with no list price" : `no list price for ${t.unpricedModels.slice(0, 3).join(", ")}`}.`);
    }
    for (const t of r.tools) {
        if (!t.estimated)
            continue;
        const n = t.estimated.requests;
        notes.push(`${n.toLocaleString("en-US")} ${t.name} ${t.tool === "cursor" ? (n === 1 ? "reply" : "replies") : n === 1 ? "request" : "requests"} (${usd(t.estimated.usd)}) priced as ${n === 1 ? "its" : "their"} model's family, an estimate:`);
        notes.push(`  no list price of its own for ${t.estimated.models.slice(0, 3).join(", ")}${t.estimated.models.length > 3 ? " and others" : ""}.`);
    }
    if (r.priceChanged) {
        const n = r.priceChanged.reduce((s, c) => s + c.requests, 0);
        notes.push(`${n.toLocaleString("en-US")} ${n === 1 ? "request" : "requests"} (${usd(r.priceChanged.reduce((s, c) => s + c.usd, 0))}) priced past the day ${n === 1 ? "its" : "their"} model's price changed, an estimate:`);
        notes.push(`  ${priceChangedText(r.priceChanged.map((c) => [c.model, c.on]))}.`);
    }
    if (r.tools.some((t) => t.estimate))
        notes.push("Cursor records no cache split: its input is priced uncached, an upper bound.");
    for (const s of r.skipped)
        notes.push(`${TOOL_NAME[s.tool]} not read: ${s.reason}.`);
    if (notes.length)
        lines.push("", ...notes);
    lines.push("", "List prices, as an API key bills; on a subscription the same tokens come out");
    lines.push("of your plan's limits instead. Share yours: context-doctor spend --share");
    return withInvocation(lines.map((l) => l.trimEnd()).join("\n"));
}
/**
 * `spend --share`: totals only. No project names, paths or session ids, so
 * sharing it leaks nothing.
 */
export function renderSpendShare(r) {
    if (r.requests === 0)
        return "context-doctor found no AI coding usage to measure yet.";
    const tools = r.tools.map((t) => `${t.name} ${t.estimate ? "~" : ""}${usd(t.usd)}${t.estimate ? " (estimate)" : ""}`).join(", ");
    const lines = [`My AI coding, last ${r.days === 1 ? "day" : `${r.days} days`}, at list prices: ${usd(r.usd)}${r.tools.length > 1 ? ` (${tools})` : ` in ${r.tools[0].name}`}.`];
    const claude = r.tools.find((t) => t.tool === "claude");
    if (claude?.subagentUsd)
        lines.push(`Claude Code subagents: ${usd(claude.subagentUsd)} of it.`);
    if (claude?.workflowUsd)
        lines.push(`Claude Code workflow agents: ${usd(claude.workflowUsd)} of it, in ${runsText(claude.workflowRuns ?? 0)}.`);
    // Requests on a model with no list price are not in the total: said, so the total is not read as all of it.
    const unpriced = r.tools.reduce((n, t) => n + t.unpriced, 0);
    if (unpriced)
        lines.push(`Not in it: ${unpriced.toLocaleString("en-US")} ${unpriced === 1 ? "request" : "requests"} (${formatTokens(r.tools.reduce((n, t) => n + t.unpricedTokens, 0))} tokens) on models with no list price.`);
    const estimated = r.tools.reduce((n, t) => n + (t.estimated?.usd ?? 0), 0);
    if (r.tools.some((t) => t.estimated))
        lines.push(`Of it, ${usd(estimated)} is on models priced as their family, an estimate.`);
    if (r.priceChanged)
        lines.push(`Of it, ${usd(r.priceChanged.reduce((s, c) => s + c.usd, 0))} is on models priced past the day their price changed, an estimate.`);
    if (r.modifiers)
        lines.push(`Billed above list rates: ${modifiersText(r.modifiers)}.`);
    const parts = [["cache writes", r.parts.writeUsd], ["cache reads", r.parts.readUsd], ["output", r.parts.outputUsd], ["uncached input", r.parts.inputUsd], ["web searches", r.parts.webSearchUsd ?? 0]];
    const [bigPart, bigUsd] = parts.sort((a, b) => b[1] - a[1])[0];
    const busiest = [...r.daily].sort((a, b) => b.usd - a.usd)[0];
    if (r.models[0] && r.usd > 0)
        lines.push(`Top model ${r.models[0].model} (${share(r.models[0].usd, r.usd)}); the biggest part is ${bigPart} (${share(bigUsd, r.usd)}); busiest day ${usd(busiest.usd)}.`);
    lines.push("Measured locally from my own history with context-doctor: npx context-doctor spend");
    return lines.join("\n");
}
