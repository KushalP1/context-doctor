/**
 * How Claude Desktop's chat actually uses the MCP server, from Desktop's own
 * log. Desktop gives an MCP server no hook and no transcript, so its
 * per-server log (mcp-server-context-doctor.log: initialize, tools/list,
 * tools/call) is the only evidence that the tools are offered and called.
 * Desktop does not log which pages are opened, so chat activity itself cannot
 * be measured locally; Code-tab sessions can (Claude Code transcripts record
 * the desktop app as their entrypoint), and those reach context-doctor
 * through Claude Code's hook and MCP config, not through this server.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
export function desktopLogDir(home = homedir()) {
    switch (platform()) {
        case "darwin": return join(home, "Library", "Logs", "Claude");
        case "win32": return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "logs");
        default: return join(home, ".config", "Claude", "logs");
    }
}
export function desktopUsage(dir = desktopLogDir()) {
    const server = join(dir, "mcp-server-context-doctor.log");
    if (!existsSync(server))
        return undefined;
    const text = readFileSync(server, "utf8");
    const count = (m) => text.split(`method="${m}"`).length - 1;
    const calls = [...text.matchAll(/^(\d{4}-\d\d-\d\d)T[^\n]*method="tools\/call"/gm)];
    return { launches: count("initialize"), toolLists: count("tools/list"), toolCalls: count("tools/call"), lastCall: calls.at(-1)?.[1] };
}
/** One line for `doctor`: the numbers, and what to do with them. `codeTabSessions`: this week's Claude Code sessions run in Desktop's Code tab. */
export function describeDesktopUsage(u, codeTabSessions = 0) {
    const base = `tools offered in ${u.toolLists} of ${u.launches} launches, called ${u.toolCalls} time(s)${u.lastCall ? ` (last ${u.lastCall})` : ""}`;
    const code = codeTabSessions > 0 ? `; your ${codeTabSessions} Code-tab sessions this week use the hook instead` : "";
    return `${base}${code}. In a chat the model decides when to call them: the + menu's context_checkup prompt runs one on demand`;
}
