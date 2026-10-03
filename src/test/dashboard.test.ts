/** Dashboard: local-only server, real data shape, self-contained page. */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { startDashboard, collectDashboardData } from "../dashboard.js";

const server = startDashboard({ port: 0 });
await new Promise<void>((r) => server.once("listening", () => r()));
const port = (server.address() as AddressInfo).port;
after(() => server.close());

test("binds loopback only", () => {
  assert.equal((server.address() as AddressInfo).address, "127.0.0.1");
});

test("/api/data returns the documented shape", async () => {
  const data = (await (await fetch(`http://127.0.0.1:${port}/api/data`)).json()) as Record<string, any>;
  for (const key of ["generatedAt", "totals", "daily", "sessions", "proxy", "budget"]) {
    assert.ok(key in data, `missing ${key}`);
  }
  for (const key of ["tokensSaved", "usdSaved", "checks", "warnings", "optimizeRuns"]) {
    assert.equal(typeof data.totals[key], "number", `totals.${key} must be numeric`);
  }
  assert.ok(Array.isArray(data.daily) && Array.isArray(data.sessions));
});

test("page is self-contained: no external requests", async () => {
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.ok(html.startsWith("<!doctype html>"));
  // Only same-origin data fetch; nothing pulled from the network.
  assert.ok(!/https?:\/\//.test(html.replace(/http:\/\/127\.0\.0\.1/g, "")), "page must not reference remote origins");
  assert.ok(html.includes("/api/data"));
  // Accessibility affordances required by the house chart rules.
  assert.ok(html.includes("Table view"), "table view present");
  assert.ok(html.includes('role="img"') || html.includes("aria-label"), "charts labelled");
  assert.ok(html.includes("prefers-color-scheme: dark"), "dark mode selected, not flipped");
});

test("collectDashboardData works without a proxy running", async () => {
  const data = await collectDashboardData(59999); // nothing listens here
  assert.equal(data.proxy, null);
  assert.ok(data.totals.tokensSaved >= 0);
});

test("sketch checks never count as session shrinkage (they describe different chats)", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cd-dash-sketch-"));
  const saved = process.env.CONTEXT_DOCTOR_HOOK_STATE;
  process.env.CONTEXT_DOCTOR_HOOK_STATE = join(dir, "state.json");
  try {
    // A ledger written by 0.17-0.23: two sketches of unrelated chats under the shared old id.
    writeFileSync(join(dir, ".context-doctor-ledger.jsonl"), [
      { ts: 1, ev: "check", sid: "mcp-sketch", src: "mcp", tok: 900_000 },
      { ts: 2, ev: "check", sid: "mcp-sketch", src: "mcp", tok: 1_000 },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const data = await collectDashboardData(1);
    assert.equal(data.totals.tokensSaved, 0, "a big sketch followed by a small one is not a saving");
  } finally {
    if (saved === undefined) delete process.env.CONTEXT_DOCTOR_HOOK_STATE; else process.env.CONTEXT_DOCTOR_HOOK_STATE = saved;
  }
});

test("compaction shrinkage is reported apart from tokens context-doctor saved", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cd-dash-shrink-"));
  const saved = process.env.CONTEXT_DOCTOR_HOOK_STATE;
  process.env.CONTEXT_DOCTOR_HOOK_STATE = join(dir, "state.json");
  try {
    writeFileSync(join(dir, ".context-doctor-ledger.jsonl"), [
      { ts: 1, ev: "check", sid: "sess-1", tok: 500_000, warn: true },
      { ts: 2, ev: "check", sid: "sess-1", tok: 60_000 }, // compacted
      { ts: 3, ev: "optimize", src: "cli", saved: 4_000, model: "claude-opus-5" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const d = await collectDashboardData(1);
    assert.equal(d.totals.tokensSaved, 4_000, "only what context-doctor removed");
    assert.equal(d.totals.shrinkage, 440_000, "compaction shown on its own");
  } finally {
    if (saved === undefined) delete process.env.CONTEXT_DOCTOR_HOOK_STATE; else process.env.CONTEXT_DOCTOR_HOOK_STATE = saved;
  }
});
