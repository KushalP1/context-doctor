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
/** Read a JSON settings file that must hold an object; absent or blank reads as {}. Anything else is refused. */
export declare function readSettings(path: string): SettingsText;
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
