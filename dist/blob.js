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
const MIN_RUN = 500;
/** The data: URI header a run may follow (the candidate then starts at "data:"). */
const DATA_URI_HEAD = /data:[\w/+.-]+;base64,$/;
export const BASE64_PLACEHOLDER = "[context-doctor: base64 blob removed — use file/image APIs instead]";
/** Distinct characters a genuine base64 payload is expected to span. */
const MIN_DISTINCT_CHARS = 24;
/** Above this share for one character, the run is padding or repetition. */
const MAX_SINGLE_CHAR_SHARE = 0.35;
function isBase64Blob(candidate) {
    // An explicit data: URI declares its own encoding — no need to guess.
    if (candidate.startsWith("data:"))
        return true;
    // A candidate is ASCII (the alphabet and "="): a count per character code.
    const counts = new Uint32Array(128);
    let distinct = 0;
    let max = 0;
    for (let k = 0; k < candidate.length; k++) {
        const c = candidate.charCodeAt(k) & 127;
        if (counts[c]++ === 0)
            distinct++;
        if (counts[c] > max)
            max = counts[c];
    }
    if (distinct < MIN_DISTINCT_CHARS)
        return false;
    return max / candidate.length < MAX_SINGLE_CHAR_SHARE;
}
/** A-Z, a-z, 0-9, + and /. */
function inAlphabet(c) {
    return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47;
}
/**
 * The candidates, as [start, end) spans: what
 * /(?:data:[\w/+.-]+;base64,)?[A-Za-z0-9+/]{500,}={0,2}/g matched, found by
 * a scan. That expression threw "Maximum call stack size exceeded" on a run
 * past about 5.5 million characters (a 4 MB image or PDF pasted as base64),
 * which ended analyze, profile_context and optimize at the very blob they
 * exist to find.
 */
function* candidates(text) {
    const n = text.length;
    let i = 0;
    // Where the last candidate ended: a header cannot reuse its characters ("…xYdata" ends one).
    let last = 0;
    while (i < n) {
        if (!inAlphabet(text.charCodeAt(i))) {
            i++;
            continue;
        }
        let j = i;
        while (j < n && inAlphabet(text.charCodeAt(j)))
            j++;
        if (j - i < MIN_RUN) {
            i = j;
            continue;
        }
        let end = j;
        while (end < n && end - j < 2 && text.charCodeAt(end) === 61)
            end++; // up to two "=" of padding
        const head = DATA_URI_HEAD.exec(text.slice(Math.max(last, i - 1000), i));
        yield [head ? i - head[0].length : i, end];
        i = last = end;
    }
}
/** True when the text carries at least one inline base64 blob. */
export function hasBase64Blob(text) {
    for (const [s, e] of candidates(text)) {
        if (isBase64Blob(text.slice(s, e)))
            return true;
    }
    return false;
}
/** Replace real base64 blobs with a placeholder, leaving lookalikes intact. */
export function stripBase64Blobs(text) {
    const parts = [];
    let from = 0;
    for (const [s, e] of candidates(text)) {
        if (!isBase64Blob(text.slice(s, e)))
            continue;
        parts.push(text.slice(from, s), BASE64_PLACEHOLDER);
        from = e;
    }
    if (parts.length === 0)
        return text;
    parts.push(text.slice(from));
    return parts.join("");
}
