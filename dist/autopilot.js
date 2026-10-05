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
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEphemeralPath, readJson, writeJsonWithBackup } from "./install.js";
import { formatTokens } from "./tokens.js";
export const DEFAULT_AUTOPILOT_PORT = 8787;
const LABEL = "com.gai-ventures.context-doctor.proxy";
export function autopilotPaths(home = homedir()) {
    const dir = join(home, ".claude");
    return {
        settings: join(dir, "settings.json"),
        config: join(dir, ".context-doctor-autopilot.json"),
        pauseFile: join(dir, ".context-doctor-autopilot-paused"),
        statePath: join(dir, ".context-doctor-autopilot-cleared.json"),
        log: join(dir, ".context-doctor-proxy.log"),
    };
}
export function proxyUrl(port) {
    return `http://127.0.0.1:${port}`;
}
/** The command the service runs. Absolute paths: services start with an empty PATH. */
export function serviceCommand(node, cli, port, paths) {
    return [node, cli, "proxy", "--autopilot", "--port", String(port), "--autopilot-state", paths.statePath, "--autopilot-pause-file", paths.pauseFile];
}
export function launchdPlist(args, log) {
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict>
</plist>
`;
}
export function systemdUnit(args, log) {
    const q = (s) => (/[\s"\\]/.test(s) ? `"${s.replace(/(["\\])/g, "\\$1")}"` : s);
    return `[Unit]
Description=context-doctor proxy (autopilot)

[Service]
ExecStart=${args.map(q).join(" ")}
Restart=always
RestartSec=2
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
}
export function windowsTaskCommand(args) {
    return args.map((a) => `"${a}"`).join(" ");
}
function servicePaths(home = homedir()) {
    return {
        plist: join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
        unit: join(home, ".config", "systemd", "user", "context-doctor-proxy.service"),
    };
}
function uid() {
    return String(process.getuid?.() ?? "");
}
function run(cmd, args) {
    execFileSync(cmd, args, { stdio: "ignore" });
}
function tryRun(cmd, args) {
    try {
        run(cmd, args);
        return true;
    }
    catch {
        return false;
    }
}
/** Install and start the background service for this platform. */
function installService(args, log) {
    const os = platform();
    const sp = servicePaths();
    if (os === "darwin") {
        mkdirSync(dirname(sp.plist), { recursive: true });
        writeFileSync(sp.plist, launchdPlist(args, log));
        tryRun("launchctl", ["bootout", `gui/${uid()}`, sp.plist]);
        run("launchctl", ["bootstrap", `gui/${uid()}`, sp.plist]);
        return `launchd agent ${sp.plist}`;
    }
    if (os === "linux") {
        mkdirSync(dirname(sp.unit), { recursive: true });
        writeFileSync(sp.unit, systemdUnit(args, log));
        if (tryRun("systemctl", ["--user", "daemon-reload"]) && tryRun("systemctl", ["--user", "enable", "--now", "context-doctor-proxy.service"])) {
            tryRun("systemctl", ["--user", "restart", "context-doctor-proxy.service"]);
            return `systemd user service ${sp.unit}`;
        }
        startDetached(args, log);
        return "detached process (systemd --user unavailable; the every-prompt hook restarts it if it stops)";
    }
    if (os === "win32") {
        tryRun("schtasks", ["/Create", "/F", "/SC", "ONLOGON", "/TN", "context-doctor-proxy", "/TR", windowsTaskCommand(args)]);
        startDetached(args, log);
        return "logon task context-doctor-proxy + detached process now";
    }
    startDetached(args, log);
    return "detached process";
}
function removeService() {
    const os = platform();
    const sp = servicePaths();
    if (os === "darwin") {
        tryRun("launchctl", ["bootout", `gui/${uid()}`, sp.plist]);
        if (existsSync(sp.plist))
            rmSync(sp.plist);
    }
    else if (os === "linux") {
        tryRun("systemctl", ["--user", "disable", "--now", "context-doctor-proxy.service"]);
        if (existsSync(sp.unit))
            rmSync(sp.unit);
        tryRun("systemctl", ["--user", "daemon-reload"]);
    }
    else if (os === "win32") {
        tryRun("schtasks", ["/Delete", "/F", "/TN", "context-doctor-proxy"]);
    }
}
export function startDetached(args, log) {
    mkdirSync(dirname(log), { recursive: true });
    const out = openSync(log, "a");
    const child = spawn(args[0], args.slice(1), { detached: true, stdio: ["ignore", out, out], windowsHide: true });
    child.unref();
}
export async function health(port, timeoutMs = 800) {
    try {
        const r = await fetch(`${proxyUrl(port)}/health`, { signal: AbortSignal.timeout(timeoutMs) });
        const j = (await r.json());
        return { ok: Boolean(j.ok && j.service === "context-doctor-proxy"), autopilot: j.autopilot, version: j.version };
    }
    catch {
        return { ok: false };
    }
}
async function waitHealthy(port, ms) {
    const end = Date.now() + ms;
    for (;;) {
        const h = await health(port);
        if (h.ok && h.autopilot)
            return h;
        if (Date.now() > end)
            return h;
        await new Promise((r) => setTimeout(r, 250));
    }
}
function readConfig(paths) {
    // readJson returns {} for a missing file; only a file with a port is a config.
    if (!existsSync(paths.config))
        return undefined;
    try {
        const cfg = readJson(paths.config);
        return typeof cfg.port === "number" && cfg.port > 0 ? cfg : undefined;
    }
    catch {
        return undefined;
    }
}
/** Which Claude Code surfaces ran recent sessions: entrypoint -> count. */
export function recentSurfaces(days = 30, home = homedir()) {
    const out = new Map();
    const root = join(home, ".claude", "projects");
    const since = Date.now() - days * 86_400_000;
    let dirs = [];
    try {
        dirs = readdirSync(root);
    }
    catch {
        return out;
    }
    for (const d of dirs) {
        let files = [];
        try {
            files = readdirSync(join(root, d)).filter((f) => f.endsWith(".jsonl"));
        }
        catch {
            continue;
        }
        for (const f of files) {
            const p = join(root, d, f);
            try {
                if (statSync(p).mtimeMs < since)
                    continue;
                // The surface is recorded in the first lines; never read a 300 MB
                // transcript to find it (this took 10 s on a real machine).
                const fd = openSync(p, "r");
                const buf = Buffer.alloc(64 * 1024);
                let n = 0;
                try {
                    n = readSync(fd, buf, 0, buf.length, 0);
                }
                finally {
                    closeSync(fd);
                }
                const head = buf.toString("utf8", 0, n);
                const m = head.match(/"entrypoint":"([^"]+)"/);
                const ep = m ? m[1] : "unknown";
                out.set(ep, (out.get(ep) ?? 0) + 1);
            }
            catch { /* unreadable: skip */ }
        }
    }
    return out;
}
/** Lines explaining which recent sessions autopilot can reach, or nothing when all can. */
export function reachNote(days = 30) {
    const surfaces = recentSurfaces(days);
    let desktop = 0, other = 0;
    // Sessions with no recorded surface are evidence of nothing either way.
    for (const [ep, n] of surfaces) {
        if (ep.startsWith("claude-desktop"))
            desktop += n;
        else if (ep !== "unknown")
            other += n;
    }
    if (desktop === 0)
        return [];
    const lines = [
        `! ${desktop} of your ${desktop + other} Claude Code sessions in the last ${days} days (with a recorded surface) ran in the desktop app. The desktop app`,
        "  sets its own API address and ignores the one in settings.json, so autopilot cannot reach those sessions.",
        "  It applies to Claude Code in a terminal (`claude`) and in IDEs. For desktop sessions, the every-prompt",
        "  hook points out when /compact would pay off, and `context-doctor compact-window` makes Claude Code",
        "  compact earlier by itself, which the desktop app honours (see `context-doctor savings`).",
    ];
    if (other === 0)
        lines.push("  Every recent session of yours is a desktop one: autopilot will not change anything until you use the terminal or an IDE.");
    return lines;
}
export function currentCli() {
    return join(dirname(fileURLToPath(import.meta.url)), "cli.js");
}
export async function autopilotOn(port = DEFAULT_AUTOPILOT_PORT, paths = autopilotPaths()) {
    const lines = [];
    const cli = currentCli();
    if (isEphemeralPath(cli) || /[\\/]\.claude[\\/]plugins[\\/]/.test(cli)) {
        return {
            ok: false,
            lines: [
                "✗ Running from the npx cache or a Claude Code plugin copy, which are replaced or deleted on update; a background service cannot point there.",
                "  Install it once, then re-run:  npm install -g context-doctor && context-doctor autopilot on",
            ],
        };
    }
    const existing = await health(port);
    if (existing.ok && !existing.autopilot) {
        return { ok: false, lines: [`✗ A context-doctor proxy without autopilot is already on port ${port}. Stop it, or pass --port.`] };
    }
    if (!existing.ok) {
        // Something that is not us on the port would receive Claude Code's traffic.
        try {
            await fetch(proxyUrl(port), { signal: AbortSignal.timeout(500) });
            return { ok: false, lines: [`✗ Port ${port} is taken by another program. Pass --port <free port>.`] };
        }
        catch {
            /* nothing listening: good */
        }
    }
    const args = serviceCommand(process.execPath, cli, port, paths);
    const how = installService(args, paths.log);
    const h = await waitHealthy(port, 15_000);
    if (!h.ok || !h.autopilot) {
        removeService();
        return { ok: false, lines: [`✗ The proxy did not come up on port ${port} (log: ${paths.log}). Nothing was changed in Claude Code's settings.`] };
    }
    lines.push(`✓ Proxy running with autopilot on ${proxyUrl(port)} (${how})`);
    const settings = readJson(paths.settings);
    const env = (settings.env ??= {});
    const prev = readConfig(paths);
    const previousBaseUrl = prev?.previousBaseUrl !== undefined ? prev.previousBaseUrl : (env.ANTHROPIC_BASE_URL ?? null);
    if (previousBaseUrl && previousBaseUrl !== proxyUrl(port)) {
        lines.push(`! settings.json already routed Claude Code to ${previousBaseUrl}; autopilot forwards to api.anthropic.com instead. \`autopilot off\` restores it.`);
    }
    env.ANTHROPIC_BASE_URL = proxyUrl(port);
    writeJsonWithBackup(paths.settings, settings);
    writeFileSync(paths.config, JSON.stringify({ port, previousBaseUrl, node: process.execPath, cli }, null, 2));
    if (existsSync(paths.pauseFile))
        rmSync(paths.pauseFile);
    lines.push(`✓ Claude Code routed through it (env.ANTHROPIC_BASE_URL in ${paths.settings})`);
    lines.push("  Applies to Claude Code sessions started from now on (CLI, IDE, and the desktop app's Code tab).");
    lines.push("  Sessions already open keep their old route until restarted.");
    lines.push(...reachNote());
    lines.push(`  GPT apps on your own OpenAI key get the same: export OPENAI_BASE_URL=${proxyUrl(port)}/v1`);
    return { ok: true, lines };
}
export async function autopilotOff(paths = autopilotPaths()) {
    const lines = [];
    const cfg = readConfig(paths);
    const settings = readJson(paths.settings);
    const env = settings.env;
    if (env?.ANTHROPIC_BASE_URL && cfg && env.ANTHROPIC_BASE_URL === proxyUrl(cfg.port)) {
        if (cfg.previousBaseUrl)
            env.ANTHROPIC_BASE_URL = cfg.previousBaseUrl;
        else
            delete env.ANTHROPIC_BASE_URL;
        if (Object.keys(env).length === 0)
            delete settings.env;
        writeJsonWithBackup(paths.settings, settings);
        lines.push("✓ Claude Code no longer routed through the proxy (new sessions)");
    }
    removeService();
    if (existsSync(paths.config))
        rmSync(paths.config);
    if (existsSync(paths.pauseFile))
        rmSync(paths.pauseFile);
    lines.push("✓ Background service removed");
    lines.push("  Sessions started while autopilot was on still point at the proxy: restart them.");
    lines.push("  To switch off without restarting anything, use `autopilot pause` instead.");
    return lines;
}
export function autopilotPause(paused, paths = autopilotPaths()) {
    if (paused) {
        writeFileSync(paths.pauseFile, new Date().toISOString());
        return "✓ Paused: the proxy now forwards every request unchanged. `autopilot resume` turns it back on.";
    }
    if (existsSync(paths.pauseFile))
        rmSync(paths.pauseFile);
    return "✓ Resumed: stale tool output is cleared again.";
}
export async function autopilotStatus(paths = autopilotPaths()) {
    const cfg = readConfig(paths);
    if (!cfg)
        return ["Autopilot is off. `context-doctor autopilot on` turns it on for every new Claude Code session."];
    const lines = [];
    const h = await health(cfg.port);
    const env = (readJson(paths.settings).env ?? {});
    lines.push(`${h.ok ? "✓" : "✗"} Proxy ${proxyUrl(cfg.port)} ${h.ok ? `up (v${h.version ?? "?"})` : "NOT RESPONDING (the next Claude Code prompt restarts it via the hook)"}`);
    lines.push(`${env.ANTHROPIC_BASE_URL === proxyUrl(cfg.port) ? "✓" : "✗"} Claude Code routed through it`);
    if (existsSync(paths.pauseFile))
        lines.push("! Paused: requests pass through unchanged");
    if (h.ok) {
        try {
            const s = (await fetch(`${proxyUrl(cfg.port)}/stats`, { signal: AbortSignal.timeout(1000) }).then((r) => r.json()));
            const a = s.autopilot;
            if (a) {
                lines.push("");
                lines.push(`Since ${s.startedAt.slice(0, 16).replace("T", " ")} UTC: ${a.requests} requests, ${a.changedRequests} sent lighter`);
                lines.push(`  ${a.resultsCleared} stale tool outputs cleared in ${a.batches} batches (${a.coldBatches} while the cache was cold anyway)`);
                lines.push(`  ~${formatTokens(a.tokensRemoved)} tokens not sent`);
                if (a.requests === 0)
                    lines.push(...reachNote(7).map((l) => l.replace(/^! /, "  ")));
                const billed = s.upstreamInputTokens + s.upstreamCacheReadTokens + s.upstreamCacheWriteTokens;
                if (billed > 0)
                    lines.push(`  Billed input: ${formatTokens(billed)} (${Math.round((s.upstreamCacheReadTokens / billed) * 100)}% cache reads)`);
                if (a.lastReason)
                    lines.push(`  Last decision: ${a.lastReason}`);
            }
        }
        catch {
            /* stats are informational */
        }
    }
    return lines;
}
/**
 * Called by the every-prompt hook: if autopilot is on and the proxy is down,
 * start it before the prompt's request goes out. Returns quickly either way.
 */
export async function ensureProxyUp(paths = autopilotPaths()) {
    const cfg = readConfig(paths);
    if (!cfg)
        return;
    if ((await health(cfg.port, 300)).ok)
        return;
    if (typeof cfg.node !== "string" || typeof cfg.cli !== "string" || !existsSync(cfg.node) || !existsSync(cfg.cli))
        return;
    startDetached(serviceCommand(cfg.node, cfg.cli, cfg.port, paths), paths.log);
    await waitHealthy(cfg.port, 2500);
}
