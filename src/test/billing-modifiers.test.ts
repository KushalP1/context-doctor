/**
 * Billing modifiers agree across every report that prices a request: on a
 * session with a fast-mode request, a US-only one, a 150k Haiku 5.5 prompt
 * and two web searches (modifier-fixture.ts), `spend`, `limits`' usage, the
 * budget, the session price and `savings`' bill all come to the same
 * dollars, and `spend` says what each modifier added. And prices that end on
 * a day (gpt-5.6-sol's promotion, Gemini 4 Argon's) with a frozen clock
 * either side: `spend`, the budget and `doctor` say the price changed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSpend, codexFileSpend, renderSpend, renderSpendShare, summarizeSpend } from "../spend.js";
import { claudeUsage } from "../limits.js";
import { periodSpend, renderBudgetStatus, type Budget } from "../budget.js";
import { sessionPriceDue } from "../sessionprice.js";
import { estimateSavings } from "../savings.js";
import { unpricedModelsCheck } from "../doctor.js";
import { clearScanMemo } from "../scan.js";
import { MODIFIER_SESSION, MODIFIER_SESSION_USD, MODIFIER_USD, writeModifierSession } from "./modifier-fixture.js";
import { withSandboxHome } from "./sandbox.js";

const DAY = 86_400_000;
const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);

/** `fn` in a throwaway home, cache and clock. */
async function inHome<T>(now: number, fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "cd-modifiers-"));
  const real = Date.now;
  const saved = process.env.CONTEXT_DOCTOR_CACHE_DIR;
  process.env.CONTEXT_DOCTOR_CACHE_DIR = join(home, ".cache-cd");
  Date.now = () => now;
  clearScanMemo();
  try {
    return await withSandboxHome(home, () => fn(home));
  } finally {
    Date.now = real;
    if (saved === undefined) delete process.env.CONTEXT_DOCTOR_CACHE_DIR;
    else process.env.CONTEXT_DOCTOR_CACHE_DIR = saved;
    clearScanMemo();
    rmSync(home, { recursive: true, force: true });
  }
}

// A Wednesday: the budget's week holds the session in every time zone.
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

test("one session with every modifier: spend, limits, the budget, the session price and savings agree, by hand", async () => {
  await inHome(NOW, async (home) => {
    const path = writeModifierSession(home, NOW - 2 * 3_600_000);
    const since = NOW - 7 * DAY;
    const items = claudeSpend(since, NOW, [path]);
    assert.equal(items.length, 12, "each reply once, the streamed one too");
    const total = items.reduce((s, it) => s + it.usd, 0);
    near(total, MODIFIER_SESSION_USD, "spend");
    // Each request's own modifiers.
    const fast = items.find((it) => it.modifiers?.fastUsd)!;
    near(fast.usd, MODIFIER_USD.fast, "the fast-mode reply, its output settled on its second row");
    near(fast.modifiers!.fastUsd, MODIFIER_USD.fast - MODIFIER_USD.fastList, "fast mode's part");
    near(items.find((it) => it.modifiers?.geoUsd)!.modifiers!.geoUsd, MODIFIER_USD.geoList * 0.1, "US-only's part");
    near(items.find((it) => it.modifiers?.longUsd)!.modifiers!.longUsd, MODIFIER_USD.long - MODIFIER_USD.longList, "the long-prompt tier's part");
    const search = items.find((it) => it.modifiers?.webSearches)!;
    assert.equal(search.modifiers!.webSearches, 2);
    near(search.usd, MODIFIER_USD.searchTokens + MODIFIER_USD.searches, "tokens and searches");
    near(search.inputUsd + search.writeUsd + search.readUsd + search.outputUsd, MODIFIER_USD.searchTokens, "the searches are not a token part");
    assert.equal(items.filter((it) => it.modifiers).length, 4, "the plain requests carry none");

    // The report: totals and the line naming what the modifiers added.
    const r = summarizeSpend(items, 7, since, NOW);
    near(r.usd, MODIFIER_SESSION_USD, "report");
    near(r.parts.inputUsd + r.parts.writeUsd + r.parts.readUsd + r.parts.outputUsd + (r.parts.webSearchUsd ?? 0), r.usd, "the parts add up");
    near(r.modifiers!.fastUsd + r.modifiers!.geoUsd + r.modifiers!.longUsd, MODIFIER_USD.fast - MODIFIER_USD.fastList + MODIFIER_USD.geoList * 0.1 + MODIFIER_USD.long - MODIFIER_USD.longList, "modifiers");
    const text = renderSpend(r);
    assert.match(text, /Of it, billed above list rates: fast mode \+\$0\.07, US-only \+<\$0\.01, web searches \$0\.02 \(2\), long-prompt tier \+\$0\.01/);
    assert.match(text, /web searches \$0\.02 \(\d+%\)/);
    assert.match(renderSpendShare(r), /^Billed above list rates: fast mode \+\$0\.07, US-only \+<\$0\.01, web searches \$0\.02 \(2\), long-prompt tier \+\$0\.01\.$/m);
    // What the dollars are, said alike in the heading and --share: each request as billed, at list rates (not "list prices",
    // which the modifiers above them are not); the closing line names no prices it would contradict.
    assert.match(text, /^Last 7 days, as billed at list rates$/m);
    assert.match(renderSpendShare(r), /^My AI coding, last 7 days, as billed at list rates: \$/m);
    assert.doesNotMatch(text + renderSpendShare(r), /list prices/i);
    assert.deepEqual(JSON.parse(JSON.stringify(r)).modifiers.webSearches, 2);

    // limits' usage points (its fit is in dollars).
    near(claudeUsage(since, NOW, [path]).reduce((s, p) => s + p.usd, 0), MODIFIER_SESSION_USD, "limits");
    // The budget's ledger, read in full and then again from where it stopped.
    near(periodSpend("week", NOW, home).usd, MODIFIER_SESSION_USD, "budget");
    near(periodSpend("week", NOW, home).usd, MODIFIER_SESSION_USD, "budget, warm");
    // The session price (its own ledger, read without the scan).
    const due = sessionPriceDue({ sessionId: MODIFIER_SESSION, transcript: path }, NOW, { CONTEXT_DOCTOR_SESSION_PRICE: "0.10" });
    near(due!.usd, MODIFIER_SESSION_USD, "session price");
    // The next message re-reads the last request's 104k context at Opus 5.5's read rate.
    near(due!.readUsd!, (104_010 * 0.2) / 1e6, "per message");
    // savings bills the main conversation's prompts: spend's, less output and the searches.
    const s = estimateSavings(7, {}, [path], undefined, false).sessions[0];
    near(s.billedUsd, items.reduce((n, it) => n + it.inputUsd + it.writeUsd + it.readUsd, 0), "savings");
  });
});

