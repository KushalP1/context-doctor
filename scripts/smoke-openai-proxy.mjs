// End-to-end check of the proxy on OpenAI's APIs, against a local mock of
// OpenAI (no key, no network): /v1/models passthrough, the Authorization
// header, incremental streaming of Chat Completions, the Responses API, usage
// captured from streams, and autopilot clearing stale tool output on a cold
// request while keeping the recent ones.
//   HOME=$(mktemp -d) node scripts/smoke-openai-proxy.mjs    (from the repo root, after npm run build)
import { createServer } from "node:http";
import { spawn } from "node:child_process";
const seen = [];
const up = createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    seen.push({ url: req.url, auth: req.headers.authorization, body: b ? JSON.parse(b) : null });
    if (req.url.startsWith("/v1/models")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "gpt-5.5" }] })); }
    const stream = b && JSON.parse(b).stream;
    if (req.url.startsWith("/v1/chat/completions")) {
      if (stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`);
        setTimeout(() => { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }], usage: { prompt_tokens: 1200, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1000 } } })}\n\ndata: [DONE]\n\n`); res.end(); }, 300);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 900, completion_tokens: 1 } }));
    }
    if (req.url.startsWith("/v1/responses")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}\n\n`);
      res.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 5000, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } } } })}\n\n`);
      return res.end();
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => up.listen(0, "127.0.0.1", r));
const upPort = up.address().port, port = 8829;
const proxy = spawn(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "proxy", "--autopilot", "--port", String(port), "--upstream-openai", `http://127.0.0.1:${upPort}`], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
await new Promise((r) => proxy.stderr.on("data", (d) => /listening/.test(String(d)) && r()));
const base = `http://127.0.0.1:${port}`;
const H = { "content-type": "application/json", authorization: "Bearer sk-test-not-real" };
let fail = 0; const check = (ok, l, d = "") => { console.log(`${ok ? "✓" : "✗"} ${l}${d ? ": " + d : ""}`); if (!ok) fail++; };

// 1. models passthrough
const models = await (await fetch(`${base}/v1/models`, { headers: H })).json();
check(models.data?.[0]?.id === "gpt-5.5", "GET /v1/models passes through");
check(seen.at(-1).auth === "Bearer sk-test-not-real", "Authorization header forwarded untouched");

// 2. streaming chat completions arrive incrementally
const big = "log line that the agent already acted on\n".repeat(3000);
const msgs = [{ role: "system", content: "You are an agent." }, { role: "user", content: "check the logs" }];
for (let i = 0; i < 8; i++) { msgs.push({ role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }] }); msgs.push({ role: "tool", tool_call_id: `c${i}`, content: big }); }
msgs.push({ role: "user", content: "summarize" });
const t0 = Date.now(); const r = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: H, body: JSON.stringify({ model: "gpt-5.5", stream: true, messages: msgs }) });
const reader = r.body.getReader(); const dec = new TextDecoder(); let first, text = "";
for (;;) { const { done, value } = await reader.read(); if (done) break; first ??= Date.now() - t0; text += dec.decode(value); }
check(first < 250 && text.includes("[DONE]"), "streamed chat completion arrives incrementally", `first bytes after ${first} ms, whole after ${Date.now() - t0} ms`);
const sent = seen.at(-1).body.messages.filter((m) => m.role === "tool");
const cleared = sent.filter((m) => m.content.length < big.length).length;
check(cleared > 0 && sent.at(-1).content === big, "cold first request: stale tool output cleared, the recent ones kept", `${cleared} of ${sent.length} cleared`);

// 3. Responses API (Codex with an API key)
const input = [{ role: "user", content: "go" }];
for (let i = 0; i < 6; i++) { input.push({ type: "function_call", call_id: `f${i}`, name: "shell", arguments: "{}" }); input.push({ type: "function_call_output", call_id: `f${i}`, output: big }); }
const rr = await fetch(`${base}/v1/responses`, { method: "POST", headers: H, body: JSON.stringify({ model: "gpt-5.5", stream: true, input }) });
const rtext = await rr.text();
check(rr.status === 200 && rtext.includes("response.completed"), "POST /v1/responses streams through");
const outs = seen.at(-1).body.input.filter((x) => x.type === "function_call_output");
check(outs.some((o) => o.output.length < big.length) && outs.at(-1).output === big, "Responses: stale function_call_output cleared, recent kept");

await new Promise((r) => setTimeout(r, 200));
const stats = await (await fetch(`${base}/stats`)).json();
check(stats.requests >= 2 && stats.upstreamInputTokens >= 1200, "usage captured from OpenAI streams", `requests ${stats.requests}, upstream input ${stats.upstreamInputTokens}, autopilot cleared ${stats.autopilot.resultsCleared}`);
proxy.kill(); up.close();
console.log(fail ? `${fail} failed` : "all OpenAI proxy checks passed"); process.exit(fail ? 1 : 0);
