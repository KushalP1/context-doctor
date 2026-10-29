/**
 * The shared scan (scan.ts) changes how often a transcript is read, never a
 * figure: every history report, text and JSON, on the fixture history
 * (history-fixture.ts), byte for byte against the outputs the code before it
 * printed (src/test/golden, made by scripts/gen-scan-golden.mjs): with
 * nothing cached, with the cache written by the run before, and after the
 * history grew, from a cache that resumes where it stopped.
 */
export {};