/** A Codex rollout on `model`: one request, 100k in (40k cached) and 1k out, at `at`. */
function rollout(home: string, at: number, model: string): string {
  const d = new Date(at);
  const dir = join(home, ".codex", "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  const iso = (t: number) => new Date(t).toISOString();
  const rows = [
    { timestamp: iso(at - 1_000), type: "session_meta", payload: { id: "019f0000-0000-7000-8000-00000000c0de", cwd: "/Users/me/tech/app" } },
    { timestamp: iso(at - 500), type: "turn_context", payload: { cwd: "/Users/me/tech/app", model } },
    { timestamp: iso(at), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100_000, cached_input_tokens: 40_000, output_tokens: 1_000, total_tokens: 101_000 }, last_token_usage: { input_tokens: 100_000, cached_input_tokens: 40_000, output_tokens: 1_000, total_tokens: 101_000 } } } },
  ];
  const path = join(dir, `rollout-${iso(at).slice(0, 19).replace(/:/g, "-")}-019f0000-0000-7000-8000-00000000c0de.jsonl`);
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  utimesSync(path, at / 1000, at / 1000);
  return path;
}

test("a price that ends on a day, with the clock either side: spend, the budget and doctor say it changed", async () => {
  // gpt-5.6-sol's $4 / $20 / $0.40 promotion runs "until November 30, 2026": 60k uncached, 40k read, 1k out.
  const SOL = (60_000 * 4 + 40_000 * 0.4 + 1_000 * 20) / 1e6;
  for (const [now, changed] of [[Date.UTC(2026, 10, 30, 12), false], [Date.UTC(2026, 11, 1, 12), true]] as const) {
    await inHome(now, (home) => {
      const path = rollout(home, now - 3_600_000, "gpt-5.6-sol");
      const items = codexFileSpend(path, now - DAY, now);
      assert.equal(items.length, 1);
      near(items[0].usd, SOL, "the last known price either way: the page names none after it");
      assert.equal(items[0].changedOn, changed ? "2026-12-01" : undefined);
      const r = summarizeSpend(items, 1, now - DAY, now);
      const text = renderSpend(r);
      const said = /gpt-5\.6-sol: price changed on 2026-12-01; a newer context-doctor knows the new one/;
      if (changed) {
        assert.match(text, /1 request \(\$0\.28\) priced past the day its model's price changed, an estimate:/);
        assert.match(text, said);
        assert.match(text, /gpt-5\.6-sol .*estimate: price changed 2026-12-01/);
        assert.match(renderSpendShare(r), /priced past the day their price changed, an estimate/);
        assert.equal(r.tools[0].estimated, undefined, "not a family estimate");
      } else {
        assert.doesNotMatch(text, /price changed/);
        assert.equal(r.priceChanged, undefined);
      }
      // The budget's ledger keeps which requests and says so.
      const p = periodSpend("day", now, home);
      near(p.usd, SOL, "budget");
      const b: Budget = { usd: 50, period: "day", block: false, at: now };
      const status = renderBudgetStatus(b, p, true);
      if (changed) assert.match(status, said);
      else assert.doesNotMatch(status, /price changed/);
      // doctor names the model whose price changed in the period.
      const check = unpricedModelsCheck(30, now, home)!;
      if (changed) {
        assert.equal(check.status, "warn");
        assert.match(check.detail, said);
      } else assert.equal(check.status, "ok");
    });
  }
});
