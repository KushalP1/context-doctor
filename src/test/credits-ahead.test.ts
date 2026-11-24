/**
 * What running out early would cost, before it does (ROADMAP H2): with
 * extra usage on and the weekly limit running out before its reset at the
 * recent pace, `limits` and `budget` say about how many dollars the hours
 * from the run-out to the reset would go on usage credits (hours times the
 * last 24 hours' dollars an hour, at list prices). Nothing with extra usage
 * off, held back, or a pace that lasts; nothing in the hook.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { creditsAhead, creditsAheadLine } from "../credits.js";
import type { WindowStatus } from "../limits.js";
import { frozenClock } from "./history-fixture.js";
import { cleanEnv } from "./golden-run.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const HOUR = 3_600_000, DAY = 24 * HOUR;
/** Wednesday 2026-10-14, 15:00 UTC (the tests run with TZ=UTC). */
const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
/** The weekly window resets Saturday 15:00: 72 hours away. */
const RESET = NOW + 3 * DAY;

const status = (over: Partial<WindowStatus> = {}): WindowStatus => ({
  window: "seven_day", label: "Claude weekly", app: "claude", pct: 64, at: NOW, resetsAt: RESET, resetSince: false, readings: 30,
  recentPerHour: 1, averagePerHour: 64 / 96, runsOutAt: NOW + 36 * HOUR, beforeReset: true, ...over,
});
/** 24 requests an hour apart over the last day, $0.20 each: $0.20 an hour. */
const day = (model = "claude-fable-5-2") => Array.from({ length: 24 }, (_, i) => ({ ts: NOW - i * HOUR, usd: 0.2, model }));
const ON = { enabled: true, disabledReason: null };

test("the hours from the run-out to the reset, at the last day's dollars an hour: $7.20 by hand", () => {
  const a = creditsAhead(status(), ON, day(), NOW)!;
  assert.ok(a, "on pace to run out with extra usage on");
  // 36 hours (run-out at +36 h, reset at +72 h) times $4.80 / 24 h.
  assert.equal(a.hours, 36);
  assert.equal(a.usdPerHour.toFixed(4), "0.2000");
  assert.equal(a.usd.toFixed(2), "7.20");
  assert.equal(a.model, "claude-fable-5-2");
  // At the window's average (64% over 96 h) it runs out too: 54 h from now, still before the reset.
  assert.equal(a.averageLasts, false);
  // Local time: this process's time zone is the machine's (the CLI runs below are in UTC).
  assert.match(creditsAheadLine(a, NOW), /^Extra usage is on: at this pace your weekly limit runs out on \w{3}, Oct 1[56] at \d\d:\d\d, 36 hours before it resets, and Claude Code would keep working on usage credits until then: about \$7\.20 at API list prices \(an estimate\), at your last 24 hours' \$0\.20 an hour, mostly Fable 5\.2\. At this week's average pace \(0\.67% an hour\) it runs out before the reset too\.$/);
  // An average that lasts is said to.
  assert.match(creditsAheadLine(creditsAhead(status({ averagePerHour: 0.3 }), ON, day(), NOW)!, NOW), /At this week's average pace \(0\.30% an hour\) it lasts until the reset\.$/);
  // A run-out already past (the reading is from before now) counts from now.
  assert.equal(creditsAhead(status({ runsOutAt: NOW - HOUR }), ON, day(), NOW)!.hours, 72);
  // No model with most of the dollars: none named.
  const split = [...day("claude-opus-5-5").slice(0, 12), ...day("claude-fable-5-2").slice(12), { ts: NOW - 30 * 60_000, usd: 0.2, model: "claude-sonnet-5-5" }];
  assert.equal(creditsAhead(status(), ON, split, NOW)!.model, undefined);
});

test("nothing when extra usage is off or held back, the pace lasts, the reading is stale, or nothing was spent", () => {
  assert.equal(creditsAhead(status(), { enabled: false }, day(), NOW), undefined);
  assert.equal(creditsAhead(status(), undefined, day(), NOW), undefined);
  assert.equal(creditsAhead(status(), { enabled: true, disabledReason: "out_of_credits" }, day(), NOW), undefined);
  assert.ok(creditsAhead(status(), { enabled: true, disabledReason: "fetch_error" }, day(), NOW), "a failed fetch says nothing against credits");
  assert.equal(creditsAhead(status({ runsOutAt: RESET + HOUR, beforeReset: false }), ON, day(), NOW), undefined);
  assert.equal(creditsAhead(status({ stale: true }), ON, day(), NOW), undefined);
  assert.equal(creditsAhead(status({ window: "five_hour" }), ON, day(), NOW), undefined);
  assert.equal(creditsAhead(status(), ON, [], NOW), undefined);
  assert.equal(creditsAhead(status(), ON, day().map((p) => ({ ...p, ts: p.ts - 2 * DAY })), NOW), undefined, "dollars older than a day do not set the pace");
});

/** A throwaway home: a day of $0.20 replies (100k uncached input on claude-sonnet-5 at $2 / 1M), a weekly ledger, `~/.claude.json`. */
function setup(o: { extra?: boolean; to?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "cd-ahead-"));
  const cache = mkdtempSync(join(tmpdir(), "cd-ahead-cache-"));
  const transcript = join(home, ".claude", "projects", "-work-app", "s1.jsonl");
  mkdirSync(dirname(transcript), { recursive: true });
  mkdirSync(join(home, "work", "app"), { recursive: true });
  writeFileSync(transcript, Array.from({ length: 24 }, (_, i) => JSON.stringify({
    type: "assistant", uuid: `u${i}`, timestamp: new Date(NOW - i * HOUR - 60_000).toISOString(), cwd: join(home, "work", "app"), sessionId: "s1",
    message: { id: `msg_${i}`, model: "claude-sonnet-5", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 100_000, output_tokens: 0 } },
  })).join("\n") + "\n");
  // The weekly window: 40% a day ago, `to`% now (64: 1% an hour, out in 36 h; 44: it lasts).
  const to = o.to ?? 64;
  writeFileSync(join(home, ".claude", ".context-doctor-limits.jsonl"), Array.from({ length: 25 }, (_, i) => JSON.stringify({ ts: NOW - (24 - i) * HOUR, app: "claude", w: "seven_day", pct: Math.round((40 + ((to - 40) * i) / 24) * 10) / 10, reset: RESET / 1000, src: "mod" })).join("\n") + "\n");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { hasExtraUsageEnabled: o.extra ?? true }, cachedExtraUsageDisabledReason: null }));
  return { home, cache, env: cleanEnv(home, { CONTEXT_DOCTOR_CACHE_DIR: cache }) };
}

