#!/usr/bin/env node
// The plugin and its mod, live, on a real Claude Code, with no person and no
// network (ROADMAP E2). Claude Code ships about a version a day; the mod had
// never run in a live session, and the hooks were checked by hand on old
// versions. This runs one headless session of the given Claude Code with this
// repository as its plugin (`claude -p --plugin-dir <dir>`, stream-json both
// ways) against a local mock of the Messages API, in a throwaway HOME and
// CLAUDE_CONFIG_DIR, and checks what the plugin did:
//
//  - the plugin loads (init lists it; no plugin_errors) and its MCP server connects;
//  - its command hooks run and exit 0: SessionStart, UserPromptSubmit (which
//    speaks: the session passed a price threshold set low), PreToolUse on the
//    Agent tool (the mock asks for a subagent), PreModelSwitch (a set_model
//    control request; its message names the re-write's price) and PreCompact
//    (`/compact`: its instructions reach the compaction request the mock gets);
//  - the mod's `session.measure` fires under -p and `context-doctor mod measure`
//    writes the limits ledger (the 5-hour and weekly windows the mock's
//    anthropic-ratelimit-unified-* headers said) and the session-cost ledger
//    (Claude Code's cost of the session beside context-doctor's own price);
//  - `claude plugin validate --profile directory --strict` passes;
//  - every request the mock got carried the dummy credential, and nothing
//    tried to reach another host (HTTPS_PROXY points at the mock, which
//    refuses and records any CONNECT).
//
// It never reaches the real API: the child's environment is built from
// nothing (PATH and what is set here), ANTHROPIC_BASE_URL is the mock on
// 127.0.0.1, the only credential is a made-up token, and checkEnv refuses to
// start Claude Code otherwise. Claude Code reads the unified rate-limit
// headers only for a claude.ai sign-in or a Claude gateway token
// (extractQuotaStatusFromHeaders, read from the 2.1.323 binary), so the dummy
// credential is an unsigned token shaped like a gateway's (aud
// "claude-gateway"); with a plain API key `session.measure` gets no windows.
//
//   node scripts/canary.mjs [--claude <binary>] [--plugin-dir <dir>] [--verbose] [--keep]
//   node scripts/canary.mjs --plant <fault>    # a copy of the plugin with one fault: must go red
//   node scripts/canary.mjs --self-test        # green on the plugin as it is, red on every fault
//
// Exit 0 green, 1 red (each failed check is printed, and is an Actions
// annotation on CI), 2 when it could not run (no Claude Code, bad arguments).
// Without --claude: the newest Claude Code of the Desktop app on macOS, else
// `claude` on PATH.
import { createServer, get as httpGet } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The rate-limit windows the mock reports: utilization is a fraction; Claude Code hands the mod a percent. */
export const WINDOWS = { "5h": { utilization: 0.42, resetIn: 2 * 3600 }, "7d": { utilization: 0.17, resetIn: 3 * 86400 } };
/** The session price threshold the UserPromptSubmit hook must speak at: below the first turn's cost. */
export const PRICE_THRESHOLD = "0.05";
export const MAIN = "CANARY-MAIN";
export const SUB = "CANARY-SUB";
/** The PreCompact hook's instructions start with this (src/precompact.ts compactInstructions). */
export const PRECOMPACT_HEAD = "context-doctor, from this session's transcript";
const SESSION_TIMEOUT_MS = 180_000;
const IDLE_MS = 45_000;
/** The session's steps, in order; a run that stops early names the one it stopped at. */
const STEPS = ["the first prompt and its subagent", "the second prompt", "the model switch (set_model)", "/compact", "done"];

