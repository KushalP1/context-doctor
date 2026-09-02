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

/** Runs of base64 alphabet long enough to be worth reporting (~375 bytes+). */
const BASE64_RE = /(?:data:[\w/+.-]+;base64,)?[A-Za-z0-9+/]{500,}={0,2}/g;

export const BASE64_PLACEHOLDER = "[context-doctor: base64 blob removed — use file/image APIs instead]";

/** Distinct characters a genuine base64 payload is expected to span. */
const MIN_DISTINCT_CHARS = 24;
/** Above this share for one character, the run is padding or repetition. */
const MAX_SINGLE_CHAR_SHARE = 0.35;

function isBase64Blob(candidate: string): boolean {
  // An explicit data: URI declares its own encoding — no need to guess.
  if (candidate.startsWith("data:")) return true;
  const counts = new Map<string, number>();
  for (const ch of candidate) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  if (counts.size < MIN_DISTINCT_CHARS) return false;
  let max = 0;
  for (const n of counts.values()) if (n > max) max = n;
  return max / candidate.length < MAX_SINGLE_CHAR_SHARE;
}

/** True when the text carries at least one inline base64 blob. */
export function hasBase64Blob(text: string): boolean {
  for (const m of text.matchAll(BASE64_RE)) {
    if (isBase64Blob(m[0])) return true;
  }
  return false;
}

/** Replace real base64 blobs with a placeholder, leaving lookalikes intact. */
export function stripBase64Blobs(text: string): string {
  return text.replace(BASE64_RE, (m) => (isBase64Blob(m) ? BASE64_PLACEHOLDER : m));
}
