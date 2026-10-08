/**
 * `context-doctor overhead split <file>`: turn a heavy memory file into a lean
 * one plus a reference file the agent opens when a task needs it.
 *
 * A memory file (CLAUDE.md, AGENTS.md, an auto-memory index) is re-read on
 * every request. Rules belong there; reference material (architecture notes,
 * long examples, field lists) is needed on few requests. Sections over a size
 * threshold, or made mostly of code, move to `<name>.reference.md` next to the
 * file, and each leaves a one-line pointer naming the file and section: a
 * plain path, not an @import, so it is read on demand instead of loaded.
 *
 * Shown as a plan first; written only with --write, after a backup. Nothing
 * is summarized or dropped: every moved line is in the reference file.
 */
export interface SplitSection {
    heading: string;
    tokens: number;
    moved: boolean;
    reason?: "large" | "code" | "not index";
}
export interface SplitPlan {
    path: string;
    referencePath: string;
    sections: SplitSection[];
    keptText: string;
    movedText: string;
    tokensBefore: number;
    tokensAfter: number;
}
export declare function referencePathFor(path: string): string;
/**
 * Plan the split; pure apart from reading the file. An auto-memory MEMORY.md
 * is meant to be an index (Claude Code loads it on every request and reads
 * topic files on demand), so everything in it that is not an index moves,
 * whatever its size.
 */
export declare function planSplit(path: string, { minTokens }?: {
    minTokens?: number;
}): SplitPlan;
/** Write the plan: back up the original, write the lean file, append to (or create) the reference file. */
export declare function applySplit(plan: SplitPlan, now?: number): {
    backup: string;
};
export declare function renderSplit(plan: SplitPlan, usdPerKPerMonth?: number): string;
