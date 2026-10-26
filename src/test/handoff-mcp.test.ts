/**
 * The handoff and ask_file surfaces through the official MCP client, the way
 * Claude Desktop (stdio, prompts in the + menu, attachable resources) and
 * ChatGPT (a URL, tools only) reach them. Every server runs with a throwaway
 * home directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { handoffDir } from "../handoff.js";
import { freePort } from "./freeport.js";
import { sandboxEnv } from "./sandbox.js";

const mcpPath = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp.js");
const BRIEF = "Goal: migrate invoices to v2.\nDecided: keep the old ids.\nState: script written, dry run clean.\nOpen: run it on prod Friday.\nIds: invoices_v2, PR #88.";
const text = (r: unknown) => ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n");

async function stdioClient(home: string, capabilities: Record<string, unknown> = {}): Promise<Client> {
  const client = new Client({ name: "handoff-test", version: "1" }, { capabilities });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpPath], env: sandboxEnv(home) as Record<string, string> }));
  return client;
}

test("prompts: handoff and ask_file render the instructions the model acts on", async () => {
  const client = await stdioClient(mkdtempSync(join(tmpdir(), "cd-hp-")));
  try {
    const { prompts } = await client.listPrompts();
    const handoff = prompts.find((p) => p.name === "handoff")!;
    assert.ok(handoff && /new chat/.test(handoff.description ?? ""));
    assert.equal(handoff.arguments?.find((a) => a.name === "focus")?.required, false);
    const h = await client.getPrompt({ name: "handoff", arguments: { focus: "the Friday prod run" } });
    const ht = (h.messages[0].content as { text: string }).text;
    assert.match(ht, /at most 400 tokens/);
    assert.match(ht, /call save_handoff/);
    assert.match(ht, /verbatim/);
    assert.match(ht, /chat_tokens/);
    assert.match(ht, /The next chat will work on: the Friday prod run/);
    assert.doesNotMatch(text({ content: [(await client.getPrompt({ name: "handoff", arguments: {} })).messages[0].content] }), /next chat will work on/);

    const askFile = prompts.find((p) => p.name === "ask_file")!;
    assert.deepEqual(askFile.arguments?.map((a) => [a.name, a.required]), [["path", true], ["question", true]]);
    const a = await client.getPrompt({ name: "ask_file", arguments: { path: "/srv/logs/app.log", question: "why did the 3am job fail?" } });
    const at = (a.messages[0].content as { text: string }).text;
    assert.match(at, /pack_context with paths \["\/srv\/logs\/app\.log"\]/);
    assert.match(at, /why did the 3am job fail\?/);
    assert.match(at, /do not read the file whole/);
  } finally {
    await client.close();
  }
});

test("save_handoff over stdio: stored under the sandboxed home, listed and readable as resources, with the token math", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-hs-"));
  const client = await stdioClient(home);
  try {
    const before = await client.readResource({ uri: "handoff://latest" });
    assert.match((before.contents[0] as { text: string }).text, /No handoff saved yet/);

    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "save_handoff")!;
    assert.equal(tool.annotations?.readOnlyHint, false, "it writes a file, so clients that gate writes may ask");
    assert.equal(tool.annotations?.destructiveHint, false);

    const r = await client.callTool({
      name: "save_handoff",
      arguments: { brief: BRIEF, title: "Invoices v2", verbatim: [{ label: "the migration", text: "UPDATE invoices SET v=2;" }], chat_tokens: 52_000, model: "claude-sonnet-5" },
    });
    const t = text(r);
    assert.notEqual(r.isError, true, t);
    assert.match(t, /^Handoff saved: \d{8}-\d{6}-invoices-v2 \(~\d+ tokens: brief ~\d+, 1 verbatim block/);
    assert.match(t, /~\/\.context-doctor\/handoffs\//);
    assert.match(t, /Now: ~52k tokens re-read on every turn \(\$/);
    assert.match(t, /Saves ~5\dk tokens per further turn/);
    assert.match(t, /attach the resource handoff:\/\/latest/);
    assert.match(t, /print the brief and the verbatim blocks in one fenced block/);
    const id = t.match(/Handoff saved: (\S+)/)![1];
    assert.ok(existsSync(join(handoffDir(home), id, "handoff.md")));

    const { resources } = await client.listResources();
    assert.deepEqual(resources.map((x) => x.uri).sort(), [`handoff://${id}`, "handoff://latest"].sort());
    assert.equal(resources.find((x) => x.uri === `handoff://${id}`)?.title, "Invoices v2");
    const latest = (await client.readResource({ uri: "handoff://latest" })).contents[0] as { text: string; mimeType: string };
    assert.equal(latest.mimeType, "text/markdown");
    assert.match(latest.text, /# Handoff: Invoices v2/);
    assert.match(latest.text, /UPDATE invoices SET v=2;/);
    assert.equal(((await client.readResource({ uri: `handoff://${id}` })).contents[0] as { text: string }).text, latest.text);
    for (const bad of ["handoff://..%2F..%2Fetc%2Fpasswd", "handoff://20990101-000000-none", "handoff://NOPE"]) {
      await assert.rejects(client.readResource({ uri: bad }), /No saved handoff|not found/i, bad);
    }
  } finally {
    await client.close();
  }
});

test("save_handoff: bad input is refused with the reason and nothing is written", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-hb-"));
  const client = await stdioClient(home);
  try {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ brief: "   " }, /brief.*empty/],
      [{ brief: "x".repeat(6001) }, /limit is 6000/],
      [{ brief: BRIEF, verbatim: Array.from({ length: 21 }, (_, i) => ({ label: `b${i}`, text: "x" })) }, /21 verbatim blocks/],
      [{ brief: BRIEF, verbatim: [{ label: "huge", text: "y".repeat(20_001) }] }, /"huge"/],
      [{ brief: BRIEF, chat_tokens: -5 }, /chatTokens/],
    ];
    for (const [args, why] of cases) {
      const r = await client.callTool({ name: "save_handoff", arguments: args });
      assert.equal(r.isError, true, JSON.stringify(args).slice(0, 80));
      assert.match(text(r), why);
    }
    const wrongType = await client.callTool({ name: "save_handoff", arguments: { brief: 42 } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
    assert.equal(wrongType.isError, true);
    assert.equal(existsSync(handoffDir(home)), false, "nothing written");
  } finally {
    await client.close();
  }
});

test("save_handoff: secret-looking strings are masked and the result says so", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-hsec-"));
  const client = await stdioClient(home);
  try {
    const r = await client.callTool({ name: "save_handoff", arguments: { brief: `${BRIEF}\nDB url key: ${["sk", "ant", "api03", "LEAK".repeat(6)].join("-")}` } });
    assert.match(text(r), /Masked 1 secret-looking string\(s\) \(an Anthropic key\)/);
    const id = text(r).match(/Handoff saved: (\S+)/)![1];
    assert.ok(!readFileSync(join(handoffDir(home), id, "handoff.md"), "utf8").includes("LEAKLEAK"));
  } finally {
    await client.close();
  }
});

test("elicitation: where the client can show a form, the user confirms the handoff and the prune; a no is respected", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-he-"));
  const answers: Array<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }> = [];
  const asked: string[] = [];
  const client = new Client({ name: "elicit-test", version: "1" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    asked.push(req.params.message);
    return answers.shift() ?? { action: "cancel" };
  });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpPath], env: sandboxEnv(home) as Record<string, string> }));
  try {
    const args = { brief: BRIEF, title: "elicit", verbatim: [{ label: "cfg", text: "port=8080" }] };
    answers.push({ action: "decline" });
    const declined = await client.callTool({ name: "save_handoff", arguments: args });
    assert.match(text(declined), /^Not saved: the user declined/);
    assert.match(asked[0], /Save a handoff of this chat on this computer/);
    assert.match(asked[0], /1 verbatim block\(s\): cfg/);
    assert.equal(existsSync(handoffDir(home)), false);

    answers.push({ action: "accept", content: { include_verbatim: false } });
    const noBlocks = await client.callTool({ name: "save_handoff", arguments: args });
    assert.match(text(noBlocks), /^Handoff saved: .*brief ~\d+\)/);
    const id = text(noBlocks).match(/Handoff saved: (\S+)/)![1];
    assert.doesNotMatch(readFileSync(join(handoffDir(home), id, "handoff.md"), "utf8"), /port=8080/);

    const conversation = JSON.stringify(Array.from({ length: 16 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i} `.repeat(200) })));
    answers.push({ action: "decline" });
    const pruneNo = await client.callTool({ name: "optimize_context", arguments: { conversation, strategies: ["prune-history"], keep_recent: 4 } });
    assert.match(text(pruneNo), /prune-history skipped: the user declined/);
    assert.doesNotMatch(text(pruneNo), /PRUNED TURNS DIGEST/);
    assert.match(asked[2], /Prune old turns.*all but the last 4 messages/);

    answers.push({ action: "accept", content: { prune: true } });
    const pruneYes = await client.callTool({ name: "optimize_context", arguments: { conversation, strategies: ["prune-history"], keep_recent: 4 } });
    assert.match(text(pruneYes), /PRUNED TURNS DIGEST/);
  } finally {
    await client.close();
  }
});

test("consent fails closed once a client declares forms: an error, a dismissal or a malformed answer is a no", async () => {
  const { McpError } = await import("@modelcontextprotocol/sdk/types.js");
  const home = mkdtempSync(join(tmpdir(), "cd-hfc-"));
  type Answer = () => unknown;
  const answers: Answer[] = [];
  const client = new Client({ name: "elicit-closed", version: "1" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async () => (answers.shift() ?? (() => ({ action: "cancel" })))() as any);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpPath], env: sandboxEnv(home) as Record<string, string> }));
  try {
    const args = { brief: BRIEF, title: "closed", verbatim: [{ label: "cfg", text: "x=1" }] };
    const cases: Array<[string, Answer, RegExp]> = [
      ["client error", () => { throw new McpError(-32603, "UI unavailable"); }, /^Not saved: the consent form failed/],
      ["dismissed", () => ({ action: "cancel" }), /^Not saved: the user dismissed the prompt/],
      ["malformed answer", () => ({ action: "accept", content: { include_verbatim: "no" } }), /^Not saved: the consent form failed/],
    ];
    for (const [label, answer, why] of cases) {
      answers.push(answer);
      const r = await client.callTool({ name: "save_handoff", arguments: args });
      assert.match(text(r), why, label);
    }
    assert.equal(existsSync(handoffDir(home)), false, "nothing was saved");
    const conversation = JSON.stringify(Array.from({ length: 16 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i} `.repeat(200) })));
    answers.push(() => { throw new McpError(-32603, "UI unavailable"); });
    const pruned = await client.callTool({ name: "optimize_context", arguments: { conversation, strategies: ["prune-history"], keep_recent: 4 } });
    assert.match(text(pruned), /prune-history skipped: the consent form failed/);
    assert.doesNotMatch(text(pruned), /PRUNED TURNS DIGEST/);
  } finally {
    await client.close();
  }
});

test("the consent form masks before it truncates: a secret at the cut does not leak a prefix", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-hmt-"));
  const asked: string[] = [];
  const client = new Client({ name: "elicit-mask", version: "1" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    asked.push(req.params.message);
    return { action: "decline" };
  });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpPath], env: sandboxEnv(home) as Record<string, string> }));
  try {
    const key = ["AK", "IA", "IOSFODNN7EXAMPLE"].join("");
    // Untitled: the form shows the brief's first line, cut to 80 characters, right through the key.
    await client.callTool({ name: "save_handoff", arguments: { brief: "x".repeat(70) + " " + key + "\nmore", verbatim: [{ label: `token ${["gh", "p_"].join("")}${"a1B2".repeat(9)}`, text: "x" }] } });
    assert.equal(asked.length, 1);
    assert.ok(!asked[0].includes("AKIAIOS") && !asked[0].includes("a1B2a1B2"), asked[0]);
  } finally {
    await client.close();
  }
});

test("no elicitation declared: nothing is asked, the handoff is saved (consent was the chat's)", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-hn-"));
  const client = await stdioClient(home);
  try {
    const r = await client.callTool({ name: "save_handoff", arguments: { brief: BRIEF } });
    assert.match(text(r), /^Handoff saved/);
    const conversation = JSON.stringify(Array.from({ length: 16 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i} `.repeat(200) })));
    const pruned = await client.callTool({ name: "optimize_context", arguments: { conversation, strategies: ["prune-history"], keep_recent: 4 } });
    assert.match(text(pruned), /PRUNED TURNS DIGEST/);
  } finally {
    await client.close();
  }
});

/** Start `mcp.js --http` with a throwaway home; resolves once it listens. */
async function httpServer(home: string, extraArgs: string[] = [], env: Record<string, string> = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [mcpPath, "--http", "--port", String(port), ...extraArgs], { stdio: ["ignore", "ignore", "pipe"], env: { ...sandboxEnv(home), ...env } });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("HTTP MCP server did not start")), 8000);
    child.stderr.on("data", (d: Buffer) => {
      if (d.toString().includes("streamable HTTP")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    return (await res.json()) as any;
  };
  return { child, rpc };
}

test("over HTTP: save_handoff stores nothing and is read-only; no handoff resources are exposed", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-hh-"));
  const { child, rpc } = await httpServer(home);
  try {
    const list = await rpc("tools/list");
    const tool = list.result.tools.find((t: any) => t.name === "save_handoff");
    assert.equal(tool.annotations.readOnlyHint, true);
    const r = await rpc("tools/call", { name: "save_handoff", arguments: { brief: BRIEF, turns: 40, model: "gpt-5" } });
    const t = r.result.content[0].text as string;
    assert.match(t, /not stored: this server runs over HTTP and keeps nothing/);
    assert.match(t, /print the brief and the verbatim blocks in one fenced block/);
    assert.match(t, /estimated from the turn count/);
    assert.equal(existsSync(join(home, ".context-doctor")), false);
    const res = await rpc("resources/list");
    assert.ok(res.error, "no resources capability over HTTP");
  } finally {
    child.kill();
  }
});

