/** cache-misses: warm requests that re-wrote the cache, by the definition in cachemisses.ts, priced and attributed. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheMisses, cacheMissesLine, cacheMissesSignificant, renderCacheMisses } from "../cachemisses.js";

const T0 = Date.parse("2026-10-19T10:00:00Z");
let n = 0;
/** One assistant reply row with usage: `read` from cache, `write` to it. */
function reply(at: number, model: string, read: number, write: number, extra: Record<string, unknown> = {}, oneHour = false) {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(at).toISOString(),
    isSidechain: false,
    message: {
      id: `msg_${n++}`,
      role: "assistant",
      model,
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: oneHour ? 0 : write, ephemeral_1h_input_tokens: oneHour ? write : 0 } },
    },
    ...extra,
  });
}
const user = (at: number) => JSON.stringify({ type: "user", timestamp: new Date(at).toISOString(), message: { role: "user", content: "next" } });
const s = (sec: number) => T0 + sec * 1000;

function transcript(rows: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cd-misses-"));
  const p = join(dir, "s.jsonl");
  writeFileSync(p, rows.join("\n") + "\n");
  return p;
}

test("a warm request that re-writes the context is a miss; reads, cold gaps, compactions and small contexts are not", () => {
  const M = "claude-opus-5-5";
  const p = transcript([
    reply(s(0), M, 0, 100_000), // first: nothing to compare
    user(s(10)),
    reply(s(20), M, 100_000, 2_000), // warm read: normal
    reply(s(40), M, 0, 102_000), // warm, wrote it all again: MISS (nothing visible)
    reply(s(40 + 400), M, 0, 102_000), // 400 s later: past the 5-minute TTL, cold, not eligible
    JSON.stringify({ type: "system", subtype: "compact_boundary" }),
    reply(s(450), M, 0, 30_000), // after a compaction: not eligible
    reply(s(460), "claude-sonnet-5", 0, 31_000), // model switch: MISS (model switch)
    reply(s(470), "claude-sonnet-5", 0, 5_000), // previous context 31k, wrote 5k: normal
  ]);
  const r = cacheMisses(30, [p]);
  assert.equal(r.misses, 2);
  assert.equal(r.eligible, 4);
  assert.equal(r.causes["nothing visible"], 1);
  assert.equal(r.causes["model switch"], 1);
  // Priced above cache reads: min(write, previous context) at 1.25x input minus the read rate.
  const opus = r.byModel.find((m) => m.model === M)!;
  assert.equal(opus.misses, 1);
  assert.ok(Math.abs(opus.extraUsd - (102_000 * (4 * 1.25 - 0.2)) / 1e6) < 1e-9, String(opus.extraUsd));
  assert.ok(r.cacheWriteUsd > 0);
});

test("the 1-hour TTL keeps a request warm for an hour; sidechains and repeated rows of one reply are skipped", () => {
  const M = "claude-fable-5-1";
  const first = reply(s(0), M, 0, 50_000, {}, true);
  const p = transcript([
    first,
    first.replace('"text":"ok"', '"text":"second block of the same reply"'), // same id: counted once
    reply(s(5), M, 0, 999_999, { isSidechain: true }), // a subagent's own cache: ignored
    reply(s(1200), M, 0, 50_100, {}, true), // 20 min later on the 1 h TTL: still warm, MISS
  ]);
  const r = cacheMisses(30, [p]);
  assert.equal(r.eligible, 1);
  assert.equal(r.misses, 1);
  assert.equal(r.largest[0].gapSeconds, 1200);
});

test("requests before the window are context, not counted", () => {
  const M = "claude-opus-5-5";
  const old = Date.now() - 40 * 86_400_000;
  const p = transcript([reply(old, M, 0, 80_000), reply(old + 10_000, M, 0, 80_500), reply(Date.now() - 1000, M, 0, 80_000)]);
  const r = cacheMisses(30, [p]);
  assert.equal(r.misses, 0, "the old miss is outside the window");
  assert.equal(r.requests, 1);
});

