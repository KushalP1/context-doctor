// End-to-end check of the proxy on Google's Gemini API, against a local mock
// (no key, no network): the key header and query string forwarded, the model
// list passed through, streamGenerateContent streamed incrementally, usage
// read from usageMetadata, and autopilot clearing stale functionResponse parts
// on a cold request while keeping the recent ones and every functionCall.
//   HOME=$(mktemp -d) node scripts/smoke-gemini-proxy.mjs    (from the repo root, after npm run build)
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const seen = [];
const up = createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    seen.push({ url: req.url, key: req.headers["x-goog-api-key"], body: b ? JSON.parse(b) : null });
    if (req.method === "GET" && req.url.startsWith("/v1beta/models")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ models: [{ name: "models/gemini-3-pro" }] })); }
    if (req.url.includes(":streamGenerateContent")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }] })}\n\n`);
      setTimeout(() => { res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "lo" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 41000, candidatesTokenCount: 2, cachedContentTokenCount: 30000 } })}\n\n`); res.end(); }, 300);
      return;
    }
    if (req.url.includes(":generateContent")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 1 } })); }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => up.listen(0, "127.0.0.1", r));
const freePort = await new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const proxy = spawn(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "proxy", "--autopilot", "--port", String(freePort), "--upstream-google", `http://127.0.0.1:${up.address().port}`], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
await new Promise((r) => proxy.stderr.on("data", (d) => /listening/.test(String(d)) && r()));
const base = `http://127.0.0.1:${freePort}`;
const H = { "content-type": "application/json", "x-goog-api-key": "AIza-test-not-real" };
let fail = 0; const check = (ok, l, d = "") => { console.log(`${ok ? "✓" : "✗"} ${l}${d ? ": " + d : ""}`); if (!ok) fail++; };

const models = await (await fetch(`${base}/v1beta/models`, { headers: H })).json();
check(models.models?.[0]?.name === "models/gemini-3-pro", "GET /v1beta/models passes through to Google");
check(seen.at(-1).key === "AIza-test-not-real", "x-goog-api-key forwarded untouched");

// A Gemini CLI-shaped history: 8 shell runs, each a functionCall then its functionResponse.
const big = "build output the agent already acted on\n".repeat(3000);
const contents = [{ role: "user", parts: [{ text: "fix the build" }] }];
for (let i = 0; i < 8; i++) {
  contents.push({ role: "model", parts: [{ functionCall: { name: "run_shell_command", args: { command: `make step${i}` } } }] });
  contents.push({ role: "user", parts: [{ functionResponse: { name: "run_shell_command", response: { output: big } } }] });
}
contents.push({ role: "user", parts: [{ text: "now summarize" }] });
const t0 = Date.now();
const r = await fetch(`${base}/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse`, { method: "POST", headers: H, body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: "You are an agent." }] } }) });
const reader = r.body.getReader(); const dec = new TextDecoder(); let first, text = "";
for (;;) { const { done, value } = await reader.read(); if (done) break; first ??= Date.now() - t0; text += dec.decode(value); }
check(first < 250 && text.includes("finishReason"), "streamGenerateContent arrives incrementally", `first bytes after ${first} ms, whole after ${Date.now() - t0} ms`);
check(seen.at(-1).url === "/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse", "path and query string forwarded");
const sent = seen.at(-1).body.contents.flatMap((c) => c.parts).filter((p) => p.functionResponse);
const cleared = sent.filter((p) => JSON.stringify(p.functionResponse.response).length < big.length).length;
check(cleared > 0 && sent.at(-1).functionResponse.response.output === big, "cold first request: stale functionResponse cleared, the recent ones kept", `${cleared} of ${sent.length} cleared`);
check(seen.at(-1).body.contents.flatMap((c) => c.parts).filter((p) => p.functionCall).length === 8, "every functionCall kept (calls and responses stay paired)");

await fetch(`${base}/v1/models/gemini-3-flash:generateContent`, { method: "POST", headers: H, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }) });
check(seen.at(-1).url.startsWith("/v1/models/gemini-3-flash:generateContent"), "a /v1/models/<m>:generateContent path goes to Google, not OpenAI");

await new Promise((r) => setTimeout(r, 200));
const stats = await (await fetch(`${base}/stats`)).json();
check(stats.upstreamInputTokens >= 41000, "usage read from Gemini's usageMetadata", `upstream input ${stats.upstreamInputTokens}, autopilot cleared ${stats.autopilot.resultsCleared}`);
proxy.kill(); up.close();
console.log(fail ? `${fail} failed` : "all Gemini proxy checks passed"); process.exit(fail ? 1 : 0);
