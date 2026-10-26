/**
 * ChatGPT file inputs: pack_context `files` over --http.
 *
 * Downloads are tested against a local plain-http mock: http to a loopback
 * address is allowed only with CONTEXT_DOCTOR_TEST_LOOPBACK_FILES=1, passed
 * here as the env argument (in-process) or to the spawned server. Without it
 * the same URLs are refused, which is tested too.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FILE_LIMITS, checkFileUrl, downloadFile, isPrivateAddress, sourcesFromOpenAiFiles } from "../fileparams.js";
import { freePort } from "./freeport.js";
import { sandboxEnv } from "./sandbox.js";

const mcpPath = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp.js");
const TEST_ENV = { CONTEXT_DOCTOR_TEST_LOOPBACK_FILES: "1" } as NodeJS.ProcessEnv;
const DOC = Array.from({ length: 30 }, (_, i) => `## Section ${i}\n\n${i === 17 ? "Rotate the signing key with the keyctl command." : "Nothing about that here. ".repeat(40)}`).join("\n\n");

// A local mock of a file host: plain http on 127.0.0.1.
const mock: Server = createServer((req, res) => {
  const url = req.url ?? "/";
  if (url === "/doc.md") return void res.end(DOC);
  if (url === "/bin") return void res.end(Buffer.from([0, 1, 2, 3, 0, 0]));
  if (url === "/to-http") return void res.writeHead(302, { location: "http://example.com/doc.md" }).end();
  if (url === "/to-self") return void res.writeHead(302, { location: "/doc.md" }).end();
  if (url === "/loop") return void res.writeHead(302, { location: "/loop" }).end();
  if (url === "/to-private") return void res.writeHead(302, { location: "https://10.1.2.3/x" }).end();
  if (url === "/big-declared") return void res.writeHead(200, { "content-length": String(FILE_LIMITS.bytes + 1) }).end();
  if (url === "/big-chunked") {
    res.writeHead(200);
    const chunk = Buffer.alloc(1024 * 1024, 97);
    for (let i = 0; i < 6; i++) res.write(chunk);
    return void res.end();
  }
  if (url === "/hang") return; // never answers
  res.writeHead(404).end();
});
const port = await freePort();
await new Promise<void>((r) => mock.listen(port, "127.0.0.1", r));
after(() => mock.close());
const at = (path: string) => `http://127.0.0.1:${port}${path}`;

test("download URLs: https to a public host only; no credentials, local names or private addresses", () => {
  assert.ok("url" in checkFileUrl("https://files.example.com/a.pdf", {}));
  const refused: Array<[string, RegExp]> = [
    ["http://files.example.com/a.pdf", /only https/],
    [at("/doc.md"), /only https/],
    ["https://user:pw@files.example.com/a", /credentials/],
    ["https://localhost/a", /local host name/],
    ["https://printer.local/a", /local host name/],
    ["https://10.0.0.5/a", /private/],
    ["https://169.254.169.254/latest/meta-data", /private/],
    ["https://[::1]/a", /private/],
    ["https://[fd00::1]/a", /private/],
    ["https://[::ffff:127.0.0.1]/a", /private/],
    ["https://[::ffff:7f00:1]/a", /private/],
    ["https://[::ffff:a9fe:a9fe]/latest", /private/],
    ["https://2130706433/a", /private/],
    ["https://0x7f.1/a", /private/],
    ["file:///etc/passwd", /only https/],
    ["not a url", /not a URL/],
  ];
  for (const [url, why] of refused) {
    const r = checkFileUrl(url, {});
    assert.ok("error" in r && why.test(r.error), `${url}: ${JSON.stringify(r)}`);
  }
  // The test switch opens plain http to loopback only, and nothing else.
  assert.ok("url" in checkFileUrl(at("/doc.md"), TEST_ENV));
  assert.ok("error" in checkFileUrl("http://files.example.com/a", TEST_ENV));
  assert.ok("error" in checkFileUrl("https://10.0.0.5/a", TEST_ENV));
});

test("private address ranges, v4 and v6", () => {
  for (const ip of [
    "127.0.0.1", "10.1.1.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "::1", "::", "0:0:0:0:0:0:0:1", "fe80::1", "fe80::1%lo0", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1", "64:ff9b::7f00:1",
    // One loopback, many spellings: the URL parser turns [::ffff:127.0.0.1] into [::ffff:7f00:1].
    "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:0001", "::ffff:a9fe:a9fe", "::7f00:1", "[::1]",
    "not-an-ip",
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "::ffff:808:808"]) assert.equal(isPrivateAddress(ip), false, ip);
});

test("download: the body, same-host redirects followed, redirects to http or private hosts refused, sizes and time capped", async () => {
  const ok = await downloadFile(at("/doc.md"), TEST_ENV);
  assert.ok("body" in ok && ok.body.toString().includes("keyctl"));
  const redirected = await downloadFile(at("/to-self"), TEST_ENV);
  assert.ok("body" in redirected && redirected.body.toString().includes("keyctl"));
  const cases: Array<[string, RegExp]> = [
    ["/to-http", /refused a redirect: only https/],
    ["/to-private", /refused a redirect: a private/],
    ["/loop", /more than 3 redirects/],
    ["/big-declared", /too large/],
    ["/big-chunked", /too large/],
    ["/missing", /HTTP 404/],
  ];
  for (const [path, why] of cases) {
    const r = await downloadFile(at(path), TEST_ENV);
    assert.ok("error" in r && why.test(r.error), `${path}: ${JSON.stringify(r)}`);
  }
  // Without the test switch, the mock is out of reach: http and loopback.
  const real = await downloadFile(at("/doc.md"), {});
  assert.ok("error" in real && /only https/.test(real.error));

  const saved = FILE_LIMITS.timeoutMs;
  FILE_LIMITS.timeoutMs = 300;
  try {
    const started = Date.now();
    const hung = await downloadFile(at("/hang"), TEST_ENV);
    assert.ok("error" in hung && /timed out/.test(hung.error));
    assert.ok(Date.now() - started < 3000);
  } finally {
    FILE_LIMITS.timeoutMs = saved;
  }
});

test("files to sources: text is packed under the file's own name; binaries and refusals are reported, never thrown", async () => {
  const got = await sourcesFromOpenAiFiles(
    [
      { download_url: at("/doc.md"), file_id: "file_1", file_name: "../../notes/guide.md" },
      { download_url: at("/bin"), file_id: "file_2", file_name: "blob.dat" },
      { download_url: "https://10.0.0.1/x", file_id: "file_3" },
    ],
    TEST_ENV
  );
  assert.deepEqual(got.sources.map((s) => s.name), ["guide.md"]);
  assert.match(got.skipped.join("\n"), /blob\.dat: binary/);
  assert.match(got.skipped.join("\n"), /file_3: refused: a private/);
});

async function httpServer(env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "cd-fp-"));
  const p = await freePort();
  const child = spawn(process.execPath, [mcpPath, "--http", "--port", String(p)], { stdio: ["ignore", "ignore", "pipe"], env: { ...sandboxEnv(home), ...env } });
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
  const rpc = async (method: string, params: Record<string, unknown> = {}) =>
    (await (await fetch(`http://127.0.0.1:${p}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) })).json()) as any;
  return { child, rpc };
}

test("pack_context over HTTP declares openai/fileParams with the file schema ChatGPT requires; stdio does not", async () => {
  const { child, rpc } = await httpServer();
  try {
    const tool = (await rpc("tools/list")).result.tools.find((t: any) => t.name === "pack_context");
    assert.deepEqual(tool._meta, { "openai/fileParams": ["files"] });
    const item = tool.inputSchema.properties.files.items;
    assert.deepEqual(Object.keys(item.properties).sort(), ["download_url", "file_id", "file_name", "mime_type"]);
    assert.deepEqual(item.required.sort(), ["download_url", "file_id"]);
    assert.equal(item.additionalProperties, false);
    for (const k of Object.keys(item.properties)) assert.equal(item.properties[k].type, "string");
    // No paths (nothing is read from the server's disk) and no local embeddings over HTTP.
    assert.equal(tool.inputSchema.properties.paths, undefined);
    assert.equal(tool.inputSchema.properties.semantic, undefined);
    // The HTTP definitions ride on every ChatGPT request too: same budget as stdio's.
    const { estimateTokens } = await import("../tokens.js");
    const all = (await rpc("tools/list")).result.tools as Array<{ name: string; description: string; inputSchema: unknown }>;
    const total = all.reduce((n, t) => n + estimateTokens(JSON.stringify({ name: t.name, description: t.description, input_schema: t.inputSchema }), "claude"), 0);
    assert.ok(total <= 2400, `HTTP tool definitions are ~${total} Claude tokens; keep them under 2,400`);
  } finally {
    child.kill();
  }
  const client = new Client({ name: "fp", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpPath], env: sandboxEnv(mkdtempSync(join(tmpdir(), "cd-fps-"))) as Record<string, string> }));
  try {
    const tool = (await client.listTools()).tools.find((t) => t.name === "pack_context")!;
    assert.equal((tool.inputSchema.properties as Record<string, unknown>).files, undefined);
    assert.equal(tool._meta, undefined);
  } finally {
    await client.close();
  }
});

test("pack_context over HTTP packs an uploaded file; the same URL is refused without the test switch", async () => {
  const files = [{ download_url: at("/doc.md"), file_id: "file_abc", file_name: "runbook.md", mime_type: "text/markdown" }];
  const { child, rpc } = await httpServer(TEST_ENV as Record<string, string>);
  try {
    const r = await rpc("tools/call", { name: "pack_context", arguments: { files, query: "how to rotate the signing key", max_tokens: 600 } });
    const t = r.result.content[0].text as string;
    assert.match(t, /^PACKED/);
    assert.match(t, /runbook\.md#18/);
    assert.match(t, /keyctl/);
    const paths = await rpc("tools/call", { name: "pack_context", arguments: { paths: ["/etc/hosts"] } });
    const refused = paths.result ?? { isError: true, content: [{ text: paths.error?.message ?? "" }] };
    assert.equal(refused.isError, true);
    assert.doesNotMatch(refused.content[0].text, /localhost/, "no file from the server's disk");
  } finally {
    child.kill();
  }
  const strict = await httpServer();
  try {
    const r = await strict.rpc("tools/call", { name: "pack_context", arguments: { files, query: "signing key" } });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /runbook\.md: refused: only https/);
  } finally {
    strict.child.kill();
  }
});
