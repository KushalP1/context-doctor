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
/** Bounds on what a handoff may hold. The brief's target is ≤400 tokens; the cap is a hard stop. */
export declare const HANDOFF_LIMITS: {
    readonly briefTargetTokens: 400;
    readonly briefChars: 6000;
    readonly titleChars: 80;
    readonly modelChars: 100;
    readonly blocks: 20;
    readonly labelChars: 80;
    readonly blockChars: 20000;
    readonly totalChars: 60000;
    /** Newest handoffs kept on disk; older ones are removed when a new one is saved. */
    readonly kept: 100;
    /** Largest handoff.md read back (a hand-edited file could be anything). */
    readonly readBytes: number;
};
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
    blocks: Array<{
        label: string;
        tokens: number;
    }>;
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
export declare function handoffDir(home?: string): string;
export declare function isHandoffId(id: unknown): id is string;
export declare function slugify(title: string): string;
/** Problems with an input, or an empty list. Enforced here too, not only by the MCP schema. */
export declare function validateHandoff(input: HandoffInput): string[];
/** Mask secret-looking strings. Returns the text, how many were masked, and of what kinds. */
export declare function maskSecrets(text: string): {
    text: string;
    count: number;
    kinds: string[];
};
/** The text a new chat starts from: what is attached, pasted or copied. */
export declare function renderHandoffMarkdown(title: string, created: string, brief: string, blocks: VerbatimBlock[]): string;
/** What the current chat costs per turn vs a new chat that starts from the handoff. */
export declare function handoffMath(handoffTokens: number, input: Pick<HandoffInput, "chatTokens" | "turns" | "model">): HandoffMath;
/** "Now ~48k tokens re-read every turn … after ~600" lines, or a hint when the size is unknown. */
export declare function renderMath(m: HandoffMath): string;
/** Every saved handoff, newest first. Entries that are not ours (bad name, symlink, no meta) are skipped. */
export declare function listHandoffs(home?: string): HandoffMeta[];
/**
 * One handoff by id, or the newest for "latest". Undefined for anything that
 * is not a well-formed id of a saved handoff: no path from a caller (a
 * resource URI, a CLI argument) ever reaches the filesystem as given.
 */
export declare function readHandoff(idOrLatest: string, home?: string): {
    meta: HandoffMeta;
    markdown: string;
} | undefined;
/**
 * C0 and C1 control characters out, so a title or brief cannot drive a
 * terminal (escape sequences that retitle a window or clear the screen) when
 * the CLI prints it. Newlines and tabs stay; CRLF becomes LF.
 */
export declare function stripControls(text: string, { keepNewlines }?: {
    keepNewlines?: boolean;
}): string;
/**
 * Build a handoff, and store it unless `store` is false (the HTTP server keeps
 * nothing by default). Throws with the validation problems on bad input, and
 * with a message that names no absolute path when the folder is unsafe.
 */
export declare function saveHandoff(input: HandoffInput, { home, now, store }?: {
    home?: string;
    now?: Date;
    store?: boolean;
}): SavedHandoff;
/** Where a path sits, with the home directory shown as ~. */
export declare function tildify(path: string, home?: string): string;
/** Every absolute mention of the home directory in `text` as ~ (error messages that reach a client). */
export declare function tildifyAll(text: string, home?: string): string;
/** `context-doctor handoff list`. */
export declare function renderHandoffList(metas: HandoffMeta[], home?: string): string;
