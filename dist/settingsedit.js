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
/**
 * The text with `//` and `/* *\/` comments blanked to spaces (newlines kept),
 * strings untouched: what strip-json-comments does before Gemini CLI parses
 * its settings.json, so positions in the result are positions in the text.
 */
export function stripJsonComments(text) {
    let out = "";
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '"') {
            const end = scanString(text, i);
            out += text.slice(i, end);
            i = end;
        }
        else if (c === "/" && text[i + 1] === "/") {
            let end = text.indexOf("\n", i);
            if (end === -1)
                end = text.length;
            out += text.slice(i, end).replace(/[^\r]/g, " ");
            i = end;
        }
        else if (c === "/" && text[i + 1] === "*") {
            let end = text.indexOf("*/", i + 2);
            end = end === -1 ? text.length : end + 2;
            out += text.slice(i, end).replace(/[^\r\n]/g, " ");
            i = end;
        }
        else {
            out += c;
            i++;
        }
    }
    return out;
}
/**
 * Parse settings text as JSON (with comments when `comments`), BOM allowed.
 * Throws the parser's error.
 */
export function parseSettingsText(text, comments = false) {
    const body = text.replace(/^\ufeff/, "");
    return JSON.parse(comments ? stripJsonComments(body) : body);
}
/**
 * Read a JSON settings file that must hold an object; absent or blank reads
 * as {}. Anything else is refused. `comments` accepts // and /* *\/ comments,
 * for an app that reads its file that way (Gemini CLI).
 */
export function readSettings(path, comments = false) {
    if (!existsSync(path))
        return { data: {} };
    const text = readFileSync(path, "utf8");
    const body = text.replace(/^\ufeff/, "");
    if (body.trim() === "")
        return { text, data: {} };
    let data;
    try {
        data = parseSettingsText(body, comments);
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
/** Past whitespace and comments (only a file read with comments has any: `/` is nowhere else outside a string). */
function skipWs(t, i) {
    for (;;) {
        while (i < t.length && WS.test(t[i]))
            i++;
        if (t[i] === "/" && t[i + 1] === "/") {
            const nl = t.indexOf("\n", i);
            i = nl === -1 ? t.length : nl;
        }
        else if (t[i] === "/" && t[i + 1] === "*") {
            const end = t.indexOf("*/", i + 2);
            i = end === -1 ? t.length : end + 2;
        }
        else
            return i;
    }
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
    while (i < t.length && !/[\s,\]}/]/.test(t[i]))
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
/** A value as text: objects and arrays laid out at `indent` with the file's unit and line end. */
function valueText(v, indent, unit, nl) {
    if (!isPlainObject(v) && !Array.isArray(v))
        return JSON.stringify(v);
    return JSON.stringify(v, null, unit).split("\n").join(nl + indent);
}
/** A file written on one line (minified): what goes into it is written without spaces too. */
function isMinified(t) {
    return !t.trim().includes("\n");
}
/** A value on one line: compact in a minified file, else spaced as `{ "a": [ 1 ] }`. */
function inlineText(v, minified, unit, nl) {
    return minified ? JSON.stringify(v) : valueText(v, "", unit, nl).replace(/\r?\n\s*/g, " ");
}
/** The separator between two neighbours on one line, as the file writes it (`,` or `, `). */
function inlineComma(t, prevEnd, nextStart, minified) {
    const between = prevEnd !== undefined && nextStart !== undefined ? t.slice(prevEnd, nextStart) : "";
    return /^[ \t]*,[ \t]*$/.test(between) ? between : minified ? "," : ", ";
}
/**
 * Where a removed member or item's text ends: past its comma and the
 * whitespace after it, but not past a comment, which belongs to what follows.
 */
function pastComma(t, valueEnd) {
    let i = skipWs(t, valueEnd);
    if (t[i] === ",")
        i++;
    while (i < t.length && WS.test(t[i]))
        i++;
    return i;
}
/** How the file writes itself: its line end, indentation unit, and whether it is all on one line. */
function style(text) {
    return { nl: text.includes("\r\n") ? "\r\n" : "\n", unit: indentUnit(text), minified: isMinified(text) };
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
    const { nl, unit, minified } = style(text);
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
            return t.slice(0, m.keyStart) + t.slice(pastComma(t, m.valueEnd));
        }
        if (m) {
            // A container written on one line stays on one line.
            const old = t.slice(m.valueStart, m.valueEnd);
            const oneLine = minified || (!old.includes("\n") && old.replace(/\s/g, "").length > 2);
            return t.slice(0, m.valueStart) + (oneLine ? inlineText(value, minified, unit, nl) : valueText(value, lineIndent(t, m.keyStart), unit, nl)) + t.slice(m.valueEnd);
        }
        return insert(t, o, keys[0], value);
    };
    const insert = (t, o, key, v) => {
        if (o.members.length === 0) {
            if (minified)
                return t.slice(0, o.start + 1) + JSON.stringify(key) + ":" + JSON.stringify(v) + t.slice(o.end);
            const outer = lineIndent(t, o.start);
            const inner = outer + unit;
            return t.slice(0, o.start + 1) + nl + inner + JSON.stringify(key) + ": " + valueText(v, inner, unit, nl) + nl + outer + t.slice(o.end);
        }
        const n = o.members.length;
        const last = o.members[n - 1];
        const sep = t.slice(last.keyEnd, last.valueStart);
        const between = t.slice(o.start + 1, o.members[0].keyStart);
        // An object written on one line stays on one line.
        if (minified || !between.includes("\n")) {
            const comma = inlineComma(t, o.members[n - 2]?.valueEnd, n > 1 ? last.keyStart : undefined, minified);
            return t.slice(0, last.valueEnd) + comma + JSON.stringify(key) + sep + inlineText(v, minified, unit, nl) + t.slice(last.valueEnd);
        }
        const indent = lineIndent(t, last.keyStart);
        return t.slice(0, last.valueEnd) + "," + nl + indent + JSON.stringify(key) + sep + valueText(v, indent, unit, nl) + t.slice(last.valueEnd);
    };
    return edit(text, root, path);
}
function scanArray(t, start) {
    const items = [];
    let i = skipWs(t, start + 1);
    if (t[i] === "]")
        return { start, end: i, items };
    for (;;) {
        const end = scanValue(t, i);
        items.push({ start: i, end });
        i = skipWs(t, end);
        if (t[i] === ",")
            i = skipWs(t, i + 1);
        else
            return { start, end: i, items };
    }
}
/** The array at `path` (object keys from the root). */
function arrayAt(t, path) {
    let at = skipWs(t, t.startsWith("﻿") ? 1 : 0);
    for (const k of path) {
        const m = t[at] === "{" ? scanObject(t, at).members.find((x) => x.key === k) : undefined;
        if (!m)
            throw new SettingsError(`"${path.join(".")}" is not in the settings file. Nothing was changed.`);
        at = m.valueStart;
    }
    if (t[at] !== "[")
        throw new SettingsError(`"${path.join(".")}" is not a list in the settings file; fix it first. Nothing was changed.`);
    return scanArray(t, at);
}
/** The text with `value` added as the last item of the array at `path`, laid out like the items before it. */
export function appendJsonItem(text, path, value) {
    const { nl, unit, minified } = style(text);
    const a = arrayAt(text, path);
    if (a.items.length === 0) {
        if (minified)
            return text.slice(0, a.start + 1) + JSON.stringify(value) + text.slice(a.end);
        const outer = lineIndent(text, a.start);
        const inner = outer + unit;
        return text.slice(0, a.start + 1) + nl + inner + valueText(value, inner, unit, nl) + nl + outer + text.slice(a.end);
    }
    const n = a.items.length;
    const last = a.items[n - 1];
    if (minified || !text.slice(a.start + 1, a.items[0].start).includes("\n")) {
        const comma = inlineComma(text, a.items[n - 2]?.end, n > 1 ? last.start : undefined, minified);
        return text.slice(0, last.end) + comma + inlineText(value, minified, unit, nl) + text.slice(last.end);
    }
    const indent = lineIndent(text, last.start);
    return text.slice(0, last.end) + "," + nl + indent + valueText(value, indent, unit, nl) + text.slice(last.end);
}
/** The text with item `index` of the array at `path` taken out: the exact inverse of appendJsonItem. */
export function removeJsonItem(text, path, index) {
    const a = arrayAt(text, path);
    const it = a.items[index];
    if (!it)
        return text;
    if (a.items.length === 1)
        return text.slice(0, a.start + 1) + text.slice(a.end);
    if (index === a.items.length - 1)
        return text.slice(0, a.items[index - 1].end) + text.slice(it.end);
    return text.slice(0, it.start) + text.slice(pastComma(text, it.end));
}
/**
 * The text changed so it reads as `after`, touching only what differs from
 * what it reads as now: keys set, added or removed one by one, list items
 * added at the end or taken out. Everything else (indentation, one-line
 * objects, minified files, CRLF, escapes, `1.0`, comments where `comments`)
 * stays byte for byte, so an install and its uninstall give back the file
 * exactly. A missing or blank file becomes a new two-space object.
 */