test("recommendations name the version with fewer misses only when the data supports it", () => {
  const rows: string[] = [];
  let t = s(0);
  // 300 warm requests on each of two Opus versions: 1 miss on 5.5, 30 on 4.8.
  for (const [model, missEvery] of [["claude-opus-5-5", 300], ["claude-opus-4-8", 10]] as const) {
    rows.push(reply((t += 30_000), model, 0, 60_000));
    for (let i = 1; i <= 300; i++) {
      const miss = i % missEvery === 0;
      rows.push(reply((t += 30_000), model, miss ? 0 : 60_000, miss ? 60_010 : 10));
    }
    t += 3_600_000;
  }
  const r = cacheMisses(30, [transcript(rows)]);
  assert.equal(r.byModel.find((m) => m.model === "claude-opus-4-8")!.misses, 30);
  assert.ok(r.recommendations.some((x) => /Prefer claude-opus-5-5 where you choose the Opus version/.test(x)), r.recommendations.join("\n"));
  const out = renderCacheMisses(r);
  assert.match(out, /claude-opus-4-8\s+30\/300\s+10\.0%/);
  assert.ok(cacheMissesSignificant(r));
  assert.match(cacheMissesLine(r).join(" "), /^Also: 31 cache misses within the cache lifetime cost \$\d/);

  // Too little data: no advice.
  const few = cacheMisses(30, [transcript(rows.slice(0, 40))]);
  assert.deepEqual(few.recommendations, []);
});

/** A session on one Claude Code version: `n` warm requests a minute apart over a growing context. */
function versionSession(version: string, opts: { n: number; first: number; oneHour: boolean; missEvery?: number; model?: string; start: number }): string[] {
  const rows = [JSON.stringify({ type: "user", timestamp: new Date(opts.start).toISOString(), version, message: { role: "user", content: "start the task" } })];
  let ctx = opts.first;
  for (let i = 0; i < opts.n; i++) {
    const at = opts.start + i * 60_000 + 1000;
    const miss = i > 0 && opts.missEvery !== undefined && i % opts.missEvery === 0;
    const write = i === 0 ? opts.first : miss ? ctx + 500 : 500;
    const read = i === 0 ? 0 : miss ? 0 : ctx;
    rows.push(JSON.stringify({
      type: "assistant", timestamp: new Date(at).toISOString(), version, uuid: `${version}-${opts.start}-${i}`, isSidechain: false,
      message: { id: `m-${version}-${opts.start}-${i}`, role: "assistant", model: opts.model ?? "claude-opus-5-5", content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 2, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: opts.oneHour ? 0 : write, ephemeral_1h_input_tokens: opts.oneHour ? write : 0 } } },
    }));
    ctx = read + write + 2;
  }
  return rows;
}

test("by Claude Code version: a fall in 1-hour writes, a bigger first request and a miss spike are flagged; thin versions are not", () => {
  const start = Date.now() - 5 * 86_400_000;
  const paths: string[] = [];
  // 2.1.300: 1-hour writes, 30k first requests, no misses. 2.1.301: 5-minute writes, 40k, a miss every 10th request.
  for (let s = 0; s < 6; s++) paths.push(transcript(versionSession("2.1.300", { n: 40, first: 30_000, oneHour: true, start: start + s * 3_600_000 })));
  for (let s = 0; s < 6; s++) paths.push(transcript(versionSession("2.1.301", { n: 40, first: 40_000, oneHour: false, missEvery: 10, start: start + 86_400_000 + s * 3_600_000 })));
  // 2.1.302: too little to compare.
  paths.push(transcript(versionSession("2.1.302", { n: 10, first: 90_000, oneHour: true, start: start + 2 * 86_400_000 })));
  const r = cacheMisses(30, paths);
  assert.deepEqual(r.byVersion.map((v) => v.version), ["2.1.300", "2.1.301", "2.1.302"]);
  const [a, b] = r.byVersion;
  assert.equal(a.oneHourShare, 1);
  assert.equal(b.oneHourShare, 0);
  assert.equal(a.firstMedian !== undefined && Math.abs(a.firstMedian - 30_000) < 100, true, String(a.firstMedian));
  assert.equal(b.firstRequests, 6);
  assert.ok(b.missRate > 0.05 && a.missRate === 0);
  const metrics = r.regressions.map((g) => g.metric).sort();
  assert.deepEqual(metrics, ["1-hour cache share", "first request", "miss rate"]);
  assert.ok(r.regressions.every((g) => g.from === "2.1.300" && g.to === "2.1.301"), "the thin 2.1.302 is not compared");
  const text = renderCacheMisses(r);
  assert.match(text, /By Claude Code version/);
  assert.match(text, /1-hour TTL went from 100% on 2\.1\.300 to 0% on 2\.1\.301/);
  assert.match(text, /claude-opus-5-5 the cache missed on/);
});

// -- N3: re-writes that came just too late, and loops on the TTL ----------

