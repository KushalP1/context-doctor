/**
 * `context-doctor autopilot on|off|pause|resume|status`
 *
 * Puts the proxy, in autopilot mode, in front of every Claude Code session on
 * this machine, as a background service that starts at login and restarts if
 * it dies, then points Claude Code at it through ~/.claude/settings.json.
 *
 * Order matters, because a base URL pointing at a dead port breaks every new
 * session: the service is installed and must answer /health BEFORE settings
 * are touched, and `off` removes the setting BEFORE stopping the service.
 * `pause` leaves everything wired and makes the proxy a pure passthrough,
 * which is the way to switch autopilot off without breaking sessions that
 * are already running against it.
 *
 * What this cannot reach, stated rather than implied: Claude Desktop's chat
 * tab and claude.ai (their requests leave from Anthropic's app, not from a
 * process that reads settings.json), Cursor's own models (sent from Cursor's
 * servers), and Codex signed in with ChatGPT (its traffic goes to ChatGPT's
 * backend, not an API base URL).
 */
export declare const DEFAULT_AUTOPILOT_PORT = 8787;
export interface AutopilotPaths {
    settings: string;
    config: string;
    pauseFile: string;
    statePath: string;
    log: string;
}
export declare function autopilotPaths(home?: string): AutopilotPaths;
export declare function proxyUrl(port: number): string;
/** The command the service runs. Absolute paths: services start with an empty PATH. */
export declare function serviceCommand(node: string, cli: string, port: number, paths: AutopilotPaths): string[];
export declare function launchdPlist(args: string[], log: string): string;
export declare function systemdUnit(args: string[], log: string): string;
export declare function windowsTaskCommand(args: string[]): string;
export declare function startDetached(args: string[], log: string): void;
export interface Health {
    ok: boolean;
    autopilot?: boolean;
    version?: string;
}
export declare function health(port: number, timeoutMs?: number): Promise<Health>;
export declare function currentCli(): string;
export declare function autopilotOn(port?: number, paths?: AutopilotPaths): Promise<{
    ok: boolean;
    lines: string[];
}>;
export declare function autopilotOff(paths?: AutopilotPaths): Promise<string[]>;
export declare function autopilotPause(paused: boolean, paths?: AutopilotPaths): string;
export declare function autopilotStatus(paths?: AutopilotPaths): Promise<string[]>;
/**
 * Called by the every-prompt hook: if autopilot is on and the proxy is down,
 * start it before the prompt's request goes out. Returns quickly either way.
 */
export declare function ensureProxyUp(paths?: AutopilotPaths): Promise<void>;
