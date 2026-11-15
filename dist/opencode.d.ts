/**
 * OpenCode's record of what it sent: each assistant message's `tokens`.
 * Checked 2026-11-15 against ccusage's OpenCode loader (rust/adapters/opencode)
 * and its docs. OpenCode keeps its data in `${XDG_DATA_HOME:-~/.local/share}/opencode`
 * (`OPENCODE_DATA_DIR`, a comma list, instead), in one of three places:
 *
 *  - `storage/message/<sessionID>/<messageID>.json` (before its SQLite store):
 *    `{id, sessionID, role, modelID, providerID, time: {created}, tokens:
 *    {input, output, reasoning, cache: {read, write}, total}, path: {cwd, root}}`.
 *  - `opencode.db`, table `message`: the same object in `data`.
 *  - `opencode.db`, table `session_message` (its v2 store): rows of `type`
 *    "assistant" or "compaction" (a compaction is billed apart; only a
 *    "completed" one), the model as `model: {id, providerID}`. A forked
 *    session starts with a copy of its parent's rows, new ids and the same
 *    `seq`; `session_v2.fork_boundary` says up to which (its "through" or
 *    "before" a parent message): those copies are not counted again.
 *
 * `tokens.input` is the uncached input; reasoning bills as output, and a
 * `total` above the parts is output too (as ccusage counts it). A message
 * on OpenCode's `claude-agent` provider ran inside Claude Code, whose own
 * transcript `spend` already reads: not counted here. The same message in
 * the JSON files and the database (a store that was migrated) is counted once.
 */
/** One OpenCode model call. */
export interface OpenCodeCall {
    id: string;
    ts: number;
    session: string;
    model?: string;
    provider?: string;
    input: number;
    read: number;
    write: number;
    output: number;
    /** The folder it ran in (`path.cwd`, else the session's `directory`), and the project's root (`path.root`). */
    cwd?: string;
    root?: string;
    compaction?: boolean;
}
/** OpenCode's data folders: $OPENCODE_DATA_DIR's (when `home` is this user's), else <XDG data>/opencode. */
export declare function opencodeDataDirs(home?: string): string[];
/** The counts of one message's `tokens`, as billed: reasoning, and a total above the parts, as output. */
export declare function opencodeTokens(t: any): {
    input: number;
    read: number;
    write: number;
    output: number;
} | undefined;
/**
 * Every OpenCode model call between `since` and `until`, each once, less
 * those on the claude-agent provider. `sqlite`: false when an opencode.db
 * was there and this runtime cannot read SQLite.
 */
export declare function opencodeCalls(since: number, until?: number, home?: string): {
    calls: OpenCodeCall[];
    sqlite: boolean;
};