test("a request less than 25% past the TTL that re-writes is late; later ones and reads are not", () => {
  const M = "claude-opus-5-5";
  const p = transcript([
    reply(s(0), M, 0, 100_000, {}, true), // 1-hour entry
    reply(s(3700), M, 0, 101_000, {}, true), // 100 s past the hour: LATE
    reply(s(3700 + 3600 * 2), M, 0, 102_000, {}, true), // two hours later: just cold, not late
    reply(s(3700 + 7200 + 320), M, 102_000, 500), // 5:20 later but read it (the 1-hour entry): not late
    reply(s(3700 + 7200 + 320 + 10), M, 0, 50_000), // a 5-minute entry...
    reply(s(3700 + 7200 + 320 + 10 + 330), M, 0, 52_000), // ...missed by 30 s: LATE
  ]);
  const r = cacheMisses(30, [p]);
  assert.equal(r.late.rewrites, 2);
  assert.equal(r.late.tokens, 101_000 + 52_000);
  assert.equal(r.late.largest[0].ttlSeconds, 3600);
  assert.equal(r.late.largest[0].gapSeconds, 3700);
  // 100k (the previous context) at the 1-hour rate minus a read: 100k x (2 x $4 - $0.20).
  assert.ok(Math.abs((r.late.largest[0].extraUsd ?? 0) - (100_010 * 7.8) / 1e6) < 1e-6, String(r.late.largest[0].extraUsd));
  assert.equal(r.late.loops.length, 0, "two different TTLs and gaps are not a loop");
  assert.match(renderCacheMisses(r), /Just too late: 2 requests/);
});

test("three or more wake-ups at a regular interval just past the TTL are a loop, with the interval to use", () => {
  const M = "claude-opus-5-5";
  const rows = [reply(s(0), M, 0, 200_000, {}, true)];
  let t = 0;
  // An agent waking every 61-62 minutes on a 1-hour cache (anthropics/claude-code#104736).
  for (const gap of [3660, 3720, 3690, 3700]) {
    t += gap;
    rows.push(reply(s(t), M, 0, 200_000 + t, {}, true));
  }
  const r = cacheMisses(30, [transcript(rows)]);
  assert.equal(r.late.rewrites, 4);
  assert.equal(r.late.loops.length, 1);
  assert.equal(r.late.loops[0].rewrites, 4);
  assert.equal(r.late.loops[0].ttlSeconds, 3600);
  const text = renderCacheMisses(r);
  assert.match(text, /A loop: 4 wake-ups every ~62 min on a 1-hour cache/);
  assert.match(text, /Wake every 54 min \(3240s\)/);
  // A person back after a break now and then is not a loop.
  const irregular = [reply(s(0), M, 0, 200_000, {}, true)];
  t = 0;
  for (const gap of [3650, 4400, 3610]) {
    t += gap;
    irregular.push(reply(s(t), M, 0, 200_000, {}, true));
  }
  assert.equal(cacheMisses(30, [transcript(irregular)]).late.loops.length, 0);
});

test("a model switch past the TTL is the switch's cost, not lateness; no late re-writes, no section", () => {
  const p = transcript([reply(s(0), "claude-opus-5-5", 0, 100_000), reply(s(320), "claude-sonnet-5", 0, 100_000)]);
  const r = cacheMisses(30, [p]);
  assert.equal(r.late.rewrites, 0);
  assert.ok(!renderCacheMisses(r).includes("Just too late"));
});

test("QA: a person back at 61, 67 and 73 minutes is not a loop; a loop broken by another cold start is two runs", () => {
  const M = "claude-opus-5-5";
  const rows = [reply(s(0), M, 0, 200_000, {}, true)];
  let t = 0;
  for (const gapMin of [61, 67, 73]) {
    t += 30;
    rows.push(reply(s(t), M, 200_000, 2_000, {}, true)); // a warm turn
    t += gapMin * 60;
    rows.push(reply(s(t), M, 0, 202_000, {}, true)); // back: re-written
  }
  const human = cacheMisses(30, [transcript(rows)]);
  assert.equal(human.late.rewrites, 3);
  assert.equal(human.late.loops.length, 0);

  // 61-minute wake-ups, but a two-hour pause (a cold start that is not late) between the second and third.
  const broken = [reply(s(0), M, 0, 200_000, {}, true)];
  t = 0;
  for (const gap of [3660, 3670, 7200, 3665, 3660]) {
    t += gap;
    broken.push(reply(s(t), M, 0, 200_000, {}, true));
  }
  const r = cacheMisses(30, [transcript(broken)]);
  assert.equal(r.late.rewrites, 4);
  assert.equal(r.late.loops.length, 0, "two runs of two, not one loop of four");
});