// -- The dummy credential --------------------------------------------------------

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** An unsigned JWT-shaped token: aud "claude-gateway" makes Claude Code read the rate-limit headers. No key of any kind. */
export function dummyToken(nowS = Math.floor(Date.now() / 1000)) {
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ aud: "claude-gateway", exp: nowS + 86400, session_id: "context-doctor-canary" })}.canary-not-a-key`;
}
const isDummy = (t) => typeof t === "string" && t.endsWith(".canary-not-a-key") && t.split(".").length === 3;

// -- The mock Messages API ----------------------------------------------------------

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (typeof c?.text === "string" ? c.text : typeof c?.content === "string" ? c.content : "")).join("\n");
}

/** What the mock answers to one request: a subagent call for the canary's first prompt, text otherwise. */
export function scriptedReply(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools.map((t) => t?.name) : [];
  // This turn's user messages: Claude Code sends the prompt and its reminders (or a tool result and a
  // background task's notice, 2.1.311) as more than one message.
  const lastReply = msgs.findLastIndex((m) => m?.role === "assistant");
  const since = msgs.slice(lastReply + 1);
  const turn = since.map((m) => textOf(m?.content)).join("\n");
  const answered = since.some((m) => Array.isArray(m?.content) && m.content.some((c) => c?.type === "tool_result" && c.tool_use_id === "toolu_canary_agent"));
  const all = msgs.map((m) => textOf(m?.content)).join("\n");
  const agent = tools.includes("Agent") ? "Agent" : tools.includes("Task") ? "Task" : undefined;
  if (answered) return [{ type: "text", text: "CANARY-DONE" }];
  // A compaction's request ("an <analysis> block followed by a <summary> block") is answered with text, never a tool call.
  const compaction = /<summary>/.test(turn);
  if (turn.includes(MAIN) && agent && !compaction && !all.includes(SUB)) {
    return [{ type: "tool_use", id: "toolu_canary_agent", name: agent, input: { description: "canary subagent", prompt: `${SUB}: reply with one word.`, subagent_type: "general-purpose" } }];
  }
  if (msgs.length && textOf(msgs[0]?.content).includes(SUB)) return [{ type: "text", text: "CANARY-SUB-OK" }];
  return [{ type: "text", text: "<summary>CANARY-OK</summary>" }];
}

export function rateLimitHeaders(nowS = Math.floor(Date.now() / 1000)) {
  const h = { "anthropic-ratelimit-unified-status": "allowed" };
  for (const [w, { utilization, resetIn }] of Object.entries(WINDOWS)) {
    h[`anthropic-ratelimit-unified-${w}-utilization`] = String(utilization);
    h[`anthropic-ratelimit-unified-${w}-reset`] = String(nowS + resetIn);
    h[`anthropic-ratelimit-unified-${w}-status`] = "allowed";
  }
  return h;
}

/**
 * The mock: POST /v1/messages (streamed or not) and count_tokens, the
 * rate-limit headers on each reply, GET /__canary (its nonce, for checkEnv).
 * Any other request, a proxied one or a CONNECT, is refused and recorded.
 */
export async function startMock() {
  const nonce = randomBytes(8).toString("hex");
  const requests = [];
  const refused = [];
  const usage = { input_tokens: 10, cache_creation_input_tokens: 20000, cache_read_input_tokens: 0, output_tokens: 40, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20000 } };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const path = req.url ?? "";
      if (req.method === "GET" && path === "/__canary") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ nonce })); }
      if (!path.startsWith("/")) { refused.push(`${req.method} ${path}`); res.writeHead(403); return res.end(); }
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* recorded as is */ }
      const auth = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const rec = { method: req.method, path, auth: isDummy(auth) ? "dummy" : auth ? "OTHER" : "none", apiKey: req.headers["x-api-key"] ? (isDummy(String(req.headers["x-api-key"])) ? "dummy" : "OTHER") : "none", model: body?.model, text: body ? JSON.stringify(body.messages ?? body).slice(-200_000) : "" };
      requests.push(rec);
      if (req.method !== "POST" || !path.startsWith("/v1/messages")) { refused.push(`${req.method} ${path}`); res.writeHead(404, { "content-type": "application/json" }); return res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "context-doctor canary mock" } })); }
      if (path.startsWith("/v1/messages/count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ input_tokens: 1000 })); }
      const content = scriptedReply(body);
      const stop = content.some((c) => c.type === "tool_use") ? "tool_use" : "end_turn";
      const msg = { id: `msg_canary_${requests.length}`, type: "message", role: "assistant", model: body?.model ?? "claude-sonnet-5-5", content, stop_reason: stop, stop_sequence: null, usage };
      const headers = { ...rateLimitHeaders(), "request-id": `req_canary_${requests.length}` };
      if (!body?.stream) { res.writeHead(200, { "content-type": "application/json", ...headers }); return res.end(JSON.stringify(msg)); }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...headers });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev("message_start", { message: { ...msg, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } });
      content.forEach((c, index) => {
        if (c.type === "text") {
          ev("content_block_start", { index, content_block: { type: "text", text: "" } });
          ev("content_block_delta", { index, delta: { type: "text_delta", text: c.text } });
        } else {
          ev("content_block_start", { index, content_block: { type: "tool_use", id: c.id, name: c.name, input: {} } });
          ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(c.input) } });
        }
        ev("content_block_stop", { index });
      });
      ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
      ev("message_stop", {});
      res.end();
    });
  });
  // HTTPS_PROXY points here: a CONNECT is an attempt to reach some other host. Refused, and named in the report.
  server.on("connect", (req, socket) => { refused.push(`CONNECT ${req.url}`); socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, nonce, requests, refused, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

// -- The child's environment, and the guard -------------------------------------------

/** Everything Claude Code gets: PATH (for `node`, which the hooks run) and what is set here. Nothing else of the caller's. */
export function claudeEnv({ root, mockUrl, token }) {
  const home = join(root, "home");
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    TMPDIR: join(root, "tmp"),
    ANTHROPIC_BASE_URL: mockUrl,
    ANTHROPIC_AUTH_TOKEN: token,
    // Any other host goes through the mock, which refuses it.
    HTTPS_PROXY: mockUrl,
    HTTP_PROXY: mockUrl,
    https_proxy: mockUrl,
    http_proxy: mockUrl,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CONTEXT_DOCTOR_SESSION_PRICE: PRICE_THRESHOLD,
    CONTEXT_DOCTOR_NO_CALIBRATION: "1",
  };
  for (const d of [env.CLAUDE_CONFIG_DIR, env.TMPDIR]) mkdirSync(d, { recursive: true });
  return env;
}

const inside = (child, parent) => { const r = relative(parent, child); return r === "" || (!!r && !r.startsWith("..") && !isAbsolute(r)); };
/** The real path, for a path not made yet too (its nearest existing parent's, then the rest): /var is /private/var on macOS. */
const real = (p) => {
  const abs = resolve(p);
  try { return realpathSync(abs); } catch { /* below */ }
  const up = dirname(abs);
  return up === abs ? abs : join(real(up), abs.slice(up.length + (up.endsWith(sep) ? 0 : 1)));
};

/** Why this environment must not start Claude Code; empty when it may. Checked before every run. */
export function checkEnv(env, { mockUrl, root }) {
  const problems = [];
  let base;
  try { base = new URL(env.ANTHROPIC_BASE_URL ?? ""); } catch { /* below */ }
  if (!base || base.protocol !== "http:" || base.hostname !== "127.0.0.1" || env.ANTHROPIC_BASE_URL !== mockUrl) problems.push(`ANTHROPIC_BASE_URL is ${env.ANTHROPIC_BASE_URL ?? "unset"}, not the local mock ${mockUrl}`);
  if (!isDummy(env.ANTHROPIC_AUTH_TOKEN)) problems.push("ANTHROPIC_AUTH_TOKEN is not the canary's dummy token");
  for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_UNIX_SOCKET", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL", "AWS_BEARER_TOKEN_BEDROCK"]) {
    if (env[k] !== undefined) problems.push(`${k} is set`);
  }
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY"]) if (env[k] !== mockUrl) problems.push(`${k} is not the mock (other hosts would be reachable)`);
  const realHome = real(homedir());
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "TMPDIR"]) {
    const v = env[k];
    if (!v || !inside(real(v), real(root))) problems.push(`${k} (${v ?? "unset"}) is not inside the throwaway folder ${root}`);
    else if (inside(real(v), realHome) || inside(realHome, real(v))) problems.push(`${k} (${v}) overlaps the real home ${realHome}`);
  }
  return problems;
}

/** checkEnv, and the mock answering at that URL with its own nonce: nothing else is listening there. */
async function assertSafe(env, mock, root) {
  const problems = checkEnv(env, { mockUrl: mock.url, root });
  try {
    // A fresh connection each time (no agent): the spawnSync calls between checks block this process, the mock
    // with it, past its keep-alive, so fetch's pooled socket was closed under it ("fetch failed").
    const body = await new Promise((ok, fail) => {
      const req = httpGet(`${mock.url}/__canary`, { agent: false, timeout: 10_000 }, (res) => {
        let t = "";
        res.on("data", (d) => (t += d));
        res.on("end", () => ok(t));
      });
      req.on("timeout", () => req.destroy(new Error("timed out")));
      req.on("error", fail);
    });
    if (JSON.parse(body).nonce !== mock.nonce) problems.push("the server at ANTHROPIC_BASE_URL is not this run's mock");
  } catch (e) {
    problems.push(`the mock does not answer: ${e.message}`);
  }
  if (problems.length) throw new Error(`refusing to start Claude Code: ${problems.join("; ")}`);
}

// -- Running Claude Code ------------------------------------------------------------------

/** The newest Claude Code here: the Desktop app's (macOS), else `claude` on PATH. */
export function findClaude() {
  const base = join(homedir(), "Library", "Application Support", "Claude", "claude-code");
  if (platform() === "darwin" && existsSync(base)) {
    const cmp = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0; };
    for (const v of readdirSync(base).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp).reverse()) {
      for (const b of readdirSync(join(base, v))) {
        const p = join(base, v, b, "claude.app", "Contents", "MacOS", "claude");
        if (existsSync(p)) return p;
      }
    }
  }
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    for (const n of platform() === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"]) if (d && existsSync(join(d, n))) return join(d, n);
  }
  return undefined;
}

/**
 * One session, stream-json both ways: the first prompt (the mock asks for a
 * subagent), a second prompt (past the price threshold), a model switch, then
 * /compact. Each step waits for the one before it to finish: the first for
 * the subagent's answer (2.1.323 runs it in the background and ends a turn
 * before it is back), the last for the result after the compaction.
 */
async function runSession({ claude, pluginDir, env, cwd, debugFile, log }) {
  const argv = ["-p", "--plugin-dir", pluginDir, "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-hook-events", "--debug-file", debugFile];
  const child = spawn(claude, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const events = [];
  let stderr = "", buf = "", stage = 0, subagent = false, compacted = false;
  const send = (o) => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(o) + "\n"); };
  const user = (text) => send({ type: "user", message: { role: "user", content: text } });
  child.stdin.on("error", () => { /* it exited: evaluated below */ });
  child.stderr.on("data", (d) => (stderr += d));
  child.stdout.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0;) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { log(`non-JSON line: ${line.slice(0, 200)}`); continue; }
      events.push(e);
      log(`event ${e.type}${e.subtype ? "/" + e.subtype : ""}${e.hook_event ? " " + e.hook_event : ""}${e.type === "result" ? ` ${JSON.stringify(String(e.result ?? "").slice(0, 80))} turns ${e.num_turns}` : ""}${e.type === "user" || e.type === "assistant" ? " " + JSON.stringify(e.message?.content).slice(0, 100) : ""}`);
      if (e.type === "system" && e.subtype === "task_started") subagent = true;
      if (e.type === "system" && e.subtype === "compact_boundary") compacted = true;
      if (e.type === "result") {
        // A subagent started: on to the next step once its answer came back (the mock's CANARY-DONE).
        if (stage === 0 && (!subagent || String(e.result ?? "").includes("CANARY-DONE"))) { stage = 1; user("CANARY-SECOND: one more line."); }
        else if (stage === 1) { stage = 2; send({ type: "control_request", request_id: "canary-set-model", request: { subtype: "set_model", model: "claude-haiku-4-5" } }); }
        else if (stage === 3 && compacted) { stage = 4; child.stdin.end(); }
      }
      if (stage === 2 && e.type === "control_response" && e.response?.request_id === "canary-set-model") { stage = 3; user("/compact"); }
    }
  });
  // A step Claude Code never answers (an older one ignores set_model) must not hold the run to the end: close its input.
  let idle;
  const quiet = () => {
    clearTimeout(idle);
    idle = setTimeout(() => { stderr += `\n(canary: nothing from Claude Code for ${IDLE_MS / 1000} s at step ${STEPS[stage]}; its input closed)`; child.stdin.end(); }, IDLE_MS);
  };
  child.stdout.on("data", quiet);
  quiet();
  user(`${MAIN}: always keep this canary note. Run one subagent.`);
  let timer;
  const code = await new Promise((r) => {
    child.on("error", (e) => { stderr += String(e); r(-1); });
    child.on("exit", (c, s) => r(c ?? s));
    timer = setTimeout(() => { stderr += `\n(canary: killed after ${SESSION_TIMEOUT_MS / 1000} s)`; child.kill("SIGKILL"); }, SESSION_TIMEOUT_MS);
  });
  clearTimeout(timer);
  clearTimeout(idle);
  return { code, events, stderr, steps: STEPS.slice(0, stage) };
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

// -- What must hold --------------------------------------------------------------------------

/**
 * The checks on one run. `soft` ones are printed but never turn it red.
 * Pure: everything it reads is passed in, so tests can feed it a run.
 */
export function evaluate({ run, mock, ledgers, validate, pluginDir }) {
  const checks = [];
  const check = (ok, name, detail = "", soft = false) => checks.push({ ok: !!ok, name, detail, soft });
  const ev = run.events;
  const init = ev.find((e) => e.type === "system" && e.subtype === "init");
  const sid = init?.session_id;
  const results = ev.filter((e) => e.type === "result");
  check(run.code === 0, "Claude Code exits 0", `exit ${run.code}${run.stderr.trim() ? ": " + run.stderr.trim().split("\n").slice(-3).join(" | ") : ""}`);
  if (run.steps) check(run.steps.length === STEPS.length - 1, "the session runs every step: a prompt with a subagent, a second prompt, a model switch, /compact", run.steps.length === STEPS.length - 1 ? "" : `stopped at ${STEPS[run.steps.length]}`);
  check(results.length >= 3 && results.every((r) => !r.is_error), "every turn ends without an error", `${results.length} results${results.filter((r) => r.is_error).map((r) => ": " + (r.result ?? r.subtype)).join("")}`);
  const plugin = init?.plugins?.find((p) => p.name === "context-doctor");
  check(plugin && real(plugin.path) === real(pluginDir), "the plugin loads (init lists context-doctor from --plugin-dir)", plugin ? `${plugin.source} ${plugin.version ?? ""}` : `plugins: ${(init?.plugins ?? []).map((p) => p.name).join(", ") || "none"}`);
  const errors = [...(init?.plugin_errors ?? [])].filter((e) => e.plugin === "context-doctor" || !e.plugin);
  check(!errors.length, "no plugin_errors for context-doctor", errors.map((e) => `${e.type}: ${e.message}`).join("; "));
  const warnings = (init?.plugin_warnings ?? []).filter((e) => e.plugin === "context-doctor" || !e.plugin);
  if (warnings.length) check(false, "no plugin_warnings for context-doctor", warnings.map((e) => `${e.type}: ${e.message}`).join("; "), true);
  const mcp = init?.mcp_servers?.find((s) => /context-doctor/.test(s.name));
  check(mcp?.status === "connected", "its MCP server connects", mcp ? `${mcp.name}: ${mcp.status}` : "not listed");

  const responses = ev.filter((e) => e.type === "system" && e.subtype === "hook_response");
  const hook = (event) => responses.filter((e) => e.hook_event === event);
  for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PreModelSwitch"]) {
    const rs = hook(event);
    const bad = rs.filter((r) => r.exit_code !== 0 || r.outcome !== "success");
    check(rs.length > 0 && !bad.length, `the ${event} hook runs and exits 0`, rs.length ? bad.map((r) => `${r.hook_name}: exit ${r.exit_code}, ${r.outcome}${r.stderr ? ", " + r.stderr.trim().slice(0, 200) : ""}`).join("; ") || `${rs.length} run(s)` : "never ran");
  }
  const said = (rs) => rs.map((r) => { try { return JSON.parse(r.stdout || "{}").systemMessage ?? ""; } catch { return ""; } }).join(" ");
  check(/(^|\s)context-doctor: this session has cost \$/.test(said(hook("UserPromptSubmit"))), `the UserPromptSubmit hook speaks once the session passes $${PRICE_THRESHOLD}`, said(hook("UserPromptSubmit")).slice(0, 200) || "said nothing");
  check(/^context-doctor: switching to claude-haiku-4-5 re-writes/.test(said(hook("PreModelSwitch"))), "the PreModelSwitch hook prices the re-write", said(hook("PreModelSwitch")).slice(0, 200) || "said nothing");
  const compaction = mock.requests.find((r) => r.text.includes(PRECOMPACT_HEAD));
  check(compaction, "the PreCompact hook's instructions reach the compaction request", compaction ? "" : `no request held "${PRECOMPACT_HEAD}"`);
  check(ledgers.main.some((l) => l.ev === "precompact"), "the PreCompact hook records itself in the ledger");
  check(mock.requests.some((r) => r.text.includes(SUB)), "the subagent ran (the mock got its request)");

  // The mod: session.measure → `context-doctor mod measure` → the two ledgers.
  const now = Math.floor(Date.now() / 1000);
  for (const [w, kind] of [["5h", "five_hour"], ["7d", "seven_day"]]) {
    const want = WINDOWS[w];
    const row = ledgers.limits.find((l) => l.app === "claude" && l.w === kind);
    check(row && row.pct === Math.round(want.utilization * 100) && Math.abs(row.reset - (now + want.resetIn)) < SESSION_TIMEOUT_MS / 1000 + 60, `the mod writes the ${kind} reading to the limits ledger`, row ? JSON.stringify(row) : "no row");
  }
  const costs = ledgers.cost.filter((l) => l.sid === sid && typeof l.cc === "number");
  const finalCost = results.at(-1)?.total_cost_usd;
  const near = costs.find((l) => results.some((r) => typeof r.total_cost_usd === "number" && Math.abs(l.cc - r.total_cost_usd) < 0.001));
  check(near && near.cc > 0, "the mod writes Claude Code's cost of the session to the cost ledger", costs.length ? `${costs.map((l) => `cc $${l.cc} cd $${l.cd ?? "?"}`).join(", ")}; Claude Code's results: ${results.map((r) => "$" + r.total_cost_usd).join(", ")}` : "no row for this session");
  const priced = costs.find((l) => typeof l.cd === "number" && l.cd > 0);
  check(priced, "beside it, context-doctor's own price of the session", priced ? `$${priced.cd}` : "no cd");
  if (priced) check(Math.abs(priced.cd - priced.cc) <= 0.02 * priced.cc, "context-doctor's price within 2% of Claude Code's", `$${priced.cd} against $${priced.cc} (${priced.model ?? "?"})`, true);
  check(validate.code === 0, "claude plugin validate --profile directory --strict passes", validate.code === 0 ? "" : validate.out.trim().split("\n").filter((l) => /✘|error|warning|⚠/i.test(l)).slice(0, 6).join(" | ") || `exit ${validate.code}`);

  // Safety: the dummy credential only, and nowhere else.
  const other = mock.requests.filter((r) => r.auth === "OTHER" || r.apiKey === "OTHER");
  check(mock.requests.length > 0 && !other.length, "every request the mock got carried the dummy credential", other.length ? `${other.length} carried another` : `${mock.requests.length} requests`);
  const anthropic = mock.refused.filter((r) => /anthropic\.com|claude\.ai|claude\.com/.test(r));
  check(!anthropic.length, "nothing tried to reach Anthropic's hosts", anthropic.join(", "));
  if (mock.refused.length > anthropic.length) check(false, "nothing tried to reach another host (refused by the mock)", mock.refused.filter((r) => !anthropic.includes(r)).join(", "), true);
  return { sid, checks, cost: finalCost };
}

