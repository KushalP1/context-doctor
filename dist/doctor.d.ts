/**
 * `context-doctor doctor` — self-check for a local installation.
 *
 * Verifies every integration point end to end and prints one ✓/✗/– line per
 * check, so "it doesn't work" becomes a single pasteable diagnosis. Exits 1
 * when any check fails (✗), so a script can tell; an app that is absent, or
 * that nothing was installed into, is a note (–), not a failure.
 */
export declare function runDoctor(): Promise<void>;
