/**
 * Compact tool results: ChatGPT (recognised by the openai/session or
 * openai/subject metadata on its tool calls) gets a short text with the detail as structuredContent and the
 * presentation in _meta; every other client keeps the full text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compactOutline, compactProfile, compactSketch, resultMode } from "../compact.js";
import { parseConversation } from "../parse.js";
import { profileConversation } from "../profile.js";
import { renderProfile } from "../report.js";
import { packContext, renderPack } from "../pack.js";
import { profileSketch, renderSketchProfile } from "../sketch.js";
import { freePort } from "./freeport.js";
import { sandboxEnv } from "./sandbox.js";

const mcpPath = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp.js");
const DOC = Array.from({ length: 30 }, (_, i) => `## Section ${i}\n\n${i === 17 ? "Rotate the signing key with the keyctl command." : "Nothing about that here. ".repeat(40)}`).join("\n\n");

async function httpServer() {
  const home = mkdtempSync(join(tmpdir(), "cd-cr-"));
  const p = await freePort();
  const child = spawn(process.execPath, [mcpPath, "--http", "--port", String(p)], { stdio: ["ignore", "ignore", "pipe"], env: sandboxEnv(home) });
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

test("compact results: ChatGPT (openai/* request meta) gets a short text plus structuredContent and _meta; others keep the full text", async () => {
  const conversation = readFileSync("examples/sample-conversation.json", "utf8");
  const { child, rpc } = await httpServer();
  try {
    const full = await rpc("tools/call", { name: "profile_context", arguments: { conversation } });
    assert.match(full.result.content[0].text, /CONTEXT DOCTOR — profile/);
    assert.equal(full.result.structuredContent, undefined);

    const meta = { "openai/session": "s1", "openai/locale": "en-US" };
    const compact = await rpc("tools/call", { name: "profile_context", arguments: { conversation }, _meta: meta });
    const c = compact.result;
    assert.ok(c.content[0].text.length < 400, c.content[0].text);
    assert.match(c.content[0].text, /recoverable/);
    assert.ok(c.structuredContent.total_tokens > 0 && c.structuredContent.findings.length > 0);
    assert.match(c._meta["context-doctor/report"], /CONTEXT DOCTOR — profile/);

    const sketch = await rpc("tools/call", { name: "profile_context", arguments: { sketch: { turns: 40, blocks: [{ turn: 3, kind: "paste", label: "the log", approx_tokens: 30_000 }] } }, _meta: meta });
    assert.match(sketch.result.content[0].text, /history cannot be edited/);
    assert.equal(sketch.result.structuredContent.recoverable_by, "a new chat (handoff)");

    const outline = await rpc("tools/call", { name: "pack_context", arguments: { text: DOC }, _meta: meta });
    assert.match(outline.result.content[0].text, /^OUTLINE of text/);
    assert.ok(outline.result.structuredContent.sources[0].sections.length > 0);
    const query = await rpc("tools/call", { name: "pack_context", arguments: { text: DOC, query: "signing key" }, _meta: meta });
    assert.equal(query.result.structuredContent, undefined, "packed chunks are what the model asked for: always text");
  } finally {
    child.kill();
  }
});

test("result mode: an explicit CONTEXT_DOCTOR_RESULTS wins; unknown clients get the full text", () => {
  assert.equal(resultMode(undefined, {}), "full");
  assert.equal(resultMode({ progressToken: 1 }, {}), "full");
  assert.equal(resultMode({ "openai/subject": "u" }, {}), "compact");
  assert.equal(resultMode({ "openai/session": "s" }, {}), "compact");
  assert.equal(resultMode({ "openai/locale": "en-US", "openai/userAgent": "x" }, {}), "full", "only ChatGPT's own ids, not any OpenAI key");
  assert.equal(resultMode({ "openai/subject": "u" }, { CONTEXT_DOCTOR_RESULTS: "full" }), "full");
  assert.equal(resultMode(undefined, { CONTEXT_DOCTOR_RESULTS: "compact" }), "compact");
});

test("compact forms are smaller than the full text on the sample conversation and a docs outline", () => {
  const profile = profileConversation(parseConversation(readFileSync("examples/sample-conversation.json", "utf8")));
  const fullProfile = renderProfile(profile);
  const cp = compactProfile(profile, fullProfile);
  assert.ok(cp.text.length + JSON.stringify(cp.structured).length < fullProfile.length * 0.6, `${cp.text.length + JSON.stringify(cp.structured).length} vs ${fullProfile.length}`);
  // Nothing decision-relevant is lost: every finding is still there, in full.
  for (const f of profile.findings.slice(0, 6)) assert.ok((cp.structured.findings as string[]).some((x) => x.includes(f.message)));
  const sp = profileSketch({ turns: 42, model: "claude-sonnet-5", blocks: [{ turn: 3, kind: "paste", label: "the server log", approx_lines: 4000 }, { turn: 9, kind: "paste", label: "the log again", approx_lines: 4000, repeated: 2 }] });
  const fullSketch = renderSketchProfile(sp);
  const cs = compactSketch(sp, fullSketch);
  // What ChatGPT puts in front of the model is the text AND the structured part.
  assert.ok(cs.text.length + JSON.stringify(cs.structured).length < fullSketch.length * 0.7, `${cs.text.length + JSON.stringify(cs.structured).length} vs ${fullSketch.length}`);
  assert.match(cs.text, /Act on #1 now: 42 turns.*save_handoff/);
  const r = packContext([{ name: "doc.md", text: DOC }]);
  const fullOutline = renderPack(r);
  const co = compactOutline(r, fullOutline);
  assert.ok(co.text.length + JSON.stringify(co.structured).length < fullOutline.length);
  // Every chunk is reachable from the sections: ranges cover #1..#n.
  const sections = (co.structured.sources as Array<{ sections: string[] }>)[0].sections;
  assert.match(sections[0], /^#1 /);
  assert.match(sections[sections.length - 1], new RegExp(`#(\\d+-)?${r.chunks.length} `));
});
