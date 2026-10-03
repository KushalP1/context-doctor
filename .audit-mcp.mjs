import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "audit", version: "0" });
await c.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/mcp.js"] }));
const call = async (label, name, args) => {
  try {
    const r = await c.callTool({ name, arguments: args });
    const t = (r.content ?? []).map((x) => x.text ?? "").join(" ").replace(/\s+/g, " ");
    console.log(`${label.padEnd(40)} ${r.isError ? "isError" : "ok     "} ${t.slice(0, 110)}`);
  } catch (e) { console.log(`${label.padEnd(40)} THREW   ${e.message.slice(0, 110)}`); }
};
await call("profile: empty string", "profile_context", { conversation: "" });
await call("profile: broken JSON", "profile_context", { conversation: "{\"messages\": [" });
await call("profile: no args", "profile_context", {});
await call("profile: both inputs", "profile_context", { conversation: "hi", sketch: { turns: 2, blocks: [] } });
await call("sketch: zero turns, no blocks", "profile_context", { sketch: { turns: 0, blocks: [] } });
await call("sketch: absurd sizes", "profile_context", { sketch: { turns: 1e9, blocks: [{ turn: 1, kind: "paste", label: "x", approx_tokens: 1e15 }] } });
await call("sketch: negative turns", "profile_context", { sketch: { turns: -5, blocks: [] } });
await call("sketch: unknown model", "profile_context", { sketch: { turns: 40, model: "mystery-9", blocks: [] } });
await call("optimize: not JSON", "optimize_context", { conversation: "just text" });
await call("optimize: no messages", "optimize_context", { conversation: "{}" });
await call("optimize: bad strategy", "optimize_context", { conversation: "[]", strategies: ["nope"] });
await call("optimize: keep_recent 0", "optimize_context", { conversation: JSON.stringify([{ role: "user", content: "x" }]), keep_recent: 0 });
await call("best practices: bad provider", "context_best_practices", { provider: "llama" });
await call("best practices: openai", "context_best_practices", { provider: "openai" });
const pr = await c.getPrompt({ name: "context_checkup" }); console.log("prompt context_checkup".padEnd(40), "ok     ", pr.messages[0].content.text.slice(0, 90));
await c.close();
