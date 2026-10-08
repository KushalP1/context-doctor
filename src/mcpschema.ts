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

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { forEachLine, listSessions } from "./session.js";
import { estimateTokens } from "./tokens.js";

const CLAUDE = "claude-opus-5";

export interface McpServerConfig {
  name: string;
  scope: "user" | "project" | ".mcp.json";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
}

export interface McpServerSize {
  name: string;
  tools?: number;
  /** Tokens of the full definitions: what an up-front load costs on every request. */
  schemaTokens?: number;
  /** Tokens of the tool names alone: roughly what a deferred load costs. */
  nameTokens?: number;
  error?: string;
}

export interface McpUsage {
  /** Calls per server name (as it appears in tool names), main chain and subagents. */
  calls: Map<string, number>;
  sessions: number;
  /** Sessions in which the model used ToolSearch, i.e. MCP definitions were deferred. */
  toolSearchSessions: number;
}

/** Claude Code's spelling of a server name inside tool names. */
export function toolPrefixName(server: string): string {
  return server.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** MCP servers Claude Code starts in `cwd`, with their launch configs. */
export function claudeMcpConfigs(cwd = process.cwd(), home = homedir()): McpServerConfig[] {
  const out = new Map<string, McpServerConfig>();
  const addAll = (servers: Record<string, any> | undefined, scope: McpServerConfig["scope"]) => {
    for (const [name, c] of Object.entries(servers ?? {})) {
      if (c && typeof c === "object") out.set(name, { name, scope, command: c.command, args: c.args, env: c.env, url: c.url, type: c.type });
    }
  };
  try {
    const cfg = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    addAll(cfg.mcpServers, "user");
    addAll(cfg.projects?.[resolve(cwd)]?.mcpServers, "project");
  } catch {
    /* absent */
  }
  try {
    addAll(JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8")).mcpServers, ".mcp.json");
  } catch {
    /* absent */
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** MCP calls per server over the last `days`, from Claude Code transcripts (a cheap line scan, no JSON parse per line). */
export function mcpUsage(days = 30, paths?: string[]): McpUsage {
  const since = Date.now() - days * 86_400_000;
  const files = paths ?? listSessions(10_000).filter((s) => s.path.includes(".claude") && s.modifiedAt.getTime() >= since).map((s) => s.path);
  const calls = new Map<string, number>();
  let toolSearchSessions = 0;
  for (const path of files) {
    let searched = false;
    forEachLine(path, (line) => {
      if (!line.includes('"tool_use"')) return;
      for (const m of line.matchAll(/"name":"mcp__([^"]+?)__[^"]+"/g)) calls.set(m[1], (calls.get(m[1]) ?? 0) + 1);
      if (!searched && line.includes('"name":"ToolSearch"')) searched = true;
    });
    if (searched) toolSearchSessions++;
  }
  return { calls, sessions: files.length, toolSearchSessions };
}

/** Connect to one server the way a client does and size its tool list. */
export async function measureServer(cfg: McpServerConfig, timeoutMs = 15_000): Promise<McpServerSize> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const client = new Client({ name: "context-doctor-overhead", version: "1" });
  let transport: any;
  if (cfg.command) {
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
      stderr: "ignore",
    });
  } else if (cfg.url && cfg.type !== "sse") {
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    transport = new StreamableHTTPClientTransport(new URL(cfg.url));
  } else {
    return { name: cfg.name, error: cfg.type === "sse" ? "SSE server: not measured" : "no command or url" };
  }
  let timer: NodeJS.Timeout | undefined;
  const work = (async () => {
    await client.connect(transport);
    const tools: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor && tools.length < 5000);
    const prefix = `mcp__${toolPrefixName(cfg.name)}__`;
    const schemaTokens = tools.reduce(
      (s, t) => s + estimateTokens(JSON.stringify({ name: prefix + t.name, description: t.description ?? "", input_schema: t.inputSchema ?? {} }), CLAUDE),
      0
    );
    const nameTokens = tools.reduce((s, t) => s + estimateTokens(prefix + t.name + "\n", CLAUDE), 0);
    return { name: cfg.name, tools: tools.length, schemaTokens, nameTokens };
  })();
  const timeout = new Promise<McpServerSize>((res) => {
    timer = setTimeout(() => res({ name: cfg.name, error: `no answer in ${timeoutMs / 1000}s` }), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).split("\n")[0];
    return { name: cfg.name, error: /401|403|unauthori[sz]ed/i.test(msg) ? "needs sign-in (not measured)" : msg.slice(0, 100) };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}
