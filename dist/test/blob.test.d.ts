/**
 * Inline base64 of any size is found, not a crash. The matcher was one
 * regular expression, /[A-Za-z0-9+/]{500,}/, which threw "Maximum call
 * stack size exceeded" on a run past about 5.5 million characters: a 4 MB
 * screenshot or PDF pasted as base64 ended analyze, profile_context and
 * optimize at the very blob they exist to find.
 */
export {};
