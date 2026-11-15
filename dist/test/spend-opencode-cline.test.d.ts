/**
 * `spend` reads OpenCode and Cline. OpenCode: its JSON files and its
 * SQLite store (both tables), a message in both counted once, a forked
 * session's copy of its parent not again, a message run through Claude Code
 * (claude-agent) left to Claude Code's own transcript. Cline: the editor
 * extension's tasks, the older CLI's tasks and the CLI's sessions, only
 * complete `api_req_started` requests, a request with no model taking the
 * task's. Shapes from ccusage's loaders (opencode.ts, cline.ts), numbers
 * made up; each total priced by hand.
 */
/** OpenCode's JSON files: an assistant message with a path, a user message, a claude-agent one, one with no path whose session names its folder. */
export declare function writeOpenCodeJson(home: string): void;
/** Cline: an extension task (one request names its model, one takes the task's, four that are not requests), a CLI session, an older CLI task. */
export declare function writeCline(home: string): void;
