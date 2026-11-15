/**
 * `spend` reads Copilot CLI's `session.usage_record` events: each model call
 * once (a call written twice, a compaction a record already names), its
 * input less both cache counts, priced at list where the model has a price
 * and counted where it has none, its AI credits and premium requests kept
 * beside the price. The records are the shape GitHub's own collector and
 * the other readers parse (copilotusage.ts), with made-up numbers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copilotFileCalls, copilotModel } from "../copilotusage.js";
import { copilotSpend, renderSpend, spendReport } from "../spend.js";
import { clearScanMemo } from "../scan.js";
import { withSandboxHome } from "./sandbox.js";
import { COPILOT_USD, writeCopilot } from "./copilot-fixture.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-14T12:00:00Z");
const iso = (t: number) => new Date(t).toISOString();
const close = (a: number, b: number, msg: string) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

function sandbox<T>(fn: (home: string) => T): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "cd-copilot-"));
  const saved = process.env.CONTEXT_DOCTOR_CACHE_DIR;
  process.env.CONTEXT_DOCTOR_CACHE_DIR = join(home, "cache");
  clearScanMemo();
  return withSandboxHome(home, () => fn(home)).finally(() => {
    if (saved === undefined) delete process.env.CONTEXT_DOCTOR_CACHE_DIR;
    else process.env.CONTEXT_DOCTOR_CACHE_DIR = saved;
    clearScanMemo();
    rmSync(home, { recursive: true, force: true });
  });
}

test("copilot: model ids lose the context-size suffix and a BYOK provider's id", () => {
  assert.equal(copilotModel("claude-opus-4.6-1m"), "claude-opus-4.6");
  assert.equal(copilotModel("claude-opus-4.6-1m-internal"), "claude-opus-4.6");
  assert.equal(copilotModel("0b5e3c1a-1234-4abc-9def-0123456789ab/gpt-5.4"), "gpt-5.4");
  assert.equal(copilotModel("gpt-5.4"), "gpt-5.4");
});

test("copilot: each call once, input less both cache counts, a compaction a record names not again", async () => {
  await sandbox((home) => {
    writeCopilot(home, NOW);
    const calls = copilotFileCalls(join(home, ".copilot", "session-state", "sess-a", "events.jsonl"), "sess-a", NOW - 30 * DAY, NOW);
    assert.deepEqual(calls.map((c) => [c.model, c.input, c.read, c.write, c.output]), [
      ["claude-opus-4.6", 2_000, 6_000, 2_000, 500],
      ["gpt-5.4", 3_000, 1_000, 0, 200],
      ["claude-sonnet-4.5", 3_000, 0, 0, 300],
      ["auto", 100, 0, 0, 10],
    ]);
    assert.equal(calls[0].credits, 50);
    assert.equal(calls[0].premium, 1);
    assert.equal(calls[0].branch, "feat/cart");
    assert.equal(calls[0].gitRoot, "/Users/dev/tech/shop");
  });
});

test("copilot: spend prices at list where the model has a price, counts Auto, keeps credits and premium requests beside", async () => {
  await sandbox((home) => {
    writeCopilot(home, NOW);
    const items = copilotSpend(NOW - 30 * DAY, NOW, home);
    assert.equal(items.length, 5);
    close(items.reduce((n, i) => n + i.usd, 0), COPILOT_USD, "list price");
    const r = spendReport(30, { home, now: NOW, claudePaths: [], progress: false });
    const t = r.tools.find((x) => x.tool === "copilot")!;
    assert.equal(t.name, "Copilot CLI");
    close(t.usd, COPILOT_USD, "report");
    assert.equal(t.requests, 5);
    assert.equal(t.unpriced, 1);
    assert.deepEqual(t.unpricedModels, ["auto"]);
    assert.equal(t.credits, 53);
    assert.equal(t.premium, 2);
    assert.ok(r.projects.some((p) => p.project === "tech-shop-web"), JSON.stringify(r.projects));
    assert.ok(r.projects.some((p) => p.project === "copilot"));
    const text = renderSpend(r);
    assert.match(text, /Copilot CLI\s+\$0\.07\s+5 requests\s+53 AI credits, 1 not priced/);
    assert.match(text, /Copilot counted 53 AI credits \(\$0\.53 at \$0\.01\) and 2 premium requests/);
    assert.doesNotMatch(text, /SECRET PROMPT/);
  });
});

test("copilot: no session-state folder is no Copilot row", async () => {
  await sandbox((home) => {
    const r = spendReport(30, { home, now: NOW, claudePaths: [], progress: false });
    assert.equal(r.tools.find((x) => x.tool === "copilot"), undefined);
    assert.match(renderSpend(r), /Gemini CLI, Cursor, Copilot CLI, OpenCode or Cline on this machine/);
  });
});
