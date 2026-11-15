/**
 * Cline's record of what it sent. Checked 2026-11-15 against ccusage's Cline
 * loader (rust/adapters/cline) and its docs:
 *
 *  - The editor extension keeps each task in its `globalStorage` folder
 *    (`saoudrizwan.claude-dev`, under VS Code, VS Code Insiders, Cursor,
 *    Windsurf or VSCodium): `tasks/<task>/ui_messages.json`, a JSON array.
 *    A request is a `say: "api_req_started"` message whose `text` is JSON
 *    with `tokensIn` (uncached), `tokensOut`, `cacheReads`, `cacheWrites`;
 *    its model is `modelInfo.modelId`. One marked `partial` is still being
 *    written; `deleted_api_reqs` and `subagent_usage` are roll-ups of
 *    requests counted elsewhere: none is counted.
 *  - Older Cline CLI versions keep tasks the same way in `~/.cline/data/tasks`.
 *  - The Cline CLI keeps sessions in `~/.cline/data/sessions/<id>/<id>.messages.json`:
 *    assistant messages with `modelInfo.id` and `metrics` (`inputTokens`
 *    including both cache counts, `outputTokens`, `cacheReadTokens`,
 *    `cacheWriteTokens`).
 *
 * `CLINE_DATA_DIR` (a comma list) replaces the places searched. A request
 * from an older extension with no `modelInfo` takes the task's model at that
 * time from `task_metadata.json` (`model_usage`), else is counted unpriced.
 * The folder a task ran in is `cwdOnTaskInitialization` in the extension's
 * `state/taskHistory.json`, when that file is there. Nothing else is read:
 * the `text` of a request also holds the prompt, which is never kept.
 */
/** One Cline request. */
export interface ClineCall {
    ts: number;
    /** "task:<id>" (the extension, the older CLI) or "cli:<id>" (a CLI session). */
    session: string;
    model?: string;
    input: number;
    read: number;
    write: number;
    output: number;
    cwd?: string;
}
/** Every folder Cline may keep data in, those that exist. Each OS's spot is checked on every OS, as the files may have been copied. */
export declare function clineRoots(home?: string): string[];
/** Every Cline request between `since` and `until`, from every place it keeps data. A file that cannot be read is skipped. */
export declare function clineCalls(since: number, until?: number, home?: string): ClineCall[];
