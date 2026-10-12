/**
 * Lifetime proxy savings, as `report` and the dashboard total them.
 *
 * A running proxy writes the delta of its running total to the ledger every
 * 60 s, while /stats keeps returning the whole total since it started. Both
 * views must count each token once: the report used to add the two (one
 * request saving 22,320 tokens read "~45k" a minute later), and the dashboard
 * ignored the ledger (a stopped proxy's savings read 0).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildImpactReport, proxySavings } from "../impact.js";
import { collectDashboardData } from "../dashboard.js";
import type { LedgerEntry } from "../ledger.js";
import { withSandboxHome } from "./sandbox.js";
import { freePort } from "./freeport.js";

const startedAt = new Date(Date.now() - 120_000).toISOString();
const t0 = Date.parse(startedAt);

const carried = (proxySaved: number) => ({
  optimizeSaved: 0, optimizeUsd: 0, proxySaved, proxyUsd: 0, proxyRequests: 0, checks: 0, warnings: 0, shrinkage: 0,
});

test("the live run's own checkpoints are not added to its /stats total again", () => {
  const ledger: LedgerEntry[] = [
    { ts: t0 - 86_400_000, ev: "proxy", src: "proxy", saved: 5_000, usd: 0.01 }, // an earlier run
    { ts: t0 + 60_000, ev: "proxy", src: "proxy", saved: 22_320, usd: 0.06 }, // this run, first minute
  ];
  // 1,000 more saved since that checkpoint, not yet written.
  const live = { startedAt, tokensSaved: 23_320, estUsdSaved: 0.07 };
  const s = proxySavings(ledger, live);
  assert.equal(s.tokens, 5_000 + 23_320, "each token once: earlier run + this run's whole total");
  assert.equal(s.earlier, 5_000);
  assert.equal(s.earlierCheckpoints, 1);
  assert.ok(Math.abs(s.usd - 0.08) < 1e-9, `usd counted once too, got ${s.usd}`);

  // Stopped: every checkpoint counts, and so does history folded into a rollup.
  const stopped = proxySavings([{ ts: 1, ev: "rollup", carried: carried(700) }, ...ledger], null);
  assert.equal(stopped.tokens, 700 + 5_000 + 22_320);
  assert.equal(stopped.earlier, stopped.tokens);
});

test("another proxy's checkpoints never make the live figure negative or get dropped", () => {
  // A second proxy on another port checkpointed more than this one has saved.
  const ledger: LedgerEntry[] = [{ ts: t0 + 30_000, ev: "proxy", src: "proxy", saved: 50_000 }];
  const s = proxySavings(ledger, { startedAt, tokensSaved: 10_000 });
  assert.equal(s.tokens, 50_000, "the recorded 50k stands; nothing is subtracted below it");
});

/** A stand-in for a running proxy's /stats (same fields proxy.ts returns). */
async function fakeProxy(stats: Record<string, unknown>): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(stats));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as AddressInfo).port, close: () => server.close() };
}

test("report and dashboard show one request's savings once, running or stopped", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctxdoc-proxysave-"));
  const stateDir = mkdtempSync(join(tmpdir(), "ctxdoc-proxysave-state-"));
  // The proxy's first 60 s checkpoint, exactly as proxy.ts writes it.
  writeFileSync(
    join(stateDir, ".context-doctor-ledger.jsonl"),
    JSON.stringify({ ts: t0 + 60_000, ev: "proxy", src: "proxy", saved: 22_320, usd: 0.06696, requests: 1 }) + "\n"
  );
  const proxy = await fakeProxy({
    startedAt, requests: 1, optimizedRequests: 1, tokensBefore: 23_000, tokensAfter: 680,
    tokensSaved: 22_320, estUsdSaved: 0.067, upstreamInputTokens: 0, upstreamOutputTokens: 0, advice: [],
  });
  const saved = process.env.CONTEXT_DOCTOR_HOOK_STATE;
  process.env.CONTEXT_DOCTOR_HOOK_STATE = join(stateDir, "state.json");
  try {
    await withSandboxHome(home, async () => {
      const running = await buildImpactReport(proxy.port);
      assert.match(running, /TOTAL: ~22k tokens/, "not ~45k: the checkpoint is part of the live total");
      assert.match(running, /proxy \(exact\): 22k — 0 from earlier runs, 22k live/);
      assert.equal((await collectDashboardData(proxy.port)).totals.tokensSaved, 22_320);

      proxy.close();
      const stoppedPort = await freePort();
      assert.match(await buildImpactReport(stoppedPort), /TOTAL: ~22k tokens/);
      const stopped = await collectDashboardData(stoppedPort);
      assert.equal(stopped.proxy, null);
      assert.equal(stopped.totals.tokensSaved, 22_320, "a stopped proxy's checkpointed savings still count");
      assert.ok(stopped.totals.usdSaved > 0.06, "and so does their price");
    });
  } finally {
    proxy.close();
    if (saved === undefined) delete process.env.CONTEXT_DOCTOR_HOOK_STATE;
    else process.env.CONTEXT_DOCTOR_HOOK_STATE = saved;
  }
});
