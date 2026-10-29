/**
 * One read of each transcript per run, and a cache of what each analysis
 * takes from it.
 *
 * `fix` and `savings` run up to six analyses (autopilot's replay, the
 * compaction check, the compact-window replay, cache misses, the output
 * lens, both cache lifetimes; `overhead` two more), and each used to read
 * and parse every transcript again:
 * 2.7 GB and 470k rows on the author's machine, ~5 s a pass, 19-37 s a run.
 * Here each analysis is an `Extractor`: it turns a transcript's lines into
 * the few records it needs (a request's usage and time, a compaction, a
 * read), and the analysis itself runs over those records, with the same code
 * and in the same order as before, so every figure is unchanged.
 *
 * - One pass, shared parse: `prescan` reads each transcript once for every
 *   extractor that has nothing cached for it, and parses each row once.
 * - A cache under ~/.cache/context-doctor (`CONTEXT_DOCTOR_CACHE_DIR`, or
 *   `XDG_CACHE_HOME`; `CONTEXT_DOCTOR_NO_CACHE=1` keeps nothing on disk), one
 *   file per transcript and extractor, keyed by the transcript's path, size,
 *   modification time and inode. A transcript that only grew (Claude Code
 *   appends) is read from where the last run stopped, the extractor's state
 *   carried over. A bulky state (the replay's conversation since its last
 *   compaction, `Extractor.save`) is kept in a file of its own, only for
 *   transcripts written in the last 3 days: the ones that grow.
 * - Safe when runs overlap: every write is a whole file renamed into place;
 *   a damaged or foreign file reads as a miss.
 * - Bounded: entries for transcripts gone or untouched for 120 days, other
 *   versions' entries and stray temporary files are removed once a day, and
 *   the oldest entries go while the cache is over 256 MB
 *   (`CONTEXT_DOCTOR_CACHE_MAX_MB`).
 * - A new context-doctor version, or a new extractor id, starts empty.
 * - No message text: token counts, times, ids, models, tool, server and
 *   skill names, the files a session read and its working folder (a prompt
 *   only as its length; a tool call's input only as a hash), in files only
 *   you can read (0600, folders 0700), as the transcripts are.
 *
 * Records must hold only JSON (numbers, strings, plain objects and arrays):
 * a record read from disk must equal the one computed, or the figures would
 * differ between a cold run and a warm one.
 */
export interface Extractor<S = unknown> {
    /** Names the records and their shape: change it ("ttl.2") whenever either changes. */
    id: string;
    /** Per-file state, carried from line to line (plain JSON when resumable). */
    init(): S;
    /**
     * One line of the transcript, as `forEachLine` gives it. `row()` is the
     * line parsed (once, shared by every extractor; it throws as JSON.parse
     * does). The parsed row must not be modified.
     */
    line(raw: string, row: () => any, out: unknown[], state: S): void;
    /** After the last line (for a resumable extractor, run again after each append). */
    end?(out: unknown[], state: S): void;
    /** False when the state cannot be kept: a grown file is then read again in full. Default true. */
    resumable?: boolean;
    /**
     * For a state too large to keep with the records (a replay's conversation):
     * the state as JSON and back. It is then kept in a file of its own, only
     * for transcripts written in the last RECENT days (the ones that grow), and
     * read only to resume. `end` must not change the state.
     */
    save?(state: S): unknown;
    load?(saved: any): S;
}
/** Where the cache lives (created only when something is written). */
export declare function scanCacheDir(env?: NodeJS.ProcessEnv): string;
/**
 * Read every transcript once for all the extractors that need it (each job:
 * an extractor set and its transcripts), so the analyses that follow find
 * their records ready. Optional: an analysis reads whatever is missing itself.
 */
export declare function prescan(jobs: Array<{
    paths: string[];
    extractors: Extractor<any>[];
}>, onProgress?: (done: number, total: number) => void): void;
/**
 * The records `ex` takes from one transcript, in file order: from this run's
 * memory, the cache, or a read of the file (only the part not yet read when
 * it grew). Throws when the transcript cannot be read, as forEachLine does.
 * `keep: false` reads the file afresh and keeps nothing (an extractor with
 * options of its own, which its id does not name).
 */
export declare function rowsOf<R = any>(path: string, ex: Extractor<any>, opts?: {
    keep?: boolean;
}): R[];
/** Forget this run's records (tests). */
export declare function clearScanMemo(): void;
/**
 * Keep the cache bounded, at most once a day: other versions' entries, stray
 * temporary files, entries whose transcript is gone or untouched for 120
 * days, then the oldest entries while over the size cap.
 */
export declare function pruneScanCache(now?: number, force?: boolean): void;
/** `o` with only `keys`, those set: what a record keeps of a row. Not an object: as it was. */
export declare function pick(o: any, keys: readonly string[]): any;
export declare const slimUsage: (u: unknown) => unknown;