test("over HTTP with --store-handoffs: stored on this machine, annotated as a write, still no resources", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-hhs-"));
  const { child, rpc } = await httpServer(home, ["--store-handoffs"]);
  try {
    const list = await rpc("tools/list");
    assert.equal(list.result.tools.find((t: any) => t.name === "save_handoff").annotations.readOnlyHint, false);
    const r = await rpc("tools/call", { name: "save_handoff", arguments: { brief: BRIEF, title: "over http" } });
    assert.match(r.result.content[0].text, /^Handoff saved: \S+-over-http/);
    assert.equal(readdirSync(handoffDir(home)).length, 1);
    assert.ok((await rpc("resources/list")).error);
  } finally {
    child.kill();
  }
});

test("errors name no absolute path: ~ over stdio, nothing at all over HTTP", { skip: process.platform === "win32" && "directory symlinks need privileges on Windows" }, async () => {
  const { mkdirSync, symlinkSync } = await import("node:fs");
  const setup = () => {
    const home = mkdtempSync(join(tmpdir(), "cd-herr-"));
    mkdirSync(join(home, ".context-doctor"));
    symlinkSync(mkdtempSync(join(tmpdir(), "cd-herr-else-")), join(home, ".context-doctor", "handoffs"));
    return home;
  };
  const home = setup();
  const client = await stdioClient(home);
  try {
    const r = await client.callTool({ name: "save_handoff", arguments: { brief: BRIEF } });
    assert.equal(r.isError, true);
    assert.match(text(r), /^Not saved: ~\/\.context-doctor\/handoffs is a symbolic link/);
    assert.ok(!text(r).includes(home));
  } finally {
    await client.close();
  }
  const home2 = setup();
  const { child, rpc } = await httpServer(home2, ["--store-handoffs"]);
  try {
    const r = await rpc("tools/call", { name: "save_handoff", arguments: { brief: BRIEF } });
    assert.equal(r.result.isError, true);
    assert.equal(r.result.content[0].text, "Not saved: the server could not store the handoff.");
  } finally {
    child.kill();
  }
});
