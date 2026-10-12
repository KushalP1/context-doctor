/**
 * After a compaction, the API's last usage figure describes the context the
 * compaction replaced. Until the next reply reports the new size, the live
 * context has no reported figure, and the every-prompt hook falls back to its
 * estimate instead of quoting the pre-compaction size.
 */
export {};