function run(env: NodeJS.ProcessEnv, args: string[]): { out: string; err: string; status: number | null } {
  const r = spawnSync(process.execPath, [...frozenClock(NOW), cli, ...args], { env, encoding: "utf8", timeout: 60_000 });
  return { out: r.stdout, err: r.stderr, status: r.status };
}

test("limits and budget say it in one line, with extra usage on; not with it off or a pace that lasts; never in the hook", () => {
  const { home, cache, env } = setup();
  try {
    const lim = run(env, ["limits"]);
    assert.equal(lim.status, 0, lim.err);
    assert.match(lim.out, /At that pace it runs out Fri, Oct 16 03:00 \(in 36h 00m\), before the reset\.\n  Extra usage is on: at this pace your weekly limit runs out on Fri, Oct 16 at 03:00, 36 hours before it resets, and Claude Code would keep working on usage credits until then: about \$7\.20 at API list prices \(an estimate\), at your last 24 hours' \$0\.20 an hour, mostly Sonnet 5\./);
    const json = JSON.parse(run(env, ["limits", "--json"]).out);
    assert.equal(json.creditsAhead.usd.toFixed(2), "7.20");
    assert.equal(json.creditsAhead.hours, 36);

    assert.equal(run(env, ["budget", "50/day"]).status, 0);
    const b = run(env, ["budget"]);
    assert.match(b.out, /^Extra usage is on: at this pace your weekly limit runs out on Fri, Oct 16 at 03:00, .* about \$7\.20 at API list prices/m);
    assert.equal(JSON.parse(run(env, ["budget", "--json"]).out).creditsAhead.usd.toFixed(2), "7.20");
    // The every-prompt hook stays as it was: nothing about it.
    const hook = spawnSync(process.execPath, [...frozenClock(NOW), cli, "hook"], { env, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/work/app", prompt: "go on" }), encoding: "utf8" });
    assert.doesNotMatch(hook.stdout, /Extra usage is on|usage credits until/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
  for (const o of [{ extra: false }, { to: 44 }]) {
    const s = setup(o);
    try {
      const lim = run(s.env, ["limits"]);
      assert.equal(lim.status, 0, lim.err);
      assert.doesNotMatch(lim.out, /Extra usage is on/, JSON.stringify(o));
      assert.equal(JSON.parse(run(s.env, ["limits", "--json"]).out).creditsAhead, undefined);
      run(s.env, ["budget", "50/day"]);
      assert.doesNotMatch(run(s.env, ["budget"]).out, /Extra usage is on/);
      assert.equal(JSON.parse(run(s.env, ["budget", "--json"]).out).creditsAhead, null);
    } finally {
      rmSync(s.home, { recursive: true, force: true });
      rmSync(s.cache, { recursive: true, force: true });
    }
  }
});
