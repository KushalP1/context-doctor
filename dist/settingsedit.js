/**
 * Editing a settings file the way a person would: only the keys being
 * changed, everything else byte for byte.
 *
 * Re-serialising the whole file (JSON.parse + JSON.stringify) loses what the
 * user wrote: indentation and inline objects, CRLF line ends, `"é"`
 * escapes, `1.0`. So a key is replaced, inserted or removed in the text
 * itself, at positions found by a small scanner over text that JSON.parse
 * has already accepted. Writes go to a temporary file renamed over the
 * target (the target of a symbolic link, so the link stays), keeping the
 * file's mode; a lock file serialises context-doctor's own writers.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tilde } from "./claudedir.js";
/** A refusal with a message fit for the user: nothing was changed. */
export class SettingsError extends Error {
}
/** The value meaning "no such key" in setJsonPath. */
export const ABSENT = Symbol("absent");
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** Read a JSON settings file that must hold an object; absent or blank reads as {}. Anything else is refused. */
export function readSettings(path) {
    if (!existsSync(path))
        return { data: {} };
    const text = readFileSync(path, "utf8");
    const body = text.replace(/^﻿/, "");
    if (body.trim() === "")
        return { text, data: {} };
    let data;
    try {
        data = JSON.parse(body);
    }
    catch (e) {
        throw new SettingsError(`${tilde(path)} is not valid JSON (${e.message}); fix it first. Nothing was changed.`);
    }
    if (!isPlainObject(data)) {
        throw new SettingsError(`${tilde(path)} holds ${Array.isArray(data) ? "an array" : data === null ? "null" : `a ${typeof data}`}, not a JSON object; fix it first. Nothing was changed.`);
    }
    return { text, data };
}
/** The value at a key path, or undefined. */
export function getPath(data, path) {
    let v = data;
    for (const k of path) {
        if (!isPlainObject(v) || !Object.prototype.hasOwnProperty.call(v, k))
            return undefined;
        v = v[k];
    }
    return v;
}
/** Deep equality of JSON values. */
export function sameJson(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}
const WS = /[ \t\r\n]/;
function skipWs(t, i) {
    while (i < t.length && WS.test(t[i]))
        i++;
    return i;
}
function scanString(t, i) {
    i++;
    while (i < t.length) {
        if (t[i] === "\\")
            i += 2;
        else if (t[i] === '"')
            return i + 1;
        else
            i++;
    }
    return i;
}
function scanValue(t, i) {
    const c = t[i];
    if (c === '"')
        return scanString(t, i);
    if (c === "{")
        return scanObject(t, i).end + 1;
    if (c === "[") {
        i = skipWs(t, i + 1);
        if (t[i] === "]")
            return i + 1;
        for (;;) {
            i = skipWs(t, scanValue(t, i));
            if (t[i] === ",")
                i = skipWs(t, i + 1);
            else
                return i + 1;
        }
    }
    while (i < t.length && !/[\s,\]}]/.test(t[i]))
        i++;
    return i;
}
function scanObject(t, start) {
    const members = [];
    let i = skipWs(t, start + 1);
    if (t[i] === "}")
        return { start, end: i, members };
    for (;;) {
        const keyStart = i;
        const keyEnd = scanString(t, i);
        const key = JSON.parse(t.slice(keyStart, keyEnd));
        i = skipWs(t, keyEnd);
        i = skipWs(t, i + 1); // past ':'
        const valueStart = i;
        const valueEnd = scanValue(t, i);
        members.push({ key, keyStart, keyEnd, valueStart, valueEnd });
        i = skipWs(t, valueEnd);
        if (t[i] === ",")
            i = skipWs(t, i + 1);
        else
            return { start, end: i, members };
    }
}
/** The whitespace that starts the line holding position `i`. */
function lineIndent(t, i) {
    const nl = t.lastIndexOf("\n", i - 1);
    const m = /^[ \t]*/.exec(t.slice(nl + 1));
    return m ? m[0] : "";
}
/** One level of indentation as the file writes it: its first indented line, else two spaces. */
function indentUnit(t) {
    return /^[{\[][ \t]*\r?\n([ \t]+)\S/.exec(t.replace(/^﻿/, ""))?.[1] ?? "  ";
}
/** A value as text, objects laid out at `indent` with the file's unit and line end. */
function valueText(v, indent, unit, nl) {
    if (!isPlainObject(v))
        return JSON.stringify(v);
    return JSON.stringify(v, null, unit).split("\n").join(nl + indent);
}
/**
 * The text with `path` set to `value` (or removed, with ABSENT), every other
 * byte as it was. `text` must be a JSON object (readSettings checks); a
 * missing or blank file becomes a new two-space object.
 */
export function setJsonPath(text, path, value) {
    const nest = (rest, v) => (rest.length === 0 ? v : { [rest[0]]: nest(rest.slice(1), v) });
    if (text === undefined || text.replace(/^﻿/, "").trim() === "") {
        if (value === ABSENT)
            return text ?? "";
        return JSON.stringify(nest(path, value), null, 2);
    }
    const nl = text.includes("\r\n") ? "\r\n" : "\n";
    const unit = indentUnit(text);
    const root = skipWs(text, text.startsWith("﻿") ? 1 : 0);
    const edit = (t, objStart, keys) => {
        const o = scanObject(t, objStart);
        const idx = o.members.findIndex((m) => m.key === keys[0]);
        const m = idx >= 0 ? o.members[idx] : undefined;
        if (keys.length > 1) {
            if (m) {
                if (t[m.valueStart] !== "{")
                    throw new SettingsError(`"${keys[0]}" is not an object in the settings file; fix it first. Nothing was changed.`);
                return edit(t, m.valueStart, keys.slice(1));
            }
            if (value === ABSENT)
                return t;
            return insert(t, o, keys[0], nest(keys.slice(1), value));
        }
        if (value === ABSENT) {
            if (!m)
                return t;
            if (o.members.length === 1)
                return t.slice(0, o.start + 1) + t.slice(o.end);
            if (idx === o.members.length - 1)
                return t.slice(0, o.members[idx - 1].valueEnd) + t.slice(m.valueEnd);
            return t.slice(0, m.keyStart) + t.slice(o.members[idx + 1].keyStart);
        }
        if (m)
            return t.slice(0, m.valueStart) + valueText(value, lineIndent(t, m.keyStart), unit, nl) + t.slice(m.valueEnd);
        return insert(t, o, keys[0], value);
    };
    const insert = (t, o, key, v) => {
        if (o.members.length === 0) {
            const outer = lineIndent(t, o.start);
            const inner = outer + unit;
            return t.slice(0, o.start + 1) + nl + inner + JSON.stringify(key) + ": " + valueText(v, inner, unit, nl) + nl + outer + t.slice(o.end);
        }
        const last = o.members[o.members.length - 1];
        const sep = t.slice(last.keyEnd, last.valueStart);
        const between = t.slice(o.start + 1, o.members[0].keyStart);
        // An object written on one line stays on one line.
        if (!between.includes("\n"))
            return t.slice(0, last.valueEnd) + ", " + JSON.stringify(key) + sep + valueText(v, "", unit, nl).replace(/\r?\n\s*/g, " ") + t.slice(last.valueEnd);
        const indent = lineIndent(t, last.keyStart);
        return t.slice(0, last.valueEnd) + "," + nl + indent + JSON.stringify(key) + sep + valueText(v, indent, unit, nl) + t.slice(last.valueEnd);
    };
    return edit(text, root, path);
}
// -- Writing --------------------------------------------------------------------------
/** Write `text` to `path` atomically (temporary file + rename), through a symbolic link, keeping the file's mode. */
export function writeAtomic(path, text) {
    let target = path;
    try {
        target = realpathSync(path);
    }
    catch {
        /* a new file */
    }
    let mode;
    try {
        mode = statSync(target).mode & 0o777;
    }
    catch {
        /* new */
    }
    mkdirSync(dirname(target), { recursive: true });
    const tmp = join(dirname(target), `.${basename(target)}.context-doctor-${process.pid}-${Date.now()}.tmp`);
    writeFileSync(tmp, text, mode !== undefined ? { mode } : undefined);
    try {
        renameSync(tmp, target);
    }
    catch (e) {
        try {
            unlinkSync(tmp);
        }
        catch { /* gone */ }
        throw e;
    }
}
/** Remove a file through a symbolic link: the target goes, the link would dangle, so the link goes too. */
export function removeFile(path) {
    try {
        const target = realpathSync(path);
        if (target !== path)
            unlinkSync(target);
    }
    catch {
        /* not a link, or gone */
    }
    try {
        unlinkSync(path);
    }
    catch { /* gone */ }
}
const sleeper = new Int32Array(new SharedArrayBuffer(4));
/**
 * Run `fn` holding `lockPath` (created exclusively). Another context-doctor
 * holding it is waited for, up to `waitMs`; a lock older than `staleMs` is
 * taken over (its writer died).
 */
export function withLock(lockPath, fn, waitMs = 10_000, staleMs = 30_000) {
    const until = Date.now() + waitMs;
    let fd;
    for (;;) {
        try {
            fd = openSync(lockPath, "wx");
            break;
        }
        catch (e) {
            if (e.code !== "EEXIST")
                throw e;
            try {
                if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
                    unlinkSync(lockPath);
                    continue;
                }
            }
            catch {
                continue;
            }
            if (Date.now() > until)
                throw new SettingsError(`another context-doctor is changing settings (${tilde(lockPath)}); try again. Nothing was changed.`);
            Atomics.wait(sleeper, 0, 0, 25);
        }
    }
    try {
        return fn();
    }
    finally {
        try {
            closeSync(fd);
        }
        catch { /* closed */ }
        try {
            unlinkSync(lockPath);
        }
        catch { /* gone */ }
    }
}
