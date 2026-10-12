/**
 * The MCP schema tax: what each MCP server's tool definitions add to every
 * request, and whether the server is used at all.
 *
 * Tool definitions (name, description, JSON schema) ride in the request's
 * `tools` array, so they are part of the fixed overhead `overhead` measures;
 * transcripts never contain them. Two sources:
 *  - usage, from transcripts: every MCP call is a tool_use named
 *    `mcp__<server>__<tool>`, which also reveals servers the app provides
 *    (desktop browser, connectors) that no config file lists;
 *  - size, by asking each configured server for its tool list, exactly as
 *    Claude Code does at startup. That launches the servers, so it runs only
 *    when asked (`overhead --mcp`).
 *
 * Claude Code's tool search defers MCP definitions until the model looks them
 * up; with it on, an unused server costs about its tool names, not its
 * schemas. Usage of ToolSearch in the transcripts says whether that is so.
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { forEachLine, listSessions } from "./session.js";
import { subagentDir } from "./subagents.js";
import { estimateTokens } from "./tokens.js";
const CLAUDE = "claude-opus-5";
/** Claude Code's spelling of a server name inside tool names. */
export function toolPrefixName(server) {
    return server.replace(/[^A-Za-z0-9_-]/g, "_");
}
/** MCP servers Claude Code starts in `cwd`, with their launch configs. */
export function claudeMcpConfigs(cwd = process.cwd(), home = homedir()) {
    const out = new Map();
    const addAll = (servers, scope) => {
        for (const [name, c] of Object.entries(servers ?? {})) {
            if (c && typeof c === "object")
                out.set(name, { name, scope, command: c.command, args: c.args, env: c.env, url: c.url, type: c.type });
        }
    };
    try {
        const cfg = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
        addAll(cfg.mcpServers, "user");
        addAll(cfg.projects?.[resolve(cwd)]?.mcpServers, "project");
    }
    catch {
        /* absent */
    }
    try {
        addAll(JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8")).mcpServers, ".mcp.json");
    }
    catch {
        /* absent */
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
/**
 * MCP calls per server over the last `days`, from Claude Code transcripts
 * and their subagents' (`<session>/subagents/agent-*.jsonl`). Only lines
 * naming an MCP tool or ToolSearch are parsed.
 *
 * Subagents: on the author's machine 49 Gmail and 23 Slack connector calls
 * were made only by subagents, so scanning the top-level transcripts alone
 * told the user to remove a server their subagents use. Once per call: a
 * forked session starts as a copy of its parent's history, the same rows
 * (uuid) holding the same calls (tool_use id), so a call is counted once by
 * the two together; like replyCounter, that leaves alone hand-made
 * transcripts that reuse an id. Each call by its own row's time: a file
 * touched in the window also holds every older call of its session (2,983
 * of them in one 30-day count). Rows without a timestamp count with their
 * file.
 */
export function mcpUsage(days = 30, paths) {
    const since = Date.now() - days * 86_400_000;
    const files = paths ?? listSessions(10_000).filter((s) => s.path.includes(".claude") && s.modifiedAt.getTime() >= since).map((s) => s.path);
    const calls = new Map();
    const counted = new Set();
    let toolSearchSessions = 0;
    for (const path of files) {
        let searched = false;
        const scan = (file) => forEachLine(file, (line) => {
            if (!line.includes('"tool_use"') || (!line.includes('"name":"mcp__') && !line.includes('"name":"ToolSearch"')))
                return;
            let e;
            try {
                e = JSON.parse(line);
            }
            catch {
                return;
            }
            const content = e?.message?.content;
            if (!Array.isArray(content))
                return;
            // Whether a session defers MCP definitions is a property of the
            // session, so ToolSearch counts whenever it was used; calls are dated.
            const before = Date.parse(e?.timestamp) < since;
            for (const b of content) {
                if (b?.type !== "tool_use" || typeof b.name !== "string")
                    continue;
                if (b.name === "ToolSearch") {
                    searched = true;
                    continue;
                }
                if (before)
                    continue;
                const server = /^mcp__(.+?)__./.exec(b.name)?.[1];
                if (!server)
                    continue;
                if (typeof b.id === "string" && typeof e.uuid === "string") {
                    const key = `${e.uuid}\0${b.id}`;
                    if (counted.has(key))
                        continue;
                    counted.add(key);
                }
                calls.set(server, (calls.get(server) ?? 0) + 1);
            }
        });
        scan(path);
        let agents = [];
        try {
            agents = readdirSync(subagentDir(path)).filter((f) => f.endsWith(".jsonl"));
        }
        catch { /* no subagents */ }
        for (const a of agents) {
            try {
                scan(join(subagentDir(path), a));
            }
            catch { /* one unreadable subagent must not sink the report */ }
        }
        if (searched)
            toolSearchSessions++;
    }
    return { calls, sessions: files.length, toolSearchSessions };
}
/** Connect to one server the way a client does and size its tool list. */
export async function measureServer(cfg, timeoutMs = 15_000) {
    if (!cfg.command && !(cfg.url && cfg.type !== "sse")) {
        return { name: cfg.name, error: cfg.type === "sse" ? "SSE server: not measured" : "no command or url" };
    }
    // The SDK is a dependency of the npm package, but the Claude Code plugin runs
    // dist/ from a git checkout with no node_modules. An import failure there
    // used to abort the whole `overhead --mcp` report; it is a per-server note.
    let client;
    let transport;
    try {
        const sdk = await import("@modelcontextprotocol/sdk/client/index.js");
        client = new sdk.Client({ name: "context-doctor-overhead", version: "1" });
        if (cfg.command) {
            const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
            transport = new StdioClientTransport({
                command: cfg.command,
                args: cfg.args ?? [],
                env: { ...process.env, ...(cfg.env ?? {}) },
                stderr: "ignore",
            });
        }
        else {
            const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
            transport = new StreamableHTTPClientTransport(new URL(cfg.url));
        }
    }
    catch (e) {
        const code = e?.code;
        if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
            return { name: cfg.name, error: "MCP SDK not installed (not measured)" };
        }
        return { name: cfg.name, error: String(e?.message ?? e).split("\n")[0].slice(0, 100) };
    }
    let timer;
    const work = (async () => {
        await client.connect(transport);
        const tools = [];
        let cursor;
        do {
            const page = await client.listTools(cursor ? { cursor } : {});
            tools.push(...page.tools);
            cursor = page.nextCursor;
        } while (cursor && tools.length < 5000);
        const prefix = `mcp__${toolPrefixName(cfg.name)}__`;
        const schemaTokens = tools.reduce((s, t) => s + estimateTokens(JSON.stringify({ name: prefix + t.name, description: t.description ?? "", input_schema: t.inputSchema ?? {} }), CLAUDE), 0);
        const nameTokens = tools.reduce((s, t) => s + estimateTokens(prefix + t.name + "\n", CLAUDE), 0);
        return { name: cfg.name, tools: tools.length, schemaTokens, nameTokens };
    })();
    const timeout = new Promise((res) => {
        timer = setTimeout(() => res({ name: cfg.name, error: `no answer in ${timeoutMs / 1000}s` }), timeoutMs);
    });
    try {
        return await Promise.race([work, timeout]);
    }
    catch (e) {
        const msg = String(e?.message ?? e).split("\n")[0];
        return { name: cfg.name, error: /401|403|unauthori[sz]ed/i.test(msg) ? "needs sign-in (not measured)" : msg.slice(0, 100) };
    }
    finally {
        clearTimeout(timer);
        await client.close().catch(() => { });
    }
}
