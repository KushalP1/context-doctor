/**
 * One read of each transcript per run, and a cache of what each analysis
 * takes from it.
 *
 * `fix` and `savings` run up to six analyses (autopilot's replay, the
 * compaction check, the compact-window replay, cache misses, the output
 * lens, both cache lifetimes; `overhead` two more), and each used to read
 * and parse every transcript again:
 * 2.7 GB and 470k rows on the author's machine, ~5 s a pass, 19-37 s a run.
 * Here each analysis is an `Extractor`: it turns a transcript's lines into
 * the few records it needs (a request's usage and time, a compaction, a
 * read), and the analysis itself runs over those records, with the same code
 * and in the same order as before, so every figure is unchanged.
 *
 * - One pass, shared parse: `prescan` reads each transcript once for every
 *   extractor that has nothing cached for it, and parses each row once.
 * - A cache under ~/.cache/context-doctor (`CONTEXT_DOCTOR_CACHE_DIR`, or
 *   `XDG_CACHE_HOME`; `CONTEXT_DOCTOR_NO_CACHE=1` keeps nothing on disk), one
 *   file per transcript and extractor, keyed by the transcript's path, size,
 *   modification time and inode. A transcript that only grew (Claude Code
 *   appends) is read from where the last run stopped, the extractor's state
 *   carried over; the replay, whose state is the whole conversation, reads a
 *   changed file again in full.
 * - Safe when runs overlap: every write is a whole file renamed into place;
 *   a damaged or foreign file reads as a miss.
 * - Bounded: entries for transcripts gone or untouched for 120 days, other
 *   versions' entries and stray temporary files are removed once a day, and
 *   the oldest entries go while the cache is over 256 MB
 *   (`CONTEXT_DOCTOR_CACHE_MAX_MB`).
 * - A new context-doctor version, or a new extractor id, starts empty.
 * - No message text: token counts, times, ids, models, tool, server and
 *   skill names, the files a session read and its working folder (a prompt
 *   only as its length; a tool call's input only as a hash), in files only
 *   you can read (0600, folders 0700), as the transcripts are.
 *
 * Records must hold only JSON (numbers, strings, plain objects and arrays):
 * a record read from disk must equal the one computed, or the figures would
 * differ between a cold run and a warm one.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PROXY_VERSION } from "./proxy.js";
/** Bumped when the entry layout below changes. */
const SCHEMA = 1;
const DAY = 86_400_000;
/** Bytes hashed at each end of the part already read, to tell a grown file from a rewritten one. */
const ANCHOR = 64 * 1024;
/**
 * Files this small are also compared by content: rewritten within one tick
 * of a coarse clock at the same size (a test fixture, a hand-made file),
 * size and time alone would not tell. Claude Code only appends.
 */
