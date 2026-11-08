/**
 * A Claude Code session whose requests carry each billing modifier the
 * transcripts record (Anthropic's price page, read 2026-11-08): a fast-mode
 * Opus 5.5 reply (written as two rows, its output settled on the second), a
 * US-only Sonnet 5.5 one, a 150k-token Haiku 5.5 prompt, and an Opus 5.5
 * reply that ran two web searches, among eight plain Opus 5.5 requests
 * recorded as Claude Code records them (speed "standard", inference_geo
 * "global", no searches). Each modifier's dollars are worked out by hand.
 */
/** The session's id: its transcript's name. */
export declare const MODIFIER_SESSION = "5e55a0f1-0000-4000-8000-00000000f00d";
/** What each modifier adds, by hand (USD per 1M; 1-hour writes at 2x input). */
export declare const MODIFIER_USD: {
    fast: number;
    fastList: number;
    geoList: number;
    long: number;
    longList: number;
    searchTokens: number;
    searches: number;
};
export declare const PLAIN_USD: number;
/** Everything the session cost. */
export declare const MODIFIER_SESSION_USD: number;
/** Writes the session under `home`'s Claude Code projects, its replies a minute apart from `start`. Returns its path. */
export declare function writeModifierSession(home: string, start: number, project?: string): string;