// -- One canary run ----------------------------------------------------------------------------

function validatePlugin(claude, env, pluginDir) {
  const help = spawnSync(claude, ["plugin", "validate", "--help"], { env, encoding: "utf8", timeout: 60_000 });
  const args = /--profile/.test(help.stdout + help.stderr) ? ["plugin", "validate", "--profile", "directory", "--strict", pluginDir] : ["plugin", "validate", "--strict", pluginDir];
  const r = spawnSync(claude, args, { env, encoding: "utf8", timeout: 120_000 });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? ""), args };
}

export async function canary({ claude, pluginDir = REPO, verbose = false, keep = false }) {
  const root = mkdtempSync(join(tmpdir(), "cd-canary-"));
  const mock = await startMock();
  const log = verbose ? (s) => console.log(`  · ${s}`) : () => {};
  try {
    const env = claudeEnv({ root, mockUrl: mock.url, token: dummyToken() });
    const cwd = join(root, "project");
    mkdirSync(cwd, { recursive: true });
    await assertSafe(env, mock, root);
    const version = (spawnSync(claude, ["--version"], { env, encoding: "utf8", timeout: 60_000 }).stdout ?? "").trim();
    await assertSafe(env, mock, root);
    const validate = validatePlugin(claude, env, pluginDir);
    await assertSafe(env, mock, root);
    const run = await runSession({ claude, pluginDir, env, cwd, debugFile: join(root, "debug.log"), log });
    const state = env.CLAUDE_CONFIG_DIR;
    const ledgers = {
      limits: readJsonl(join(state, ".context-doctor-limits.jsonl")),
      cost: readJsonl(join(state, ".context-doctor-session-cost.jsonl")),
      main: readJsonl(join(state, ".context-doctor-ledger.jsonl")),
    };
    const out = evaluate({ run, mock, ledgers, validate, pluginDir });
    // Whether the mod's session.measure ran, in Claude Code's own words (its debug log): the diagnosis when the ledgers are empty.
    let debug = "";
    try { debug = readFileSync(join(root, "debug.log"), "utf8"); } catch { /* none */ }
    const modLoaded = /hooks module context-doctor@\S+ loaded/.test(debug);
    const measured = /hooks module context-doctor@\S+ session\.measure settled/.test(debug);
    out.checks.push({ ok: modLoaded, name: "Claude Code's debug log: the mod loaded", detail: modLoaded ? "" : (debug.match(/.*hooks module context-doctor.*/g) ?? []).slice(0, 3).join(" | ") || "no line about it", soft: true });
    out.checks.push({ ok: measured, name: "Claude Code's debug log: session.measure reached the mod", detail: "", soft: true });
    return { version, root, ...out, ok: out.checks.every((c) => c.ok || c.soft) };
  } finally {
    await mock.close();
    if (!keep) rmSync(root, { recursive: true, force: true });
  }
}

