/**
 * OpenCode's record of what it sent: each assistant message's `tokens`.
 * Checked 2026-11-15 against ccusage's OpenCode loader (rust/adapters/opencode)
 * and its docs. OpenCode keeps its data in `${XDG_DATA_HOME:-~/.local/share}/opencode`
 * (`OPENCODE_DATA_DIR`, a comma list, instead), in one of three places:
 *
 *  - `storage/message/<sessionID>/<messageID>.json` (before its SQLite store):
 *    `{id, sessionID, role, modelID, providerID, time: {created}, tokens:
 *    {input, output, reasoning, cache: {read, write}, total}, path: {cwd, root}}`.
 *  - `opencode.db`, table `message`: the same object in `data`.
 *  - `opencode.db`, table `session_message` (its v2 store): rows of `type`
 *    "assistant" or "compaction" (a compaction is billed apart; only a
 *    "completed" one), the model as `model: {id, providerID}`. A forked
 *    session starts with a copy of its parent's rows, new ids and the same
 *    `seq`; `session_v2.fork_boundary` says up to which (its "through" or
 *    "before" a parent message): those copies are not counted again.
 *
 * `tokens.input` is the uncached input; reasoning bills as output, and a
 * `total` above the parts is output too (as ccusage counts it). A message
 * on OpenCode's `claude-agent` provider ran inside Claude Code, whose own
 * transcript `spend` already reads: not counted here. The same message in
 * the JSON files and the database (a store that was migrated) is counted once.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { queryRows, SqliteUnavailableError } from "./cursor.js";
/** OpenCode's data folders: $OPENCODE_DATA_DIR's (when `home` is this user's), else <XDG data>/opencode. */
export function opencodeDataDirs(home = homedir()) {
    const own = home === homedir();
    if (own && process.env.OPENCODE_DATA_DIR)
        return process.env.OPENCODE_DATA_DIR.split(",").map((s) => s.trim()).filter(Boolean);
    return [join(own && process.env.XDG_DATA_HOME ? process.env.XDG_DATA_HOME : join(home, ".local", "share"), "opencode")];
}
const num = (v) => {
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
};
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const parse = (v) => {
    if (typeof v !== "string")
        return v;
    try {
        return JSON.parse(v);
    }
    catch {
        return undefined;
    }
};
/** The counts of one message's `tokens`, as billed: reasoning, and a total above the parts, as output. */
export function opencodeTokens(t) {
    if (!t || typeof t !== "object")
        return undefined;
    const input = num(t.input), read = num(t.cache?.read), write = num(t.cache?.write);
    let output = num(t.output) + num(t.reasoning);
    const missing = num(t.total) - (input + read + write + output);
    if (missing > 0)
        output += missing;
    return input + read + write + output > 0 ? { input, read, write, output } : undefined;
}
/** A message object (a JSON file's, or a database row's `data`) as a call; undefined when it is not one. */
function fromMessage(m, id, session, created) {
    if (!m || typeof m !== "object")
        return undefined;
    if (m.role !== undefined && m.role !== "assistant")
        return undefined;
    const tokens = opencodeTokens(m.tokens);
    if (!tokens)
        return undefined;
    const model = text(m.model?.id) ?? text(m.model?.modelID) ?? text(m.modelID);
    const provider = text(m.model?.providerID) ?? text(m.providerID);
    const ts = num(m.time?.created) || num(created);
    if (!ts)
        return undefined;
    const c = { id, ts, session, ...tokens };
    if (model)
        c.model = model;
    if (provider)
        c.provider = provider;
    if (text(m.path?.cwd))
        c.cwd = m.path.cwd;
    if (text(m.path?.root) && m.path.root !== "/")
        c.root = m.path.root;
    return c;
}
/** The JSON files' messages written since `since`. */
function jsonCalls(dir, since, out, dirs) {
    const sessionsRoot = join(dir, "storage", "session");
    if (existsSync(sessionsRoot)) {
        for (const project of safeList(sessionsRoot))
            for (const f of safeList(join(sessionsRoot, project))) {
                if (!f.endsWith(".json"))
                    continue;
                try {
                    const s = JSON.parse(readFileSync(join(sessionsRoot, project, f), "utf8"));
                    if (text(s?.id) && text(s?.directory))
                        dirs.set(s.id, s.directory);
                }
                catch { /* not a session */ }
            }
    }
    const root = join(dir, "storage", "message");
    for (const session of safeList(root)) {
        const folder = join(root, session);
        for (const f of safeList(folder)) {
            if (!f.endsWith(".json"))
                continue;
            const file = join(folder, f);
            try {
                if (statSync(file).mtimeMs < since)
                    continue;
                const m = JSON.parse(readFileSync(file, "utf8"));
                const id = text(m?.id) ?? f.slice(0, -5);
                const c = fromMessage(m, id, text(m?.sessionID) ?? session);
                if (c && !out.has(id))
                    out.set(id, c);
            }
            catch { /* unreadable: skipped */ }
        }
    }
}
function safeList(dir) {
    try {
        return readdirSync(dir);
    }
    catch {
        return [];
    }
}
/** A query that may fail on an older schema (no such table or column): undefined. SQLite missing altogether still throws. */
function tryRows(db, sql) {
    try {
        return queryRows(db, sql);
    }
    catch (e) {
        if (e instanceof SqliteUnavailableError)
            throw e;
        return undefined;
    }
}
const rows = (db, sql) => tryRows(db, sql) ?? [];
/**
 * A WHERE on `time_created` for rows since `since`, a day early, when the
 * column is there and holds milliseconds (its largest value); else none,
 * and the message's own time decides.
 */
