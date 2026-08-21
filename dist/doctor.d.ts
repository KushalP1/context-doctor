/**
 * `context-doctor doctor` — self-check for a local installation.
 *
 * Verifies every integration point end to end and prints one ✓/✗/– line per
 * check, so "it doesn't work" becomes a single pasteable diagnosis. Always
 * exits 0 — absence of an app is a note, not a failure.
 */
export declare function runDoctor(): Promise<void>;
