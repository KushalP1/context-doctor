/**
 * What a bare `context-doctor` shows in a terminal with Claude Code history:
 * the plan, not the report, and one question.
 *
 * `fix` lists every lever with how it was measured, what it costs in quality
 * and what it writes: 30 to 50 lines and a question per lever. The author,
 * who wrote every lever, applied none of them that way. So the first screen
 * splits `fix`'s own plan (the same replays, one scan) in two:
 *  - the fixes whose quality line is "none" (`Fix.qualityFree`: the model
 *    sees the same content, or the same content moved where it can open it,
 *    on the same model), one line each with one total and ONE y/N question
 *    that applies them all through `applyFix`, as `fix --apply <ids>` does;
 *  - the ones that trade something (compacting earlier, autopilot clearing
 *    output, the subagents' model, Codex's limit), one line each with their
 *    dollars and the command that applies each, after reading it in `fix`.
 * Nothing is written without a `y` typed in a terminal.
 */
import { type Fix } from "./fix.js";
export interface FirstSplit {
    /** Offered under the one question: available and quality-free, in the plan's order. */
    free: Fix[];
    /** Available, with a quality cost (or one not measured): pointed at `fix`. */
    other: Fix[];
    /** Applied before (by `fix` or by hand). */
    applied: Fix[];
}
export declare function splitFirstFixes(fixes: Fix[]): FirstSplit;
export interface FirstScreen {
    days: number;
    billedUsd: number;
    codexBilledUsd?: number;
    fixes: Fix[];
    /** `context-doctor <rest>`, or `npx context-doctor <rest>` (invocation.ts). */
    command: (rest: string) => string;
    /** The record of applied fixes is damaged: `fix` refuses to apply, so nothing is asked. */
    recordProblem?: string;
    /** The question follows (stdin and stdout are a terminal); otherwise the last line says how to apply them. */
    ask: boolean;
}
/** The screen, everything but the question itself (under 25 lines whatever the plan). */
export declare function renderFirstScreen(s: FirstScreen): string;
/** The one question, for the quality-free fixes together. */
export declare function firstQuestion(n: number, command: (rest: string) => string): string;