const SMALL = 64 * 1024;
const memo = new Map();
const key = (path, id) => `${id}\u0000${path}`;
/** Where the cache lives (created only when something is written). */
export function scanCacheDir(env = process.env) {
    if (env.CONTEXT_DOCTOR_CACHE_DIR)
        return env.CONTEXT_DOCTOR_CACHE_DIR;
    const xdg = env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : join(homedir(), ".cache");
    return join(xdg, "context-doctor");
}
const disabled = () => process.env.CONTEXT_DOCTOR_NO_CACHE === "1";
const versionDir = () => join(scanCacheDir(), "transcripts", `v${SCHEMA}-${PROXY_VERSION}`);
const entryFile = (path, id) => join(versionDir(), id.replace(/[^\w.-]/g, "_"), `${createHash("sha1").update(path).digest("hex")}.json`);
function statOf(path) {
    try {
        const s = statSync(path);
        return { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino };
    }
    catch {
        return undefined;
    }
}
const same = (e, s) => e.size === s.size && e.mtimeMs === s.mtimeMs && e.ino === s.ino;
function fingerprint(path, size) {
    if (size > SMALL)
        return undefined;
    try {
        return createHash("sha1").update(readFileSync(path)).digest("hex");
    }
    catch {
        return undefined;
    }
}
/** Still describes the file: same size, time and inode, and for a small file the same content. */
function current(e, s, path, fp) {
    if (!same(e, s))
        return false;
    if (s.size > SMALL)
        return true;
    if (!fp.done) {
        fp.v = fingerprint(path, s.size);
        fp.done = true;
    }
    return e.fp !== undefined && e.fp === fp.v;
}
function load(path, id) {
    if (disabled())
        return undefined;
    try {
        const e = JSON.parse(readFileSync(entryFile(path, id), "utf8"));
        if (e && e.path === path && e.id === id && Array.isArray(e.rows) && Array.isArray(e.tail) && typeof e.off === "number")
            return e;
    }
    catch {
        /* no entry, or a damaged one: a miss */
    }
    return undefined;
}
let wrote = false;
function persist(e) {
    if (disabled())
        return;
    const file = entryFile(e.path, e.id);
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
        // Yours only, like the transcripts: file paths and project folders are in it.
        mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
        writeFileSync(tmp, JSON.stringify(e), { mode: 0o600 });
        renameSync(tmp, file);
        if (!wrote) {
            wrote = true;
            pruneScanCache();
        }
    }
    catch {
        // A full disk or a read-only cache: the run goes on without it.
        try {
            unlinkSync(tmp);
        }
        catch { /* never written */ }
    }
}
function anchorOf(fd, off) {
    const h = createHash("sha1");
    const read = (start, len) => {
        const buf = Buffer.alloc(len);
        const n = readSync(fd, buf, 0, len, start);
        h.update(buf.subarray(0, n));
    };
    read(0, Math.min(ANCHOR, off));
    if (off > ANCHOR)
        read(Math.max(ANCHOR, off - ANCHOR), Math.min(ANCHOR, off - ANCHOR));
    h.update(String(off));
    return h.digest("hex");
}
/**
 * Lines from byte `start`, split as `forEachLine` splits them ("\n"; a last
 * line without one still counts, with `complete` false), each with the byte
 * offset it starts at. Returns the offset after the last newline and the
 * bytes read in all.
 */
function readLines(fd, start, onLine) {
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
    let pos = start, off = start;
    let carry = [];
    for (;;) {
        const n = readSync(fd, buf, 0, buf.length, pos);
        if (n === 0)
            break;
        let s = 0;
        for (;;) {
            const nl = buf.indexOf(10, s);
            if (nl === -1 || nl >= n)
                break;
            const part = buf.subarray(s, nl);
            const raw = carry.length ? Buffer.concat([...carry, part]).toString("utf8") : part.toString("utf8");
            carry = [];
            const at = off;
            off = pos + nl + 1;
            onLine(raw, at, true);
            s = nl + 1;
        }
        if (s < n)
            carry.push(Buffer.from(buf.subarray(s, n)));
        pos += n;
    }
    if (carry.length)
        onLine(Buffer.concat(carry).toString("utf8"), off, false);
    return { off, end: pos };
}
/**
 * Make sure every extractor has current records for `path`, reading the file
 * at most once. `transient`: read it for these extractors whatever is
 * cached, and keep nothing (returned instead).
 */
