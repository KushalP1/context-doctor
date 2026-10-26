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
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { SERVER_INSTRUCTIONS } from "./rules.js";
/** Copilot's home: $COPILOT_HOME when set, else ~/.copilot. */
export function copilotHome() {
    return process.env.COPILOT_HOME || join(homedir(), ".copilot");
}
export function copilotMcpConfigPath() {
    return join(copilotHome(), "mcp-config.json");
}
/** Our own hook file: install creates it, uninstall deletes it. */
export function copilotHookFilePath() {
    return join(copilotHome(), "hooks", "context-doctor.json");
}
/** Inline settings Copilot also reads; `disableAllHooks` there turns every hook off. */
export function copilotSettingsPath() {
    return join(copilotHome(), "settings.json");
}
/** The older settings file; doctor still honours a disableAllHooks there. */
export function copilotLegacyConfigPath() {
    return join(copilotHome(), "config.json");
}
/** VS Code's user folders (stable and Insiders): VS Code ships Copilot built in. */
export function vsCodeUserDirs() {
    const base = platform() === "darwin" ? join(homedir(), "Library", "Application Support")
        : platform() === "win32" ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
            : join(homedir(), ".config");
    return ["Code", "Code - Insiders"].map((app) => join(base, app, "User"));
}
export function vsCodePresent() {
    return vsCodeUserDirs().some((d) => existsSync(d));
}
/** The one event install registers. */
export const COPILOT_HOOK_EVENT = "sessionStart";
/** Is this hook-file entry ours? Install writes `<context-doctor> hook copilot`. */
export function isOurCopilotEntry(entry) {
    const e = entry;
    return /(cli\.js|context-doctor(\.cmd|\.exe|\.bat)?)"?\s+hook\s+copilot\s*$/.test(String(e?.command ?? e?.bash ?? ""));
}
/** What a new Copilot session is given: the standing rules, tagged as ours. */
export function copilotSessionContext() {
    return `<context-doctor>\n${SERVER_INSTRUCTIONS}\n</context-doctor>`;
}
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
export function copilotSessionStartOutput(input) {
    const obj = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const event = obj.hook_event_name;
    if (event !== undefined && event !== "SessionStart" && event !== "sessionStart")
        return undefined;
    const context = copilotSessionContext();
    return JSON.stringify({ additionalContext: context, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } });
}