function windowClause(db, table, since) {
    const max = tryRows(db, `SELECT MAX(time_created) AS m FROM ${table}`)?.[0]?.m;
    return typeof max === "number" && max > 1e11 ? ` AND time_created >= ${Math.floor(since) - 86_400_000}` : "";
}
/** For each forked v2 session, the last `seq` that is a copy of its parent's history. */
function forkCutoffs(db) {
    const cut = new Map();
    for (const f of rows(db, "SELECT id, fork_session_id AS parent, fork_boundary AS boundary FROM session_v2 WHERE fork_session_id IS NOT NULL AND fork_boundary IS NOT NULL")) {
        const b = parse(f.boundary);
        const parent = text(f.parent), mid = text(b?.messageID);
        if (!text(f.id) || !parent || !mid || (b.type !== "through" && b.type !== "before"))
            continue;
        const esc = (s) => s.replace(/'/g, "''");
        const at = rows(db, `SELECT seq FROM session_message WHERE session_id = '${esc(parent)}' AND id = '${esc(mid)}' LIMIT 1`)[0]?.seq;
        if (typeof at !== "number")
            continue;
        if (b.type === "through")
            cut.set(f.id, at);
        else {
            const before = rows(db, `SELECT MAX(seq) AS seq FROM session_message WHERE session_id = '${esc(parent)}' AND seq < ${at}`)[0]?.seq;
            if (typeof before === "number")
                cut.set(f.id, before);
        }
    }
    return cut;
}
/** The database's messages since `since` (both tables), and each session's folder. */
function dbCalls(db, since, out, dirs) {
    for (const table of ["session", "session_v2"])
        for (const s of rows(db, `SELECT id, directory FROM ${table}`))
            if (text(s.id) && text(s.directory))
                dirs.set(s.id, s.directory);
    // Only the fields read, projected in SQL: a row's data can be large.
    const fields = "json_extract(data, '$.role') AS role, json_extract(data, '$.modelID') AS modelID, json_extract(data, '$.providerID') AS providerID, json_extract(data, '$.model') AS model, json_extract(data, '$.tokens') AS tokens, json_extract(data, '$.time.created') AS created, json_extract(data, '$.path') AS path";
    for (const r of rows(db, `SELECT id, session_id, ${fields} FROM message WHERE 1${windowClause(db, "message", since)}`)) {
        const c = fromMessage({ role: r.role, modelID: r.modelID, providerID: r.providerID, model: parse(r.model), tokens: parse(r.tokens), time: { created: r.created }, path: parse(r.path) }, String(r.id), String(r.session_id));
        if (c && !out.has(c.id))
            out.set(c.id, c);
    }
    const cut = forkCutoffs(db);
    const win = windowClause(db, "session_message", since);
    const v2sql = (seq) => `SELECT id, session_id, type, time_created${seq ? ", seq" : ""}, json_extract(data, '$.status') AS status, ${fields} FROM session_message WHERE type IN ('assistant', 'compaction')${win}`;
    for (const r of tryRows(db, v2sql(true)) ?? rows(db, v2sql(false))) {
        const session = String(r.session_id);
        const c0 = cut.get(session);
        if (c0 !== undefined && typeof r.seq === "number" && r.seq <= c0)
            continue;
        const compaction = r.type === "compaction";
        if (compaction && r.status !== "completed")
            continue;
        const c = fromMessage({ modelID: r.modelID, providerID: r.providerID, model: parse(r.model), tokens: parse(r.tokens), time: { created: r.created }, path: parse(r.path) }, String(r.id), session, num(r.time_created));
        if (!c || out.has(c.id))
            continue;
        if (compaction)
            c.compaction = true;
        out.set(c.id, c);
    }
}
/**
 * Every OpenCode model call between `since` and `until`, each once, less
 * those on the claude-agent provider. `sqlite`: false when an opencode.db
 * was there and this runtime cannot read SQLite.
 */
export function opencodeCalls(since, until = Infinity, home = homedir()) {
    const out = new Map();
    const dirs = new Map();
    let sqlite = true;
    for (const dir of opencodeDataDirs(home)) {
        if (!existsSync(dir))
            continue;
        const db = join(dir, "opencode.db");
        if (existsSync(db)) {
            try {
                dbCalls(db, since, out, dirs);
            }
            catch (e) {
                if (e instanceof SqliteUnavailableError)
                    sqlite = false;
            }
        }
        jsonCalls(dir, since, out, dirs);
    }
    const calls = [...out.values()].filter((c) => c.ts >= since && c.ts <= until && c.provider !== "claude-agent");
    for (const c of calls)
        if (!c.cwd && dirs.has(c.session))
            c.cwd = dirs.get(c.session);
    return { calls: calls.sort((a, b) => a.ts - b.ts), sqlite };
}
