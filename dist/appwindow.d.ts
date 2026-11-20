/**
 * The auto-compact window the Desktop app chose, and the one Anthropic's
 * server sets: read (never written) so `compact-window` and `fix` do not
 * offer a second window over one the person just answered.
 *
 * Read from the 2.1.329 binary (`strings`; ROADMAP "Research 2026-11-20"):
 *  - The Code tab is testing an offer of a lower auto-compact window. It
 *    passes the person's answer to Claude Code in its own (flag) settings,
 *    `autoCompactOfferAnswer: { model, choice: 'accept'|'keep'|'undo',
 *    tokens, at }` ("`tokens` is the window they chose or kept, and `at` is
 *    when they answered"), and Claude Code records it in `~/.claude.json`
 *    as `autoCompactOfferCodeTab[account][model] = { choice, tokens, at }`
 *    (the account lowercased, the model as its settings key). Claude Code
 *    reads that record back only to keep an older answer from replacing a
 *    newer one: nothing in the binary sets a window from it. Whether
 *    accepting changes the window Claude Code uses depends on what the app
 *    passes in its own settings, which are not on disk. So this says what
 *    the app offered and what the person chose, and assumes nothing about
 *    the window that followed.
 *  - `autoCompactRaisedForLoad` (also the app's own settings only): true
 *    "lets a conversation compact at twice what is still in each request
 *    after a summary (system prompt, tools, instruction files), where that is
 *    above its auto-compact threshold".
 *  - `autoCompactWindowsCache` in `~/.claude.json`: the per-model windows
 *    Anthropic's server sends with the account (`auto_compact_windows`, on
 *    the Anthropic API only). Claude Code uses one for its model when no
 *    environment variable or settings file sets a window (its "server"
 *    source), so this one is a window in effect.
 */
export type OfferChoice = "accept" | "keep" | "undo";
/** One answer to the Desktop app's offer, the newest for its model. */
export interface AppWindowAnswer {
    /** The model as Claude Code keyed it (its settings key, e.g. "claude-opus-5-5"). */
    model: string;
    choice: OfferChoice;
    /** The window the person chose or kept. */
    tokens: number;
    /** When they answered (epoch ms). */
    at: number;
    /** Where it was read: ~/.claude.json, or a settings file. */
    where: string;
}
export interface AppWindows {
    answers: AppWindowAnswer[];
    /** Windows Anthropic's server sets for this account, per model (autoCompactWindowsCache). */
    served: Array<{
        model: string;
        window: number;
    }>;
    /** A settings file with autoCompactRaisedForLoad: true. */
    raisedForLoad?: string;
}
/** Read-only: ~/.claude.json and the settings files. Nothing found: empty lists. */
export declare function readAppWindows(opts?: {
    home?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}): AppWindows;
/** Anything to say: an answer, a served window, or the raised-for-load switch. */
export declare const hasAppWindows: (a: AppWindows | undefined) => a is AppWindows;
/** A model id as a settings key: lowercase, no "[1m]", no date suffix, no Bedrock or Vertex wrapping. */
export declare function modelKey(model: string): string;
/** Whether a transcript's model is the one an answer names ("opus" and the like match their family). */
export declare function sameModel(answer: string, model: string): boolean;
/**
 * The lines `compact-window` and `fix` say about it (none when nothing is on
 * file). `left`: the sessions the replay left as they ran, when known.
 */
export declare function appWindowLines(a: AppWindows, left?: number): string[];
