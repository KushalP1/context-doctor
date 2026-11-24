export interface SampleHistory {
    /** Transcript paths, ready for estimateSavings(days, {}, paths). */
    paths: string[];
    /** Delete the temp folder. Call it in a finally. */
    cleanup: () => void;
}
/** Two synthetic sessions: one with a cold return past the prompt cache, one without. */
export declare function writeSampleHistory(now?: number): SampleHistory;