function ensure(path, exs, transient = false) {
    const st = statOf(path);
    if (!st)
        return [];
    const jobs = [];
    const made = [];
    const fp = {};
    for (const ex of exs) {
        if (transient) {
            jobs.push({ ex, from: 0, state: ex.init(), rows: [], tail: [] });
            continue;
        }
        const k = key(path, ex.id);
        const m = memo.get(k);
        if (m && current(m, st, path, fp))
            continue;
        const d = load(path, ex.id);
        if (d && current(d, st, path, fp)) {
            memo.set(k, d);
            continue;
        }
        const prior = [d, m].find((p) => p && ex.resumable !== false && p.ino === st.ino && st.size > p.size && p.off <= st.size);
        // Grown in place (Claude Code appends): carry on from where the cached part ended.
        jobs.push(prior ? { ex, from: prior.off, state: prior.state, rows: prior.rows, tail: [], prior } : { ex, from: 0, state: ex.init(), rows: [], tail: [] });
    }
    if (jobs.length === 0)
        return made;
    let fd;
    try {
        fd = openSync(path, "r");
    }
    catch {
        return made;
    }
    try {
        for (const j of jobs) {
            // Its start no longer matches what was read before: a rewritten file, read again in full.
            if (j.prior && (j.prior.off === 0 || anchorOf(fd, j.prior.off) !== j.prior.anchor))
                Object.assign(j, { from: 0, state: j.ex.init(), rows: [], prior: undefined });
            // Never extend the cached arrays themselves: another reader may hold them.
            if (j.prior)
                Object.assign(j, { state: structuredClone(j.state), rows: j.rows.slice() });
        }
        const start = Math.min(...jobs.map((j) => j.from));
        let tailStates;
        const { off, end } = readLines(fd, start, (raw, at, complete) => {
            let parsed, failed, done = false;
            const row = () => {
                if (!done) {
                    done = true;
                    try {
                        parsed = JSON.parse(raw);
                    }
                    catch (e) {
                        failed = e ?? new SyntaxError("not JSON");
                    }
                }
                if (failed !== undefined)
                    throw failed;
                return parsed;
            };
            if (complete) {
                for (const j of jobs)
                    if (at >= j.from)
                        j.ex.line(raw, row, j.rows, j.state);
                return;
            }
            // The last line has no newline yet: a resumable extractor reads it from a
            // copy of its state, into the tail, so the next run can resume before it.
            tailStates = jobs.map((j) => (j.ex.resumable === false ? j.state : structuredClone(j.state)));
            jobs.forEach((j, i) => { if (at >= j.from)
                j.ex.line(raw, row, j.ex.resumable === false ? j.rows : j.tail, tailStates[i]); });
        });
        let after;
        try {
            const s = fstatSync(fd);
            after = { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino };
        }
        catch { /* gone */ }
        // Written to while being read: these records hold for what was read, but are not kept.
        const settled = after !== undefined && after.size === end;
        const anchor = jobs.some((j) => j.ex.resumable !== false) ? anchorOf(fd, off) : "";
        const small = settled && end <= SMALL ? fingerprint(path, end) : undefined;
        jobs.forEach((j, i) => {
            const resumable = j.ex.resumable !== false;
            if (j.ex.end) {
                const endState = tailStates ? tailStates[i] : resumable ? structuredClone(j.state) : j.state;
                j.ex.end(resumable ? j.tail : j.rows, endState);
            }
            const e = {
                path, id: j.ex.id, size: end, mtimeMs: settled ? after.mtimeMs : -1, ino: after?.ino ?? st.ino,
                off: resumable ? off : end, anchor: resumable ? anchor : "", state: resumable ? j.state : null, rows: j.rows, tail: j.tail,
                ...(small !== undefined ? { fp: small } : {}),
            };
            made.push(e);
            if (transient)
                return;
            memo.set(key(path, j.ex.id), e);
            if (settled)
                persist(e);
        });
    }
    finally {
        closeSync(fd);
    }
    return made;
}
/**
 * Read every transcript once for all the extractors that need it (each job:
 * an extractor set and its transcripts), so the analyses that follow find
 * their records ready. Optional: an analysis reads whatever is missing itself.
 */
export function prescan(jobs, onProgress) {
    const need = new Map();
    for (const j of jobs)
        for (const p of j.paths) {
            const s = need.get(p) ?? need.set(p, new Set()).get(p);
            for (const ex of j.extractors)
                s.add(ex);
        }
    let i = 0;
    for (const [p, exs] of need) {
        onProgress?.(i++, need.size);
        try {
            ensure(p, [...exs]);
        }
        catch { /* the analysis reads it again, and skips it as before */ }
    }
    onProgress?.(need.size, need.size);
}
/**
 * The records `ex` takes from one transcript, in file order: from this run's
 * memory, the cache, or a read of the file (only the part not yet read when
 * it grew). Throws when the transcript cannot be read, as forEachLine does.
 * `keep: false` reads the file afresh and keeps nothing (an extractor with
 * options of its own, which its id does not name).
 */
