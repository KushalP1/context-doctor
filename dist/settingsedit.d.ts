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
/** A refusal with a message fit for the user: nothing was changed. */
export declare class SettingsError extends Error {
}
/** The value meaning "no such key" in setJsonPath. */
export declare const ABSENT: unique symbol;
export interface SettingsText {
    /** The file's text; undefined when there is no file. */
    text?: string;
    data: Record<string, unknown>;
}
/**
 * The text with `//` and `/* *\/` comments blanked to spaces (newlines kept),
 * strings untouched: what strip-json-comments does before Gemini CLI parses
 * its settings.json, so positions in the result are positions in the text.
 */
export declare function stripJsonComments(text: string): string;
/**
 * Parse settings text as JSON (with comments when `comments`), BOM allowed.
 * Throws the parser's error.
 */
export declare function parseSettingsText(text: string, comments?: boolean): unknown;
/**
 * Read a JSON settings file that must hold an object; absent or blank reads
 * as {}. Anything else is refused. `comments` accepts // and /* *\/ comments,
 * for an app that reads its file that way (Gemini CLI).
 */
export declare function readSettings(path: string, comments?: boolean): SettingsText;
/** The value at a key path, or undefined. */
export declare function getPath(data: unknown, path: string[]): unknown;
/** Deep equality of JSON values. */
export declare function sameJson(a: unknown, b: unknown): boolean;
/**
 * The text with `path` set to `value` (or removed, with ABSENT), every other
 * byte as it was. `text` must be a JSON object (readSettings checks); a
 * missing or blank file becomes a new two-space object.
 */
export declare function setJsonPath(text: string | undefined, path: string[], value: unknown): string;
/** The text with `value` added as the last item of the array at `path`, laid out like the items before it. */
export declare function appendJsonItem(text: string, path: string[], value: unknown): string;
/** The text with item `index` of the array at `path` taken out: the exact inverse of appendJsonItem. */
export declare function removeJsonItem(text: string, path: string[], index: number): string;
/**
 * The text changed so it reads as `after`, touching only what differs from
 * what it reads as now: keys set, added or removed one by one, list items
 * added at the end or taken out. Everything else (indentation, one-line
 * objects, minified files, CRLF, escapes, `1.0`, comments where `comments`)
 * stays byte for byte, so an install and its uninstall give back the file
 * exactly. A missing or blank file becomes a new two-space object.
 */
export declare function editJsonText(text: string | undefined, after: Record<string, unknown>, comments?: boolean): string;
/** Write `text` to `path` atomically (temporary file + rename), through a symbolic link, keeping the file's mode. */
export declare function writeAtomic(path: string, text: string): void;
/** Remove a file through a symbolic link: the target goes, the link would dangle, so the link goes too. */
export declare function removeFile(path: string): void;
/**
 * Run `fn` holding `lockPath` (created exclusively). Another context-doctor
 * holding it is waited for, up to `waitMs`; a lock older than `staleMs` is
 * taken over (its writer died).
 */
export declare function withLock<T>(lockPath: string, fn: () => T, waitMs?: number, staleMs?: number): T;