// -- Planted faults: each must turn the canary red --------------------------------------------------

/** The plugin's own files, copied: a fault is planted in the copy, never in the repository. */
export function copyPlugin(src) {
  const dst = mkdtempSync(join(tmpdir(), "cd-canary-plugin-"));
  // assets/icon.png: without it the directory profile warns (ICON_MISSING) and --strict fails every copy alike.
  for (const p of [".claude-plugin", "hooks", "plugin", "skills", join("assets", "icon.png"), "README.md", "LICENSE", "package.json"]) if (existsSync(join(src, p))) cpSync(join(src, p), join(dst, p), { recursive: true });
  cpSync(join(src, "dist"), join(dst, "dist"), { recursive: true, filter: (f) => relative(join(src, "dist"), f).split(sep)[0] !== "test" });
  return dst;
}

const edit = (file, fn) => writeFileSync(file, fn(readFileSync(file, "utf8")));
export const FAULTS = {
  "hooks-json": { what: "hooks/hooks.json is not valid JSON", plant: (d) => edit(join(d, "hooks", "hooks.json"), (s) => s.replace(/}\s*$/, "")) },
  "mod-throws": { what: "the mod throws when it loads", plant: (d) => edit(join(d, "dist", "mod", "register.js"), (s) => `${s}\nthrow new Error("planted by the canary");\n`) },
  "mod-event": { what: "the mod listens for a renamed event (session.measured)", plant: (d) => edit(join(d, "dist", "mod", "register.js"), (s) => s.replace(`on("session.measure"`, `on("session.measured"`)) },
  "hook-fails": { what: "the every-prompt hook exits 1", plant: (d) => edit(join(d, "dist", "cli.js"), (s) => s.replace(/^(#!.*\n)?/, (m) => `${m}if (process.argv[2] === "hook") { process.stderr.write("planted by the canary\\n"); process.exit(1); }\n`)) },
  "hook-bad-json": { what: "the hook prints invalid JSON", plant: (d) => edit(join(d, "dist", "cli.js"), (s) => s.replace(/^(#!.*\n)?/, (m) => `${m}if (process.argv[2] === "hook") { process.stdout.write("{\\"systemMessage\\": oops\\n"); process.exit(0); }\n`)) },
};

export function plant(fault, src = REPO) {
  const f = FAULTS[fault];
  if (!f) throw new Error(`no such fault: ${fault} (one of ${Object.keys(FAULTS).join(", ")})`);
  const dir = copyPlugin(src);
  f.plant(dir);
  return dir;
}

// -- The command line ----------------------------------------------------------------------------

/** `planted`: a self-test's fault run, meant to be red: its failed checks are no Actions annotations. */
function report(label, r, planted = false) {
  const gh = !!process.env.GITHUB_ACTIONS && !planted;
  console.log(`\n${label}: Claude Code ${r.version || "(version unknown)"}`);
  for (const c of r.checks) {
    console.log(`${c.ok ? "✓" : c.soft ? "⚠" : "✗"} ${c.name}${c.detail && (!c.ok || process.argv.includes("--verbose")) ? ": " + c.detail : ""}`);
    if (gh && !c.ok) console.log(`::${c.soft ? "warning" : "error"} title=canary (${label})::${c.name}${c.detail ? ": " + c.detail : ""}`.replace(/\r?\n/g, " "));
  }
  const failed = r.checks.filter((c) => !c.ok && !c.soft).length;
  console.log(failed ? `RED: ${failed} of ${r.checks.length} checks failed` : `GREEN: ${r.checks.filter((c) => c.ok).length} of ${r.checks.length} checks passed${r.checks.some((c) => !c.ok) ? " (warnings above)" : ""}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      const verdict = planted ? (failed ? "RED, as it must be" : "GREEN: the fault was NOT caught") : failed ? "RED" : "GREEN";
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${label}: Claude Code ${r.version} ${verdict}\n\n${r.checks.map((c) => `- ${c.ok ? "✅" : c.soft ? "⚠️" : "❌"} ${c.name}${c.detail && !c.ok ? `: ${c.detail}` : ""}`).join("\n")}\n\n`);
    } catch { /* the summary is a nicety */ }
  }
}

async function main(argv) {
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const known = new Set(["--claude", "--plugin-dir", "--plant", "--self-test", "--verbose", "--keep"]);
  for (let i = 0; i < argv.length; i++) {
    if (!known.has(argv[i])) { console.error(`canary: unknown argument ${argv[i]}`); return 2; }
    if (["--claude", "--plugin-dir", "--plant"].includes(argv[i])) i++;
  }
  const claude = opt("--claude") ?? findClaude();
  if (!claude || !existsSync(claude)) { console.error(`canary: no Claude Code found${claude ? ` at ${claude}` : ""}; pass --claude <binary>`); return 2; }
  const pluginDir = resolve(opt("--plugin-dir") ?? REPO);
  const verbose = argv.includes("--verbose"), keep = argv.includes("--keep");
  const fault = opt("--plant");
  if (fault && !FAULTS[fault]) { console.error(`canary: no such fault ${fault} (one of ${Object.keys(FAULTS).join(", ")})`); return 2; }
  const one = async (label, dir, planted = false) => {
    const r = await canary({ claude, pluginDir: dir, verbose, keep });
    report(label, r, planted && argv.includes("--self-test"));
    if (keep) console.log(`(kept: ${r.root})`);
    return r.ok;
  };
  if (argv.includes("--self-test")) {
    // Green on the plugin as it is, then red on each planted fault: a canary that cannot go red checks nothing.
    let green = await one("plugin as committed", pluginDir);
    // The faults are planted in a copy: the copy with none must be green too, or a fault proves nothing.
    const clean = copyPlugin(pluginDir);
    try {
      green = (await one("a copy of the plugin, no fault planted", clean)) && green;
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
    const missed = [];
    for (const [name, f] of Object.entries(FAULTS)) {
      const dir = plant(name, pluginDir);
      try {
        if (await one(`planted fault ${name} (${f.what})`, dir, true)) missed.push(name);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    console.log(`\nself-test: ${green ? "green" : "RED"} on the plugin as committed; ${Object.keys(FAULTS).length - missed.length} of ${Object.keys(FAULTS).length} planted faults turned it red${missed.length ? `; NOT caught: ${missed.join(", ")}` : ""}`);
    if (missed.length && process.env.GITHUB_ACTIONS) console.log(`::error title=canary self-test::planted faults not caught: ${missed.join(", ")}`);
    return green && !missed.length ? 0 : 1;
  }
  if (fault) {
    const dir = plant(fault, pluginDir);
    try {
      return (await one(`planted fault ${fault} (${FAULTS[fault].what})`, dir)) ? 0 : 1;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return (await one("canary", pluginDir)) ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`canary: ${e.message}`); process.exit(2); });
}
