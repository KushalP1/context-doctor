// End-to-end MCP check, the way a client connects: handshake, instructions,
// tools and prompt listed, every tool called with realistic input, malformed
// input rejected. Run it against whatever a client is configured to launch.
//
//   node scripts/smoke-mcp.mjs node dist/mcp.js
//   node scripts/smoke-mcp.mjs npx -y context-doctor mcp
//   node scripts/smoke-mcp.mjs --http http://127.0.0.1:8808/mcp
//
// Exits 1 on the first failed check. Calls write to the ledger of whatever
// HOME the server runs with, so point HOME at a throwaway directory.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: smoke-mcp.mjs <command> [args...] | --http <url>");
  process.exit(2);
}
const transport =
  args[0] === "--http"
    ? new StreamableHTTPClientTransport(new URL(args[1]))
    : new StdioClientTransport({ command: args[0], args: args.slice(1), env: process.env, stderr: "pipe" });

let failed = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
};
const text = (r) => (r.content ?? []).map((c) => c.text ?? "").join("\n");

const conversation = JSON.stringify({
  model: "claude-sonnet-5",
  messages: [
    { role: "user", content: "Read the config and fix the port." },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "nginx.conf" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "server { listen 80; }\n".repeat(400) }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "read_file", input: { path: "nginx.conf" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "server { listen 80; }\n".repeat(400) }] },
    { role: "assistant", content: "The port is 80; changing it to 8080." },
    { role: "user", content: "Thanks." },
  ],
});

const client = new Client({ name: "context-doctor-smoke", version: "1.0.0" });
const started = Date.now();
await client.connect(transport);
check(true, "handshake", `${Date.now() - started} ms`);

const info = client.getServerVersion();
check(info?.name === "context-doctor", "server name", `${info?.name} ${info?.version}`);
const instructions = client.getInstructions() ?? "";
check(/Context hygiene rules/.test(instructions), "instructions delivered", `${instructions.length} chars`);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
check(["context_best_practices", "optimize_context", "profile_context"].every((n) => names.includes(n)), "tools listed", names.join(", "));
const { prompts } = await client.listPrompts();
check(prompts.some((p) => p.name === "context_checkup"), "prompt listed", prompts.map((p) => p.name).join(", "));
const prompt = await client.getPrompt({ name: "context_checkup", arguments: {} });
check(prompt.messages.length > 0, "prompt renders");

const sketch = await client.callTool({
  name: "profile_context",
  arguments: { sketch: { turns: 42, model: "claude-sonnet-5", blocks: [{ turn: 3, kind: "paste", label: "the server log", approx_lines: 4000 }, { turn: 9, kind: "paste", label: "the server log again", approx_lines: 4000, repeated: 2 }] } },
});
check(!sketch.isError && /tokens?/i.test(text(sketch)), "profile_context (sketch, chat apps)", text(sketch).split("\n")[0]);

const profile = await client.callTool({ name: "profile_context", arguments: { conversation } });
check(!profile.isError && /dup|repeat/i.test(text(profile)), "profile_context (conversation) finds the duplicate read", text(profile).split("\n")[0]);

const optimized = await client.callTool({ name: "optimize_context", arguments: { conversation, keep_recent: 2 } });
const opt = text(optimized);
check(!optimized.isError && /saved|→|->/i.test(opt), "optimize_context", opt.split("\n").find((l) => /saved|→/i.test(l)) ?? opt.slice(0, 80));

for (const provider of ["general", "anthropic", "openai"]) {
  const tips = await client.callTool({ name: "context_best_practices", arguments: { provider } });
  check(!tips.isError && text(tips).length > 100, `context_best_practices (${provider})`);
}

// Malformed input must come back as a clear error, not a crash or a confident report.
const bad = await client.callTool({ name: "profile_context", arguments: { sketch: { turns: -1 } } }).catch((e) => ({ isError: true, content: [{ text: String(e.message ?? e) }] }));
check(bad.isError === true, "malformed sketch rejected", text(bad).replace(/\s+/g, " ").slice(0, 70));
const neither = await client.callTool({ name: "profile_context", arguments: {} }).catch((e) => ({ isError: true, content: [{ text: String(e.message ?? e) }] }));
check(neither.isError === true || /sketch|conversation/i.test(text(neither)), "no input explained", text(neither).replace(/\s+/g, " ").slice(0, 70));

await client.close();
console.log(failed === 0 ? "all checks passed" : `${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
