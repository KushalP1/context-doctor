/**
 * Codex's footer from our MCP server (ROADMAP G5, codexstatusline.ts): the
 * tool's `_meta`, the resource read with a snapshot shaped like Codex's
 * `statusline.d.ts`, the tree within Codex's limits and its time, and no
 * footer when nothing is known. Every server runs with a throwaway home.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CODEX_STATUSLINE_STATE, CODEX_STATUSLINE_URI, measureTree, renderCodexStatusline, rolloutFor, TREE_LIMITS, type CodexStatuslineState } from "../codexstatusline.js";
import { sandboxEnv } from "./sandbox.js";

const mcpPath = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp.js");
const NOW = Date.now();

/** A UUIDv7 thread id made at `ms`, as Codex's are. */
function threadId(ms: number): string {
  const h = ms.toString(16).padStart(12, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7abc-8def-0123456789ab`;
}

/** A snapshot shaped like the sample in Codex's create-statusline skill (references/statusline.d.ts). */
function snapshot(id: string, over: Partial<NonNullable<CodexStatuslineState["thread"]>["usage"]> = {}): Record<string, unknown> {
  return {
    account: { rate_limits: [{ limit_id: "codex", limit_name: null, primary_limit: { used_percent: 23, window_minutes: 300, resets_at: Math.floor(NOW / 1000) + 3600 }, secondary_limit: { used_percent: 41, window_minutes: 10080, resets_at: Math.floor(NOW / 1000) + 86_400 } }] },
    app: { cli_version: "0.171.0", display_mode: "standard" },
    config: { statusline_items: ["model", "context-used"] },
    thread: {
      id,
      name: null,
      agent: { state: "ready" },
      model: { display_name: "GPT-5", id: "gpt-5", provider: "openai" },
      workspace: { cwd: "/work/app" },
      usage: {
        context: { context_window_size: 400_000, used_tokens: 160_000, used_percentage: 40 },
        // The thread's own totals: 8k uncached at gpt-5's $1.25 / 1M is $0.01.
        total: { total_input_tokens: 8_000, cache_read_input_tokens: 0, cache_write_input_tokens: 0, other_input_tokens: 8_000, output_tokens: 0 },
        ...over,
      },
    },
  };
}

/** The rollout of `id` where Codex writes it: two requests of 80k uncached at gpt-5's $1.25 / 1M, $0.20. */
function writeRollout(home: string, id: string, born: number): string {
  const d = new Date(born);
  const dir = join(home, ".codex", "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  const iso = (t: number) => new Date(t).toISOString();
  const tc = (at: number, total: number) => ({ timestamp: iso(at), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: total, total_tokens: total }, last_token_usage: { input_tokens: 80_000, total_tokens: 80_000 } } } });
  const rows = [
    { timestamp: iso(born), type: "session_meta", payload: { id, cwd: "/work/app" } },
    { timestamp: iso(born), type: "turn_context", payload: { cwd: "/work/app", model: "gpt-5" } },
    tc(born + 1000, 80_000),
    tc(born + 2000, 160_000),
  ];
  const file = join(dir, `rollout-${iso(born).slice(0, 19).replace(/:/g, "-")}-${id}.jsonl`);
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

const texts = (tree: unknown): string[] => {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (typeof n === "string") out.push(n);
    else if (n && typeof n === "object") for (const c of (n as { children?: unknown[] }).children ?? []) walk(c);
  };
  walk(tree);
  return out;
};

test("the footer from a snapshot: context, the session's cost, the plan's windows, one row within Codex's limits", () => {
  const tree = renderCodexStatusline(snapshot(threadId(NOW)) as CodexStatuslineState, 3.214, NOW);
  assert.ok(tree && typeof tree === "object" && tree.type === "row");
  assert.equal(tree.props.gap, 3);
  assert.deepEqual(texts(tree), ["context 160k of 400k (40%)", "$3.21 this session", "limits: 5h 23%, weekly 41%"]);
  const m = measureTree(JSON.stringify(tree));
  assert.ok(m.ok && m.bytes <= TREE_LIMITS.bytes && m.nodes <= TREE_LIMITS.nodes && m.depth <= TREE_LIMITS.depth, JSON.stringify(m));
  // Only the keys Codex's decoder accepts (it refuses unknown fields).
  const keys = new Set<string>();
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    for (const [k, v] of Object.entries(n)) {
      keys.add(k);
      if (k === "props") Object.keys(v as object).forEach((p) => keys.add(`props.${p}`));
    }
    for (const c of (n as { children?: unknown[] }).children ?? []) walk(c);
  };
  walk(tree);
  assert.deepEqual([...keys].sort(), ["children", "props", "props.color", "props.gap", "type"]);
});

test("the footer: no session price yet prices the snapshot's totals; past 70% of the context and near a limit it says so", () => {
  const s = snapshot(threadId(NOW), { context: { context_window_size: 400_000, used_tokens: 300_000, used_percentage: 75 } }) as CodexStatuslineState;
  s.account!.rate_limits![0].primary_limit!.used_percent = 92;
  const t = texts(renderCodexStatusline(s, undefined, NOW));
  assert.equal(t[0], "context 300k of 400k (75%) ⚠");
  assert.equal(t[1], "$0.01 this session", "8k uncached at $1.25 / 1M");
  assert.match(t[2], /^limits: 5h 92% \(resets (\w{3} )?\d\d:\d\d\), weekly 41%$/);
});

test("nothing known, no footer: null, which Codex draws as an empty footer", () => {
  assert.equal(renderCodexStatusline(undefined), null);
  assert.equal(renderCodexStatusline({}), null);
  assert.equal(renderCodexStatusline({ thread: { id: "x", model: { id: "no-such-model" }, usage: { context: {}, total: { total_input_tokens: 5 } } }, account: { rate_limits: [] } }), null);
});

test("rolloutFor finds a thread's rollout from the time in its id", () => {
  const home = mkdtempSync(join(tmpdir(), "cd-csl-find-"));
  const id = threadId(NOW - 3 * 86_400_000);
  const file = writeRollout(home, id, NOW - 3 * 86_400_000);
  assert.equal(rolloutFor(id, home), file);
  assert.equal(rolloutFor(threadId(NOW), home), undefined);
  assert.equal(rolloutFor("../../etc/passwd", home), undefined);
});

async function client(home: string, name: string): Promise<Client> {
  const c = new Client({ name, version: "0.171.0" }, { capabilities: {} });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [mcpPath], env: sandboxEnv(home) as Record<string, string> }));
  return c;
}

test("over stdio, to Codex: the tool's _meta names the resource; reads answer one application/json tree in time, the rollout's price once known", async () => {
  const home = mkdtempSync(join(tmpdir(), "cd-csl-mcp-"));
  const id = threadId(NOW - 60_000);
  writeRollout(home, id, NOW - 60_000);
  const c = await client(home, "codex-mcp-client");
  try {
    const tool = (await c.listTools()).tools.find((t) => t.name === "statusline");
    assert.ok(tool, "listed to Codex");
    assert.deepEqual(tool._meta, { "openai/ui": { entrypoints: [{ type: "statusline", resourceUri: CODEX_STATUSLINE_URI }] } });
    assert.equal(tool.title, "context-doctor: context, cost, limits", "the picker's label");
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.ok((await c.listResources()).resources.some((r) => r.uri === CODEX_STATUSLINE_URI));

    const read = async (state: unknown) => {
      const started = performance.now();
      const r = await c.readResource({ uri: CODEX_STATUSLINE_URI, ...(state === undefined ? {} : { _meta: { [CODEX_STATUSLINE_STATE]: state } }) } as never);
      const ms = performance.now() - started;
      assert.equal(r.contents.length, 1, "exactly one content");
      const [only] = r.contents as Array<{ uri: string; mimeType?: string; text?: string }>;
      assert.equal(only.uri, CODEX_STATUSLINE_URI, "the advertised URI, spelled the same");
      assert.equal(only.mimeType, "application/json");
      assert.equal(typeof only.text, "string");
      return { text: only.text!, ms };
    };

    // The first read starts the price worker and waits for it at most ~200 ms.
    const first = await read(snapshot(id));
    assert.ok(first.ms < 1000, `first read ${first.ms.toFixed(0)} ms, Codex allows 1 s`);
    assert.ok(measureTree(first.text).ok);
    // Then the session's price from the rollout ($0.20), not the snapshot's $0.01.
    let latest = first.text;
    const times: number[] = [];
    for (let i = 0; i < 40 && !latest.includes("$0.20 this session"); i++) {
      await new Promise((r) => setTimeout(r, 50));
      const r = await read(snapshot(id));
      latest = r.text;
      times.push(r.ms);
    }
    assert.match(latest, /"\$0\.20 this session"/, latest);
    for (let i = 0; i < 10; i++) times.push((await read(snapshot(id))).ms);
    const sorted = times.sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    // A read while the price is still being worked out waits up to ~200 ms by design, and the stdio
    // round trip comes on top (208 ms p95 on a Windows CI runner): 500 ms leaves room and is half of Codex's 1 s.
    assert.ok(p95 < 500, `p95 read ${p95.toFixed(1)} ms; Codex allows 1000, we aim under 500`);
    assert.deepEqual(texts(JSON.parse(latest)), ["context 160k of 400k (40%)", "$0.20 this session", "limits: 5h 23%, weekly 41%"]);

    // Nothing known: "null" (Codex clears the footer), never an error, which would stop its polling.
    assert.equal((await read(undefined)).text, "null");
    assert.equal((await read({ thread: { id: "not-a-thread", usage: { context: {} } } })).text, "null");
    assert.equal((await read("garbage")).text, "null");

    const call = await c.callTool({ name: "statusline", arguments: {} });
    assert.match((call.content as Array<{ text: string }>)[0].text, /\/statusline/);
  } finally {
    await c.close();
  }
});

test("over stdio, to any other client: the status line's tool and resource are not listed", async () => {
  const c = await client(mkdtempSync(join(tmpdir(), "cd-csl-other-")), "claude-code");
  try {
    assert.ok(!(await c.listTools()).tools.some((t) => t.name === "statusline"));
    assert.ok(!(await c.listResources()).resources.some((r) => r.uri === CODEX_STATUSLINE_URI));
  } finally {
    await c.close();
  }
});
