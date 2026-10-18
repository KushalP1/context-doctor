// Live check of Codex through autopilot, on an API key, with no key and no
// network: the real Codex binary (found on PATH, in the ChatGPT app or in an
// editor extension; skipped when there is none) runs `codex exec` against the
// proxy, which forwards to a local mock of OpenAI's Responses API. External
// traffic is sent to a dead HTTPS proxy, so nothing leaves the machine.
// Checks: config.toml's openai_base_url routes Codex (OPENAI_BASE_URL does
// not), its WebSocket attempt gets 426 and it falls back to HTTP at once, the
// answer comes back, and /stats counts the request and its usage.
//   node scripts/smoke-codex.mjs [path/to/codex]      (after npm run build)
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
function findCodex() {
  if (process.argv[2]) return process.argv[2];
  try { return execFileSync(process.platform === "win32" ? "where" : "which", ["codex"], { encoding: "utf8" }).split("\n")[0].trim() || undefined; } catch { /* not on PATH */ }
  const candidates = ["/Applications/ChatGPT.app/Contents/Resources/codex"];
  for (const ext of [join(homedir(), ".cursor", "extensions"), join(homedir(), ".vscode", "extensions")]) {
    try { for (const d of readdirSync(ext)) if (d.startsWith("openai.chatgpt-")) candidates.push(join(ext, d, "bin", "macos-aarch64", "codex"), join(ext, d, "bin", "linux-x86_64", "codex")); } catch { /* no extensions */ }
  }
  return candidates.find((c) => existsSync(c));
}
const codexBin = findCodex();
if (!codexBin) { console.log("- no codex binary found: skipped"); process.exit(0); }
const { startProxy } = await import(new URL("../dist/proxy.js", import.meta.url).href);
const sse = (res, events) => { res.writeHead(200, { "content-type": "text/event-stream" }); for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); res.end(); };
const up = createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
  const out = [{ type: "message", role: "assistant", id: "msg_1", status: "completed", content: [{ type: "output_text", text: "hi from the mock", annotations: [] }] }];
  sse(res, [
    { type: "response.created", sequence_number: 0, response: { id: "resp_1", object: "response", status: "in_progress", output: [] } },
    { type: "response.output_item.done", sequence_number: 1, output_index: 0, item: out[0] },
    { type: "response.completed", sequence_number: 2, response: { id: "resp_1", object: "response", status: "completed", output: out, usage: { input_tokens: 4000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 4005 } } },
  ]);
}); });
await new Promise((r) => up.listen(0, "127.0.0.1", r));
const home = mkdtempSync(join(tmpdir(), "cd-codex-inproc-"));
const px = startProxy({ port: 0, autopilot: true, autopilotStatePath: join(home, "ap.json"), openaiUpstream: `http://127.0.0.1:${up.address().port}` });
await new Promise((r) => px.once("listening", r));
const port = px.address().port;
const codexHome = join(home, ".codex"); mkdirSync(codexHome);
writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-local-test-not-a-key" }));
const run = (extraEnv, toml) => {
  writeFileSync(join(codexHome, "config.toml"), toml);
  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome, HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost", ...extraEnv };
  const child = spawn(codexBin, ["exec", "--skip-git-repo-check", "-s", "read-only", "say hi"], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
  return Promise.race([new Promise((r) => child.on("exit", (code) => r({ code, out, err }))), new Promise((r) => setTimeout(() => { child.kill(); r({ code: "timeout", out, err }); }, 25000))]);
};
let fail = 0; const check = (ok, l, d = "") => { console.log(`${ok ? "✓" : "✗"} ${l}${d ? ": " + d : ""}`); if (!ok) fail++; };
const version = execFileSync(codexBin, ["--version"], { encoding: "utf8" }).trim();
console.log(`${version} (${codexBin})`);
const base = `http://127.0.0.1:${port}/v1`;
const viaEnv = await run({ OPENAI_BASE_URL: base }, `model = "gpt-5.5"\n`);
let stats = await fetch(`http://127.0.0.1:${port}/stats`).then((x) => x.json());
check(stats.requests === 0, "OPENAI_BASE_URL alone does not route Codex", `${stats.requests} requests reached the proxy`);
const viaConfig = await run({}, `openai_base_url = "${base}"\nmodel = "gpt-5.5"\n`);
stats = await fetch(`http://127.0.0.1:${port}/stats`).then((x) => x.json());
check(viaConfig.code === 0 && /hi from the mock/.test(viaConfig.out), "openai_base_url routes Codex through the proxy and the answer comes back", `exit ${viaConfig.code}`);
check(/426 Upgrade Required/.test(viaConfig.err) && !/Reconnecting\.\.\. 2\/5/.test(viaConfig.err), "its WebSocket attempt gets 426 and it falls back to HTTP without retrying");
check(stats.requests === 1 && stats.upstreamInputTokens === 4000, "/stats counts the request and its usage", `${stats.requests} requests, ${stats.upstreamInputTokens} input tokens`);
check(stats.autopilot?.requests === 1, "autopilot saw it");
void viaEnv;
px.close(); up.close();
console.log(fail ? `${fail} check(s) failed` : "all Codex checks passed");
process.exit(fail ? 1 : 0);
