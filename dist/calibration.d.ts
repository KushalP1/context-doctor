/**
 * Heuristic calibration from the user's own exact counts.
 *
 * The chars-per-token heuristic is what lets everything run with no key and
 * no tokenizer, and its error is content-dependent: dense JSON tokenizes very
 * differently from prose. There is no honest way to fix that from transcripts
 * alone (the billed number includes content the transcript never sees). But
 * when someone runs `analyze --exact`, they fetch a true count for the exact
 * bytes the heuristic just estimated — the one clean comparison available.
 *
 * So that comparison is remembered, per model family, on this machine, and
 * applied to later estimates for the same family. Nothing is applied silently:
 * the profile carries the factor and the sample count, and the report prints
 * them. No exact count ever run means no calibration, and the numbers are
 * exactly what they were before.
 */
export interface Calibration {
    /** Multiply heuristic estimates by this. 1 means uncalibrated. */
    factor: number;
    samples: number;
}
export declare function calibrationPath(): string;
/** "claude", "gpt", "gemini", … — coarse on purpose; tokenizers are per vendor. */
export declare function modelFamily(model?: string): string;
/** Remember one exact-vs-heuristic observation. Best-effort; never throws. */
export declare function recordCalibration(model: string | undefined, exactTokens: number, heuristicTokens: number): void;
/** The factor to apply for a model, or 1 with zero samples when there is none. */
export declare function calibrationFor(model?: string): Calibration;