export function editJsonText(text, after, comments = false) {
    if (text === undefined || text.replace(/^﻿/, "").trim() === "")
        return JSON.stringify(after, null, 2);
    const before = parseSettingsText(text, comments);
    if (!isPlainObject(before))
        throw new SettingsError("the settings file does not hold a JSON object; fix it first. Nothing was changed.");
    const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    let t = text;
    const walk = (b, a, path) => {
        if (sameJson(b, a))
            return;
        if (isPlainObject(b) && isPlainObject(a)) {
            for (const k of Object.keys(b))
                if (!own(a, k))
                    t = setJsonPath(t, [...path, k], ABSENT);
            for (const k of Object.keys(a)) {
                if (own(b, k))
                    walk(b[k], a[k], [...path, k]);
                else
                    t = setJsonPath(t, [...path, k], a[k]);
            }
            return;
        }
        if (Array.isArray(b) && Array.isArray(a)) {
            // Items kept in order, the rest taken out, new ones at the end: what
            // install and uninstall do to a hook list. Anything else is rewritten.
            const removed = [];
            let j = 0;
            b.forEach((x, i) => {
                if (j < a.length && sameJson(x, a[j]))
                    j++;
                else
                    removed.push(i);
            });
            if (j > 0 || b.length === 0 || a.length === j) {
                for (const i of removed.reverse())
                    t = removeJsonItem(t, path, i);
                for (const x of a.slice(j))
                    t = appendJsonItem(t, path, x);
                return;
            }
        }
        t = setJsonPath(t, path, a);
    };
    walk(before, after, []);
    return t;
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
