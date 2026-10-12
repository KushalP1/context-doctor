/**
 * PreCompact: tell Claude Code's compaction what this session cannot lose.
 *
 * A compaction replaces the session's history with a summary written by the
 * model, guided by generic instructions. Whatever a PreCompact hook prints is
 * added to those instructions (Claude Code merges it as custom instructions,
 * for automatic and manual compactions alike; checked in 2.1.295). So the
 * summary can be told, from the transcript itself, which files were changed,
 * what is still open, what the user insisted on, and which commands are still
 * failing: the things whose loss makes a session re-read, re-ask and repeat
 * mistakes after compacting. Facts only, short, and nothing invented: every
 * line comes from the transcript.
 */
export interface CompactFacts {
    edited: string[];
    todos: string[];
    directives: string[];
    failing: string[];
}
/** Facts from the session since the last compaction (the summary before it already carries the earlier ones). */
export declare function compactFacts(transcriptPath: string): CompactFacts;
/** The custom instructions a PreCompact hook prints; empty when the transcript holds nothing to pin. */
export declare function compactInstructions(f: CompactFacts): string;
