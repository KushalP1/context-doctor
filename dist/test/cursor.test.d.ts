/**
 * Cursor history reader. Builds its own SQLite fixture covering BOTH chat
 * shapes Cursor ships (modern bubble rows, legacy inline text), so it never
 * touches the developer's real history.
 *
 * Skipped when no SQLite backend exists (Node < 22.5 without the sqlite3 CLI)
 * — the feature reports that situation clearly at runtime too.
 */
export {};
