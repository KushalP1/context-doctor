/**
 * context-doctor's mod: the status line's measurements and `fix`'s plan where
 * the status line never runs (Claude Code's Desktop app, the VS Code
 * extension), and in the terminal too.
 *
 * Shipped inside the plugin: hooks/hooks.json names this file under
 * `modules`. Claude Code runs mods from 2.1.287 (terminal), 2.1.286 (the
 * Desktop app's Code tab) and 2.1.299 (VS Code); an older one never loads
 * it and keeps the rest of the plugin.
 *
 *  - After each turn (`session.measure`) it runs `context-doctor mod measure`
 *    with Claude Code's rate-limit windows and session cost: the CLI keeps
 *    them (the limits ledger; Claude Code's cost beside ours) and answers
 *    with the band's figures.
 *  - A band above the prompt, only when it pays: the cache about to go cold
 *    or gone cold on a big context (with the re-write's price), the session
 *    past a price threshold. On a cold return a "Compact first" button calls
 *    `$.session.compact()`, between turns, on the press alone.
 *  - `/context-doctor-fix` opens a pane with `fix`'s plan and an Apply / Undo
 *    button per lever. Each press runs the CLI's own `fix --apply <id>` /
 *    `fix undo <id>`: the same lock, backup and record as in a terminal.
 *
 * Nothing happens without a press: no auto-compaction, no auto-apply. The
 * mod writes no file itself; the CLI writes ours. Off: CONTEXT_DOCTOR_NO_MOD=1.
 *
 * The mods runtime has no Node, so this file imports only ./logic.js (no
 * imports of its own) and reaches everything else through `$`. Claude Code
 * reads which calls a module makes from its source: `$` is passed only to
 * functions declared at the top of this file.
 */
import { type BandData, type PlanJson } from "./logic.js";
import type { On } from "./api.js";
export declare const COMMAND = "context-doctor-fix";
export declare const PANE = "context-doctor-fix";
/** The mod's state for this load (a reload starts it over; the next turn measures again). */
interface State {
    off: boolean;
    always: boolean;
    data?: BandData;
    hidden: Set<string>;
    drawn: string;
    compacting: boolean;
    plan?: PlanJson;
    planError?: string;
    loading: boolean;
    /** A press in flight ("apply:<id>"): never two at once. */
    busy?: string;
    last?: {
        id: string;
        ok: boolean;
        lines: string[];
    };
    presses: Map<string, "applied" | "undone">;
}
/** For tests: the state the hooks share. */
export declare const state: () => State;
export declare function register(on: On): void;
export {};