export function rowsOf(path, ex, opts = {}) {
    const st = statOf(path);
    const e = opts.keep === false ? ensure(path, [ex], true)[0] : (ensure(path, [ex]), memo.get(key(path, ex.id)));
    if (!st || !e) {
        // Unreadable: the error the analyses always met (they skip the transcript).
        closeSync(openSync(path, "r"));
        throw new Error(`unreadable transcript: ${path}`);
    }
    return (e.tail.length ? e.rows.concat(e.tail) : e.rows);
}
/** Forget this run's records (tests). */
export function clearScanMemo() {
    memo.clear();
}
/**
 * Keep the cache bounded, at most once a day: other versions' entries, stray
 * temporary files, entries whose transcript is gone or untouched for 120
 * days, then the oldest entries while over the size cap.
 */
export function pruneScanCache(now = Date.now(), force = false) {
    if (disabled())
        return;
    const root = join(scanCacheDir(), "transcripts");
    const marker = join(root, ".pruned");
    try {
        if (!force && now - statSync(marker).mtimeMs < DAY)
            return;
    }
    catch { /* never pruned */ }
    try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        writeFileSync(marker, "");
        utimesSync(marker, now / 1000, now / 1000);
        const current = versionDir();
        for (const v of readdirSync(root)) {
            if (v.startsWith("."))
                continue;
            if (join(root, v) !== current)
                rmSync(join(root, v), { recursive: true, force: true });
        }
        if (!existsSync(current))
            return;
        const cap = (Number(process.env.CONTEXT_DOCTOR_CACHE_MAX_MB) > 0 ? Number(process.env.CONTEXT_DOCTOR_CACHE_MAX_MB) : 256) * 1024 * 1024;
        const kept = [];
        for (const id of readdirSync(current)) {
            const dir = join(current, id);
            let names;
            try {
                names = readdirSync(dir);
            }
            catch {
                continue;
            }
            for (const name of names) {
                const file = join(dir, name);
                let s;
                try {
                    s = statSync(file);
                }
                catch {
                    continue;
                }
                const drop = () => { try {
                    unlinkSync(file);
                }
                catch { /* raced */ } };
                if (name.endsWith(".tmp")) {
                    if (now - s.mtimeMs > 3_600_000)
                        drop();
                    continue;
                }
                const path = pathOf(file);
                const t = path ? statOf(path) : undefined;
                if (!t || now - t.mtimeMs > 120 * DAY) {
                    drop();
                    continue;
                }
                kept.push({ file, size: s.size, mtimeMs: s.mtimeMs });
            }
        }
        let total = kept.reduce((n, k) => n + k.size, 0);
        if (total <= cap)
            return;
        for (const k of kept.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
            if (total <= cap * 0.8)
                break;
            try {
                unlinkSync(k.file);
                total -= k.size;
            }
            catch { /* raced */ }
        }
    }
    catch {
        /* pruning is housekeeping: never the reason a report fails */
    }
}
/** The transcript an entry describes: its first field, read from the file's head. */
function pathOf(file) {
    try {
        const fd = openSync(file, "r");
        try {
            const buf = Buffer.alloc(8192);
            const n = readSync(fd, buf, 0, buf.length, 0);
            const m = /^\{"path":("(?:[^"\\]|\\.)*")/.exec(buf.subarray(0, n).toString("utf8"));
            return m ? JSON.parse(m[1]) : undefined;
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        return undefined;
    }
}
/** `o` with only `keys`, those set: what a record keeps of a row. Not an object: as it was. */
export function pick(o, keys) {
    if (!o || typeof o !== "object" || Array.isArray(o))
        return o;
    const out = {};
    for (const k of keys)
        if (o[k] !== undefined)
            out[k] = o[k];
    return out;
}
/** The usage fields any report reads (cost, cache writes by TTL, reasoning, context edits). */
const USAGE_KEYS = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens", "cache_creation", "output_tokens_details", "context_management"];
export const slimUsage = (u) => pick(u, USAGE_KEYS);
