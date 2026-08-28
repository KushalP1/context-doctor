/** Prompt-cache analysis from transcript usage records. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeCacheUsage, renderCacheReport } from "../cache.js";

function transcript(rows: Array<{ read?: number; write?: number; fresh?: number }>, model = "claude-sonnet-5"): string {
  const dir = mkdtempSync(join(tmpdir(), "ctxdoc-cache-"));
  const file = join(dir, "s.jsonl");
  writeFileSync(
    file,
    rows
      .map((r) =>
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: "ok",
            model,
            usage: {
              input_tokens: r.fresh ?? 0,
              cache_read_input_tokens: r.read ?? 0,
              cache_creation_input_tokens: r.write ?? 0,
            },
          },
        })
      )
      .join("\n") + "\n"
  );
  return file;
}

test("computes hit rate and cost against the uncached counterfactual", () => {
  // 900k served from cache, 100k written: a healthy 90% hit rate.
  const usage = analyzeCacheUsage(transcript([{ read: 900_000, write: 100_000 }]))!;
  assert.equal(usage.requests, 1);
  assert.equal(usage.cacheReadTokens, 900_000);
  assert.ok(Math.abs(usage.hitRate - 0.9) < 1e-9);

  // Sonnet: $3/M input, $0.30/M cache read, writes at 1.25x input.
  //   paid = 0.9*0.30 + 0.1*3*1.25 = 0.27 + 0.375 = $0.645
  //   uncached = 1.0 * 3 = $3.00
  assert.ok(Math.abs(usage.paidUsd! - 0.645) < 1e-6, `paid ${usage.paidUsd}`);
  assert.ok(Math.abs(usage.uncachedUsd! - 3) < 1e-6);
  assert.ok(usage.savedUsd! > 2.3, "caching pays off at a high hit rate");
});

test("flags a low hit rate as prefix instability", () => {
  const rows = Array.from({ length: 10 }, () => ({ read: 10_000, write: 90_000 }));
  const report = renderCacheReport(analyzeCacheUsage(transcript(rows)))!;
  assert.match(report, /Low hit rate/);
  assert.match(report, /byte-stable/);
});

test("flags cache churn when writes rival reads", () => {
  // 60% hit rate, but writes are 66% of reads — the prefix keeps rebuilding.
  const rows = Array.from({ length: 10 }, () => ({ read: 60_000, write: 40_000 }));
  const report = renderCacheReport(analyzeCacheUsage(transcript(rows)))!;
  assert.match(report, /Cache churn/);
});

test("stays quiet on a healthy cache", () => {
  const report = renderCacheReport(analyzeCacheUsage(transcript([{ read: 950_000, write: 50_000 }])))!;
  assert.ok(!report.includes("⚠"), `no warning expected:\n${report}`);
  assert.match(report, /95\.0% of input served from cache/);
});

test("returns null when a transcript carries no usage", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxdoc-nocache-"));
  const file = join(dir, "s.jsonl");
  writeFileSync(file, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
  assert.equal(analyzeCacheUsage(file), null);
  assert.equal(renderCacheReport(null), null);
});
