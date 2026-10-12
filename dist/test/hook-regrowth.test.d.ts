/**
 * When the every-prompt hook speaks: after a compaction the next warning must
 * be measured from the compacted size, and a low threshold must not be hidden
 * behind the stat-only fast path, whose byte count cannot see the system
 * prompt and tools the API figure includes.
 */
export {};
