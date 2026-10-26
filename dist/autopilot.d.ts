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
/**
 * The service restarts the proxy when it fails, not when it exits 0. The
 * proxy exits 0 when another context-doctor proxy already serves its port;
 * with KeepAlive true (Restart=always) launchd restarted it into the same
 * EADDRINUSE every 5 s, 45 times in one real log.
 */
export declare function launchdPlist(args: string[], log: string): string;
export declare function systemdUnit(args: string[], log: string): string;
export declare function windowsTaskCommand(args: string[]): string;
/**
 * Runs a service-manager command, true on success. Injectable so tests can
 * use a throwaway HOME without ever reaching the real launchd, systemd or
 * Task Scheduler: those name the service globally (a label, a unit name, a
 * task name), not per HOME.
 */
export type ServiceExec = (cmd: string, args: string[]) => boolean;
/**
 * Claude Code turns MCP tool search off when ANTHROPIC_BASE_URL is not an
 * Anthropic host ("Set ENABLE_TOOL_SEARCH=true (or auto / auto:N) if your
 * proxy forwards tool_reference blocks", 2.1.295), so routing it through
 * autopilot loaded every MCP tool definition into every request. The proxy
 * forwards those blocks and the anthropic-beta header untouched, so tool
 * search stays on ("auto", Claude Code's own default) unless the user set it.
 * Returns true when we set it.
 */
export declare function keepToolSearch(env: Record<string, string>): boolean;
/** Version of the package a CLI path belongs to (dist/cli.js -> ../package.json). */
export declare function installedVersion(cli: string): string | undefined;
/** Restart the installed background service onto the current build (launchd, systemd). */
export declare function restartService(home?: string, exec?: ServiceExec): boolean;
export declare function startDetached(args: string[], log: string): void;
export interface Health {
    ok: boolean;
    autopilot?: boolean;
    version?: string;
}
export declare function health(port: number, timeoutMs?: number): Promise<Health>;
/** Who holds a local port: nobody, our proxy, or another program (named when it says). */
export interface PortOccupant {
    listening: boolean;
    ours: boolean;
    /** What the other program calls itself: its /health service, its Server header, or its process name. */
    name?: string;
    pid?: number;
}
/**
 * Whether something already listens on 127.0.0.1:`port`, and whether it is
 * this proxy. Another local proxy on autopilot's port (Headroom's default is
 * 8787 too) makes `autopilot on` fail to start, or, with Claude Code already
 * routed there, sends its requests through the other program.
 */
export declare function portOccupant(port: number, timeoutMs?: number): Promise<PortOccupant>;
export declare function baseUrlToRestore(paths: AutopilotPaths, port: number, current: string | null): string | null;
/** Which Claude Code surfaces ran recent sessions: entrypoint -> count. */
export declare function recentSurfaces(days?: number, home?: string): Map<string, number>;
/** Lines explaining which recent sessions autopilot can reach, or nothing when all can. */
export declare function reachNote(days?: number): string[];
export declare function currentCli(): string;
export declare function autopilotOn(port?: number, paths?: AutopilotPaths): Promise<{
    ok: boolean;
    lines: string[];
}>;
export declare function autopilotOff(paths?: AutopilotPaths, exec?: ServiceExec): Promise<string[]>;
export declare function autopilotPause(paused: boolean, paths?: AutopilotPaths): string;
/**
 * Pause or resume, saying what actually happened. Without autopilot on there
 * is no proxy to pause: this used to claim "✓ Paused" over nothing, and on a
 * machine with no ~/.claude it threw ENOENT writing the pause file. `ok` is
 * false when nothing was done, for the exit code.
 */
export declare function autopilotPauseResult(paused: boolean, paths?: AutopilotPaths): {
    ok: boolean;
    message: string;
};
export declare function autopilotStatus(paths?: AutopilotPaths): Promise<string[]>;
/**
 * Called by the every-prompt hook: if autopilot is on and the proxy is down,
 * start it before the prompt's request goes out. Returns quickly either way.
 */
export declare function ensureProxyUp(paths?: AutopilotPaths, exec?: ServiceExec): Promise<void>;
