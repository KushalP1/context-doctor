/**
 * Inline base64 detection, shared by the profiler and the optimizer.
 *
 * A charset match alone is not enough: `"a".repeat(5000)` is valid base64
 * alphabet, and so are long hex digests, IDs and minified identifiers. Calling
 * those "base64" makes the profiler wrong and — far worse — makes the
 * `strip-base64` strategy DELETE real content. So a candidate must also look
 * like encoded binary: spanning most of the 64-symbol alphabet, with no single
 * character dominating.
 */
export declare const BASE64_PLACEHOLDER = "[context-doctor: base64 blob removed \u2014 use file/image APIs instead]";
/** True when the text carries at least one inline base64 blob. */
export declare function hasBase64Blob(text: string): boolean;
/** Replace real base64 blobs with a placeholder, leaving lookalikes intact. */
export declare function stripBase64Blobs(text: string): string;
