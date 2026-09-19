/**
 * The sketch path is what makes profile_context callable from a chat app
 * (Claude Desktop, ChatGPT): ~100 tokens of input instead of the whole
 * conversation. Unit tests pin the estimator and findings; the end-to-end test
 * calls the real server over stdio the way Desktop does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { blockTokens, profileSketch, renderSketchProfile } from "../sketch.js";
import { sandboxEnv } from "./sandbox.js";

const mcpPath = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp.js");

test("sketch: size hints convert to tokens by kind", () => {
  assert.equal(blockTokens({ turn: 1, kind: "code", label: "a", approx_lines: 100 }), 1200);
  assert.equal(blockTokens({ turn: 1, kind: "paste", label: "a", approx_words: 1000 }), 1350);
  assert.equal(blockTokens({ turn: 1, kind: "text", label: "a", approx_chars: 4000 }), 1000);
  assert.equal(blockTokens({ turn: 1, kind: "tool_result", label: "a", approx_tokens: 777 }), 777);
  assert.equal(blockTokens({ turn: 1, kind: "image", label: "a" }), 1500);
});

test("sketch: a short clean chat has no findings", () => {
  const p = profileSketch({ turns: 8, model: "claude-sonnet-5", blocks: [] });
  assert.equal(p.findings.length, 0);
  assert.equal(p.totalTokens, 8 * 570);
  assert.match(renderSketchProfile(p), /No findings/);
});

test("sketch: large, repeated and stale blocks produce ranked findings with savings", () => {
  const p = profileSketch({
    turns: 40,
    model: "claude-sonnet-5",
    blocks: [
      { turn: 3, kind: "paste", label: "the nginx config", approx_lines: 600, repeated: 2 },
      { turn: 12, kind: "tool_result", label: "test output", approx_tokens: 9000, stale: true },
      { turn: 20, kind: "base64", label: "logo png", approx_chars: 20000 },
      { turn: 5, kind: "image", label: "s1" }, { turn: 6, kind: "image", label: "s2" }, { turn: 7, kind: "image", label: "s3" },
    ],
  });
  const ids = p.findings.map((f) => f.id);
  assert.ok(ids.includes("large_block"));
  assert.ok(ids.includes("duplicate_block"));
  assert.ok(ids.includes("base64_blob"));
  assert.ok(ids.includes("many_images"));
  assert.ok(ids.includes("long_history"));
  // high before warn before info
  const sev = p.findings.map((f) => f.severity);
  assert.deepEqual(sev, [...sev].sort((a, b) => ({ high: 0, warn: 1, info: 2 })[a] - ({ high: 0, warn: 1, info: 2 })[b]));
  const stale = p.findings.find((f) => f.message.includes("test output"))!;
  assert.equal(stale.estSavings, 8900);
  assert.ok(p.totalEstSavings > 0 && p.totalEstSavings <= p.totalTokens);
  assert.ok(p.perTurnUsd! > 0 && p.perTurnCachedUsd! < p.perTurnUsd!);
  const text = renderSketchProfile(p);
  assert.match(text, /Act on #1/);
  assert.match(text, /handoff/);
});

test("sketch: window pressure is flagged for a known model", () => {
  const p = profileSketch({ turns: 10, model: "gpt-4o", blocks: [{ turn: 2, kind: "paste", label: "dump", approx_tokens: 100_000 }] });
  assert.ok(p.findings.some((f) => f.id === "near_window_limit"));
});

test("mcp: profile_context accepts a sketch and rejects an empty call", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-sketch-"));
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcpPath], env: sandboxEnv(home) as Record<string, string> });
  const client = new Client({ name: "sketch-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const ok = await client.callTool({
      name: "profile_context",
      arguments: {
        sketch: {
          turns: 35,
          model: "claude-opus-5",
          blocks: [{ turn: 4, kind: "paste", label: "the migration SQL", approx_lines: 900, repeated: 2 }],
        },
      },
    });
    const text = (ok.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");
    assert.match(text, /Context estimate from sketch/);
    assert.match(text, /the migration SQL/);
    assert.match(text, /appears 2 times/);
    assert.match(text, /35 turns/);

    const bad = await client.callTool({ name: "profile_context", arguments: {} });
    assert.equal(bad.isError, true);
    assert.match((bad.content as Array<{ text: string }>)[0].text, /sketch/);

    // Instructions still tell chat apps to use the sketch.
    assert.match(client.getInstructions() ?? "", /sketch/);
  } finally {
    await client.close();
  }
});
