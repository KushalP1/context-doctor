/**
 * GitHub Copilot: the Copilot CLI, the GitHub Copilot app, and VS Code's
 * agent sessions, whose default harness ("Copilot") is the same runtime as
 * the CLI. Checked 2026-10-25 against GitHub's hooks reference
 * (docs.github.com/en/copilot/reference/hooks-reference), VS Code's hooks,
 * harness and MCP pages (code.visualstudio.com, updated 2026-10-21) and the
 * Copilot Chat 0.61.0 extension built into VS Code 1.133:
 *
 * - Hooks: `~/.copilot/hooks/*.json` (or `$COPILOT_HOME/hooks/`), each
 *   `{"version": 1, "hooks": {"<event>": [{type, command, timeoutSec}]}}`.
 *   VS Code's older "Local" harness reads the same user hook files and
 *   accepts the Copilot event names.
 * - Of the events that can add context, none carries a transcript path:
 *   `sessionStart` (additionalContext), `postToolUse`, `postToolUseFailure`.
 *   A transcript path reaches only agentStop, subagentStart, subagentStop
 *   and preCompact, which add nothing to the main agent's context (preCompact
 *   is a notification). So the every-prompt size check has nothing to read
 *   here, and only the standing rules go in, once per new session.
 * - The Copilot harness reads top-level `additionalContext`; VS Code's Local
 *   harness reads `hookSpecificOutput.additionalContext` for SessionStart
 *   (seen in the extension's code). The answer carries both, and each
 *   harness takes its own.
 * - MCP: `~/.copilot/mcp-config.json` (`$COPILOT_HOME/mcp-config.json`),
 *   `{"mcpServers": {name: {type: "local", command, args, tools: ["*"]}}}`.
 *   Copilot harness sessions read it directly, in VS Code too, according to
 *   VS Code's MCP docs of 2026-10-21 (no file of the installed VS Code 1.133
 *   mentions it yet). VS Code's user-profile mcp.json is labelled deprecated
 *   there and is forwarded into the same sessions, so it is not written as
 *   well; `doctor` warns when it also starts context-doctor, since the tools
 *   could then load twice.
 */
/** Copilot's home: $COPILOT_HOME when set, else ~/.copilot. */
export declare function copilotHome(): string;
export declare function copilotMcpConfigPath(): string;
/** Our own hook file: install creates it, uninstall deletes it. */
export declare function copilotHookFilePath(): string;
/** Inline settings Copilot also reads; `disableAllHooks` there turns every hook off. */
export declare function copilotSettingsPath(): string;
/** The older settings file; doctor still honours a disableAllHooks there. */
export declare function copilotLegacyConfigPath(): string;
/** VS Code's user folders (stable and Insiders): VS Code ships Copilot built in. */
export declare function vsCodeUserDirs(): string[];
export declare function vsCodePresent(): boolean;
/** The one event install registers. */
export declare const COPILOT_HOOK_EVENT = "sessionStart";
/** Is this hook-file entry ours? Install writes `<context-doctor> hook copilot`. */
export declare function isOurCopilotEntry(entry: unknown): boolean;
/** What a new Copilot session is given: the standing rules, tagged as ours. */
export declare function copilotSessionContext(): string;
/**
 * The hook's answer to a session start, or undefined to stay silent for an
 * event other than a session start. A resumed session is answered too: the
 * Copilot runtime keeps sessionStart context in memory and sends it with
 * each turn, and does not restore it on resume (seen in VS Code's bundled
 * runtime, 1.0.73 and 1.0.79), so a resumed session has the rules only if
 * the hook gives them again.
 *
 * Input shapes: the Copilot harness sends camelCase without an event name
 * for camelCase keys ({sessionId, timestamp, cwd, source}); VS Code's Local
 * harness and the Copilot harness's PascalCase aliases send
 * {hook_event_name: "SessionStart", session_id, ...}.
 */
export declare function copilotSessionStartOutput(input: unknown): string | undefined;
