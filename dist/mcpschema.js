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
/** The MCP resource tools (current names and their pre-rename spellings, as the 2.1.308 binary maps them): their `server` input names the server. */
export const MCP_RESOURCE_TOOLS = /^(ListMcpResources|ReadMcpResource|ReadMcpResourceDir)(Tool)?$/;
/** A prompt run as a slash command: `<command-name>/mcp__server__prompt</command-name>`. */
export const MCP_PROMPT_COMMAND = /<command-name>\/(mcp__[\w-]+?__[^<\s]+)<\/command-name>/g;
/**
 * Uses of each configured server: every tool or prompt name counted under the
 * LONGEST configured prefix `mcp__<toolPrefixName(name)>__` it starts with (so
 * "linear" does not take "linear (work)"'s calls), plus resource-tool calls
 * whose `server` input is the server's name.
 */
export function serverUses(configNames, usage) {
    const prefixes = configNames.map((name) => ({ name, prefix: `mcp__${toolPrefixName(name)}__` })).sort((a, b) => b.prefix.length - a.prefix.length);
    const out = new Map(configNames.map((n) => [n, 0]));
    for (const [full, n] of usage.names) {
        const hit = prefixes.find((p) => full.startsWith(p.prefix));
        if (hit)
            out.set(hit.name, (out.get(hit.name) ?? 0) + n);
    }
    for (const [server, n] of usage.resources) {
        const hit = configNames.find((c) => c === server) ?? configNames.find((c) => toolPrefixName(c) === toolPrefixName(server));
        if (hit)
            out.set(hit, (out.get(hit) ?? 0) + n);
    }
    return out;
}
/** Names no configured prefix claims: the app's own servers and connectors, by the first-guess parse. */
export function otherServerUses(configNames, usage) {
    const prefixes = configNames.map((name) => `mcp__${toolPrefixName(name)}__`);
    const out = new Map();
    for (const [full, n] of usage.names) {
        if (prefixes.some((p) => full.startsWith(p)))
            continue;
        const server = /^mcp__(.+?)__./.exec(full)?.[1];
        if (server)
            out.set(server, (out.get(server) ?? 0) + n);
    }
    return out;
}
/** Count one row's MCP uses into `names` and `resources`: tool calls, resource-tool calls, prompts run as slash commands. */
export function countMcpRow(e, names, resources) {
    const content = e?.message?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n") : "";
    if (e?.type === "user" && text.includes("<command-name>/mcp__")) {
        for (const m of text.matchAll(MCP_PROMPT_COMMAND))
            names.set(m[1], (names.get(m[1]) ?? 0) + 1);
    }
    if (!Array.isArray(content))
        return;
    for (const b of content) {
        if (b?.type !== "tool_use" || typeof b.name !== "string")
            continue;
        if (b.name.startsWith("mcp__"))
            names.set(b.name, (names.get(b.name) ?? 0) + 1);
        else if (MCP_RESOURCE_TOOLS.test(b.name) && typeof b.input?.server === "string")
            resources.set(b.input.server, (resources.get(b.input.server) ?? 0) + 1);
    }
}
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
export function mcpUsage(days = 30, paths, onProgress) {
    const since = Date.now() - days * 86_400_000;
    const files = paths ?? listSessions(10_000).filter((s) => s.path.includes(".claude") && s.modifiedAt.getTime() >= since).map((s) => s.path);
    const names = new Map();
    const resources = new Map();
    const counted = new Set();
    let toolSearchSessions = 0;
    for (const [index, path] of files.entries()) {
        onProgress?.(index, files.length);
        let searched = false;
        const scan = (file) => forEachLine(file, (line) => {
            const tool = line.includes('"tool_use"') && (line.includes('"name":"mcp__') || line.includes('"name":"ToolSearch"') || line.includes('McpResource'));
            if (!tool && !line.includes("<command-name>/mcp__"))
                return;
            let e;
            try {
                e = JSON.parse(line);
            }
            catch {
                return;
            }
            const content = e?.message?.content;
            // Whether a session defers MCP definitions is a property of the
            // session, so ToolSearch counts whenever it was used; calls are dated.
            if (Array.isArray(content) && content.some((b) => b?.type === "tool_use" && b.name === "ToolSearch"))
                searched = true;
            if (Date.parse(e?.timestamp) < since)
                return;
            // A fork's copied rows (same uuid) were counted in the parent.
            if (typeof e.uuid === "string") {
                if (counted.has(e.uuid))
                    return;
                counted.add(e.uuid);
            }
            countMcpRow(e, names, resources);
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
    const calls = new Map();
    for (const [full, n] of names) {
        const server = /^mcp__(.+?)__./.exec(full)?.[1];
        if (server)
            calls.set(server, (calls.get(server) ?? 0) + n);
    }
    return { calls, names, resources, sessions: files.length, toolSearchSessions };
}
/** Connect to one server the way a client does and size its tool list. */
export async function measureServer(cfg, timeoutMs = 15_000) {
    if (!cfg.command && !(cfg.url && cfg.type !== "sse")) {
        return { name: cfg.name, error: cfg.type === "sse" ? "SSE server: not measured" : "no command or url" };
    }
    // The SDK's client comes from dist/mcpclient.js, which the build bundles
    // with the SDK inside: the npm package has no runtime dependencies, and the
    // Claude Code plugin runs dist/ from a git checkout with no node_modules.
    // Should it still fail to load, that is a per-server note, never a crash
    // that loses the whole `overhead --mcp` report.
    let client;
    let transport;
    try {
        const sdk = await import("./mcpclient.js");
        client = new sdk.Client({ name: "context-doctor-overhead", version: "1" });
        if (cfg.command) {
            const { StdioClientTransport } = sdk;
            transport = new StdioClientTransport({
                command: cfg.command,
                args: cfg.args ?? [],
                env: { ...process.env, ...(cfg.env ?? {}) },
                stderr: "ignore",
            });
        }
        else {
            const { StreamableHTTPClientTransport } = sdk;
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
