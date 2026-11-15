/**
 * Cold returns replayed three ways (coldreturns.ts): as billed, compacted on
 * return, kept warm by a cache read every 55 minutes (4.5 on a 5-minute
 * cache); the keep-warm caps priced with every ping a timer would send; and
 * #107157's re-added compacted segment. Prices: Opus 5.5 $4 in, $0.20 cache
 * read, $20 out; Sonnet 5 $2, $0.20, $10; 1-hour writes at 2x input.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coldReturns, coldReturnsInTranscript, keepWarmPolicy, pingsIn, renderColdReturns, PING_EVERY_1H_MS, PING_EVERY_5M_MS } from "../coldreturns.js";
import { coldResumeEvents } from "../coldresume.js";
import { requestCost } from "../pricing.js";
process.env.CONTEXT_DOCTOR_NO_CACHE = "1";
const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-09-01T10:00:00Z");
const NOW = T0 + 3 * 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
/** One assistant reply per request, with the user row after it; boundaries as Claude Code writes them. */
function rows(reqs, ttl, tag) {
    const out = [{ type: "user", uuid: `${tag}-u`, timestamp: iso(reqs[0].at - 1000), message: { role: "user", content: "go" } }];
    reqs.forEach((r, i) => {
        if ("boundary" in r) {
            out.push({ type: "system", subtype: "compact_boundary", uuid: r.boundary, timestamp: iso(r.at), content: "Conversation compacted", compactMetadata: { trigger: "manual" } });
            return;
        }
        const write = Math.min(r.write, r.prompt - 5);
        const usage = {
            input_tokens: 5, cache_read_input_tokens: r.prompt - 5 - write, cache_creation_input_tokens: write, output_tokens: 10,
            cache_creation: { ephemeral_5m_input_tokens: ttl === "5m" ? write : 0, ephemeral_1h_input_tokens: ttl === "1h" ? write : 0 },
        };
        out.push({ type: "assistant", uuid: `${tag}-a${i}`, timestamp: iso(r.at), message: { id: `${tag}-m${i}`, model: r.model ?? "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "ok" }], usage } });
        out.push({ type: "user", uuid: `${tag}-n${i}`, timestamp: iso(r.at + 1000), message: { role: "user", content: "next" } });
    });
    return out;
}
const dir = mkdtempSync(join(tmpdir(), "cd-coldreturns-"));
function write(name, lines) {
    const p = join(dir, `${name}.jsonl`);
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return p;
}
// A: 1-hour cache. Back after 3 hours (cold), after 30 minutes (warm), after 10 hours on another model (cold).
const a = write("a", rows([
    { at: T0, prompt: 200_000, write: 200_000 },
    { at: T0 + 2 * MIN, prompt: 210_000, write: 10_000 },
    { at: T0 + 2 * MIN + 3 * HOUR, prompt: 215_000, write: 215_000 },
    { at: T0 + 4 * MIN + 3 * HOUR, prompt: 220_000, write: 5_000 },
    { at: T0 + 34 * MIN + 3 * HOUR, prompt: 225_000, write: 5_000 },
    { at: T0 + 34 * MIN + 13 * HOUR, prompt: 230_000, write: 230_000, model: "claude-sonnet-5" },
], "1h", "a"));
// B: 5-minute cache, back after 20 minutes.
const T1 = T0 + 86_400_000;
const b = write("b", rows([
    { at: T1, prompt: 100_000, write: 100_000 },
    { at: T1 + 20 * MIN, prompt: 105_000, write: 105_000 },
], "5m", "b"));
// C: #107157. A compaction, then a copy of its boundary (same uuid), then a resume 12 hours on rebuilds 70k into 400k.
const T2 = T0 + 30 * HOUR;
const c = write("c", rows([
    { at: T2, prompt: 390_000, write: 390_000 },
    { boundary: "c-b1", at: T2 + MIN },
    { at: T2 + 2 * MIN, prompt: 60_000, write: 60_000 },
    { at: T2 + 4 * MIN, prompt: 70_000, write: 10_000 },
    { boundary: "c-b1", at: T2 + MIN },
    { at: T2 + 12 * HOUR, prompt: 400_000, write: 395_000 },
], "1h", "c"));
// D: #102559's benign copy: a real compaction follows it, nothing grows.
const d = write("d", rows([
    { at: T2, prompt: 100_000, write: 100_000 },
    { boundary: "d-b1", at: T2 + MIN },
    { at: T2 + 2 * MIN, prompt: 50_000, write: 50_000 },
    { boundary: "d-b1", at: T2 + MIN },
    { boundary: "d-b2", at: T2 + 3 * MIN },
    { at: T2 + 4 * MIN, prompt: 280_000, write: 230_000 },
], "1h", "d"));
const usageOf = (prompt, write, ttl = "1h") => {
    const w = Math.min(write, prompt - 5);
    return { input_tokens: 5, cache_read_input_tokens: prompt - 5 - w, cache_creation_input_tokens: w, output_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: ttl === "5m" ? w : 0, ephemeral_1h_input_tokens: ttl === "1h" ? w : 0 } };
};
const ping = (ctx, inUsd, readUsd, outUsd) => (ctx * readUsd + 30 * inUsd + 100 * outUsd) / 1e6;
test("pings: one every 55 minutes on a 1-hour cache, every 4.5 on a 5-minute one, until the return", () => {
    assert.equal(pingsIn(50 * MIN, PING_EVERY_1H_MS), 0);
    assert.equal(pingsIn(3 * HOUR, PING_EVERY_1H_MS), 3);
    assert.equal(pingsIn(10 * HOUR, PING_EVERY_1H_MS), 10);
    assert.equal(pingsIn(20 * MIN, PING_EVERY_5M_MS), 4);
});
test("as it went is the bill; kept warm drops the re-write and adds the pings; a model switch avoids nothing", () => {
    const { returns } = coldReturnsInTranscript(a, 0, NOW);
    assert.equal(returns.length, 2, "the 30-minute gap is warm, not a return");
    const [r1, r2] = returns;
    const billed1 = requestCost("claude-opus-5-5", usageOf(215_000, 215_000), r1.at).totalUsd;
    assert.ok(close(r1.billedUsd, billed1), `as billed: ${r1.billedUsd} vs ${billed1}`);
    assert.ok(close(billed1, (5 * 4 + 214_995 * 8 + 10 * 20) / 1e6));
    assert.ok(close(r1.rewriteUsd, (210_000 * (8 - 0.2)) / 1e6), `the previous context, written instead of read: ${r1.rewriteUsd}`);
    assert.equal(r1.pings, 3);
    assert.ok(close(r1.pingUsd, ping(210_000, 4, 0.2, 20)));
    assert.ok(close(r1.keptWarmUsd, billed1 - r1.rewriteUsd + 3 * ping(210_000, 4, 0.2, 20)));
    // The return on Sonnet 5 misses Opus's cache however warm it was kept.
    assert.equal(r2.sameModel, false);
    assert.equal(r2.pings, 10);
    assert.ok(close(r2.keptWarmUsd, r2.billedUsd + 10 * ping(225_000, 4, 0.2, 20)));
    // Compacted on return: the cold-resume replay's own net, for the same request.
    const net = new Map(coldResumeEvents(a).map((e) => [e.at, e.netUsd]));
    assert.ok(close(r1.compactedUsd, r1.billedUsd - net.get(r1.at)));
    assert.ok(close(r2.compactedUsd, r2.billedUsd - net.get(r2.at)));
});
test("a 5-minute cache: the return after 20 minutes, kept warm by 4 pings", () => {
    const { returns } = coldReturnsInTranscript(b, 0, NOW);
    assert.equal(returns.length, 1);
    assert.equal(returns[0].ttlMs, 5 * MIN);
    assert.equal(returns[0].pings, 4);
    // 5-minute writes at 1.25x input.
    assert.ok(close(returns[0].rewriteUsd, (100_000 * (5 - 0.2)) / 1e6));
    assert.equal(returns[0].compactedUsd, undefined, "under 150k: no compaction offered");
});
test("#107157: a copied boundary is no compaction, and the jump after it is priced", () => {
    const { returns, readded } = coldReturnsInTranscript(c, 0, NOW);
    assert.equal(readded.length, 1);
    const x = readded[0];
    assert.equal(x.fromTokens, 70_000);
    assert.equal(x.toTokens, 400_000);
    assert.ok(close(x.extraWriteUsd, (330_000 * 8) / 1e6), `the jump written at 2x: ${x.extraWriteUsd}`);
    assert.ok(close(x.perRequestUsd, (330_000 * 0.2) / 1e6));
    // The copy did not end the pause: the resume is a cold return too.
    assert.equal(returns.length, 1);
    assert.equal(returns[0].contextTokens, 70_000);
    // #102559's copy, followed by a real compaction: nothing re-added.
    assert.equal(coldReturnsInTranscript(d, 0, NOW).readded.length, 0);
});
test("keep-warm caps: pings for every pause and the sessions never returned to; a return past the cap is cold anyway", () => {
    const { pauses } = coldReturnsInTranscript(a, 0, NOW);
    const two = keepWarmPolicy(pauses, 2);
    const four = keepWarmPolicy(pauses, 4);
    // 2 h: two pings into the 3-hour pause (cold anyway), two into the 10-hour one, two after the last request.
    assert.equal(two.pings, 6);
    assert.equal(two.keptWarm, 0);
    assert.equal(two.avoidedUsd, 0);
    // 4 h: the 3-hour pause kept warm (its 3 pings), 4 into the 10-hour one, 4 after the last.
    assert.equal(four.pings, 11);
    assert.equal(four.keptWarm, 1);
    assert.ok(close(four.avoidedUsd, (210_000 * 7.8) / 1e6));
    const pingA = ping(210_000, 4, 0.2, 20), pingB = ping(225_000, 4, 0.2, 20), pingS = ping(230_000, 2, 0.2, 10);
    assert.ok(close(four.pingUsd, 3 * pingA + 4 * pingB + 4 * pingS), `${four.pingUsd}`);
    assert.ok(close(four.netUsd, four.avoidedUsd - four.pingUsd));
});
test("golden: the cache-misses section on the fixture returns", () => {
    const r = coldReturns(30, [a, b, c, d], NOW);
    assert.ok(close(r.billedUsd, r.byGap.reduce((n, g) => n + g.asItWentUsd, 0)), "the buckets add up to the bill");
    const want = `COLD RETURNS: BACK AFTER THE CACHE EXPIRED
────────────────────────────────────────────────────────────
4 returns to a conversation after its cache expired wrote the
context again: $6.33 billed, $3.52 of it above cache-read price.

Each return three ways, by how long you were away:
  away   returns  as it went  compacted  kept warm  cheapest
  <1h          1       $0.53      $0.53      $0.13  kept warm
  2-4h         1       $1.72      $2.22      $0.21  kept warm
  >8h          2       $4.08      $4.39      $4.22  as it went
  all          4       $6.33      $7.13      $4.56  kept warm
As it went: the returns as billed. Compacted: /compact right after the
return, net of the compaction, with what it saves on the requests after it
until the next return (offered over 150k tokens). Kept warm: a cache read of
the whole context every 55 min while away (4.5 min on a 5-minute cache) and
~100 output tokens each, so the return reads it instead of writing it.
Each alone; the replay knows the gap, which a timer does not.

Keeping warm without knowing when you come back, for up to:
  1 h      23 pings    $0.68, 1 return kept warm      $0.48, net -$0.20
  2 h      42 pings    $1.28, 1 return kept warm      $0.48, net -$0.80
  4 h      80 pings    $2.45, 2 returns kept warm     $2.12, net -$0.33
  8 h     153 pings    $4.68, 2 returns kept warm     $2.12, net -$2.56
Pings count every pause past 55 minutes (4.5 on a 5-minute cache), the
returns after the cap (cold anyway) and the sessions never returned to.
No cap nets a saving on your history: the pings would cost more than the
re-writes they avoid.

A compacted segment put back (anthropics/claude-code#107157): 1 time the
transcript held a copy of history a compaction had removed, and the context
jumped after it (worst ~70k to ~400k tokens): $2.64 written to the cache again,
and each later request re-reads it (~$0.07 each in the worst).
/compact again only summarizes it again: start a new session from a handoff
(context-doctor handoff) or /clear.
  2026-09-03 04:00  ~70k to ~400k, $2.64  c.jsonl`;
    assert.equal(renderColdReturns(r).join("\n"), want);
});
test("nothing to say: no cold return, no copy", () => {
    const p = write("quiet", rows([{ at: T0, prompt: 50_000, write: 50_000 }, { at: T0 + MIN, prompt: 52_000, write: 2_000 }], "1h", "q"));
    const r = coldReturns(30, [p], T0 + 2 * MIN);
    assert.equal(r.returns, 0);
    assert.deepEqual(renderColdReturns(r), []);
});
