/**
 * The status line must be fast, truthful, and silent on failure.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { renderStatusLine, tailUsage } from "../statusline.js";
import { sandboxEnv } from "./sandbox.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

test("uses the payload's context window when present, the transcript tail when not", () => {
  const fromPayload = renderStatusLine({
    model: { id: "claude-sonnet-5" },
    // current_usage is the context; total_input_tokens (a running total) is ignored.
    context_window: { total_input_tokens: 9_000_000, context_window_size: 1_000_000, current_usage: { input_tokens: 150_000 } },
    cost: { total_cost_usd: 0.5 },
  });
  assert.match(fromPayload ?? "", /ctx 150k\/1\.0M .* 15%/);
  assert.match(fromPayload ?? "", /\$0\.500/);
  assert.ok(!fromPayload?.includes("⚠"), "15% is not a warning");

  // Transcript whose last assistant turn reports 800k of a 1M window, mostly cached.
  const dir = mkdtempSync(join(tmpdir(), "ctxdoc-sl-"));
  const path = join(dir, "t.jsonl");
  const filler = JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(50_000) } });
  writeFileSync(
    path,
    [
      filler, filler, filler,
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "ok", model: "claude-opus-5", usage: { input_tokens: 20_000, cache_read_input_tokens: 780_000 } } }),
      "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"partial line with no usage\"}}",
    ].join("\n") + "\n"
  );
  const tail = tailUsage(path);
  assert.equal(tail?.tokens, 800_000);
  assert.ok(Math.abs((tail?.cacheShare ?? 0) - 0.975) < 0.001);

  const fromTail = renderStatusLine({ transcript_path: path, model: { id: "claude-opus-5" } });
  assert.match(fromTail ?? "", /ctx 800k\/1\.0M .* 80% ⚠/, "80% of the window earns the warning mark");
  assert.match(fromTail ?? "", /cache 98%/);
});

test("nothing trustworthy means nothing printed, never an error", async () => {
  assert.equal(renderStatusLine({}), null);
  assert.equal(renderStatusLine({ transcript_path: "/definitely/not/here.jsonl" }), null);
  for (const stdin of ["not json", "", "{}"]) {
    const { out, code } = await new Promise<{ out: string; code: number }>((resolve) => {
      const child = execFile(process.execPath, [cliPath, "statusline"], (err, stdout) =>
        resolve({ out: stdout, code: err ? (err as { code?: number }).code ?? 1 : 0 })
      );
      child.stdin?.end(stdin);
    });
    assert.equal(out, "", `stdin ${JSON.stringify(stdin)} must print nothing`);
    assert.equal(code, 0, "a status line command must never fail the shell");
  }
});

test("install --statusline wires it, never overwrites someone else's, and uninstall removes only ours", async () => {
  const run = (home: string, ...args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile(process.execPath, [cliPath, ...args], { env: sandboxEnv(home) }, (err, stdout, stderr) =>
        err ? reject(new Error(stderr || err.message)) : resolve(stdout)
      );
    });
  const settingsOf = (home: string) => JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));

  // Fresh machine: installed.
  const home = mkdtempSync(join(tmpdir(), "ctxdoc-slhome-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  assert.match(await run(home, "install", "--statusline"), /status line installed/);
  assert.match(settingsOf(home).statusLine.command, /statusline$/);
  // Plain install without the flag leaves it as is; a second --statusline is idempotent.
  await run(home, "install");
  assert.match(settingsOf(home).statusLine.command, /statusline$/);
  assert.match(await run(home, "install", "--statusline"), /already installed/);
  // Uninstall removes ours.
  await run(home, "uninstall");
  // install created this settings.json; with ours gone it holds nothing and is deleted.
  assert.equal(existsSync(join(home, ".claude", "settings.json")) ? settingsOf(home).statusLine : undefined, undefined);

  // A machine with its own status line: left alone, and said so.
  const theirs = mkdtempSync(join(tmpdir(), "ctxdoc-slforeign-"));
  mkdirSync(join(theirs, ".claude"), { recursive: true });
  writeFileSync(join(theirs, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "my-fancy-prompt.sh" } }));
  assert.match(await run(theirs, "install", "--statusline"), /left alone: you already have your own/);
  assert.equal(settingsOf(theirs).statusLine.command, "my-fancy-prompt.sh");
  await run(theirs, "uninstall");
  assert.equal(settingsOf(theirs).statusLine.command, "my-fancy-prompt.sh", "uninstall never touches a status line that is not ours");
});

// -- N1: the cache clock (Claude Code's prompt_cache, 2.1.251+) ----------

const at = (iso: string) => Date.parse(iso);
const hhmm = (epochSeconds: number) => {
  const d = new Date(epochSeconds * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

test("a warm cache shows the clock time it goes cold and the price of missing it", () => {
  const now = at("2026-10-27T12:00:00Z");
  const expires = now / 1000 + 42 * 60;
  const line = renderStatusLine(
    {
      model: { id: "claude-opus-5-5" },
      context_window: { context_window_size: 1_000_000, current_usage: { input_tokens: 2_000, cache_read_input_tokens: 400_000 } },
      prompt_cache: { warm: true, caching_observed: true, ttl: "1h", expires_at: expires, recache_tokens_if_cold: 402_000 },
    },
    now
  );
  // 402k at the 1-hour write rate (2x $4) minus a read ($0.20): $3.14 more.
  assert.match(line ?? "", new RegExp(`warm till ${hhmm(expires)} \\(1h\\), then \\+\\$3\\.14`));
  assert.match(line ?? "", /cache 100%/, "the cache share stays");
});

test("the 5-minute TTL is priced at its own write rate and named", () => {
  const now = at("2026-10-27T12:00:00Z");
  const line = renderStatusLine({ model: { id: "claude-opus-5-5" }, prompt_cache: { warm: true, ttl: "5m", expires_at: now / 1000 + 120, recache_tokens_if_cold: 100_000 } }, now);
  // 100k x (1.25 x $4 - $0.20) = $0.48
  assert.match(line ?? "", /\(5m\), then \+\$0\.480/);
});

test("a cold cache says what the next turn re-writes; an expired 'warm' payload is cold", () => {
  const now = at("2026-10-27T12:00:00Z");
  const cold = renderStatusLine({ model: { id: "claude-opus-5-5" }, prompt_cache: { warm: false, caching_observed: true, ttl: "1h", expires_at: null, recache_tokens_if_cold: 402_000 } }, now);
  assert.match(cold ?? "", /cold: next turn \+\$3\.14/);
  // Claude Code re-runs the line at expires_at with the same data: it must flip.
  const stale = renderStatusLine({ model: { id: "claude-opus-5-5" }, prompt_cache: { warm: true, ttl: "1h", expires_at: now / 1000 - 1, recache_tokens_if_cold: 402_000 } }, now);
  assert.match(stale ?? "", /cold: next turn/);
  assert.ok(!stale?.includes("warm till"));
});

test("no price: tokens; no prompt_cache, caching off or nothing to re-cache: the line is as before", () => {
  const now = at("2026-10-27T12:00:00Z");
  const unknown = renderStatusLine({ model: { id: "some-local-model" }, prompt_cache: { warm: false, ttl: "5m", recache_tokens_if_cold: 250_000 } }, now);
  assert.equal(unknown, "cold: next turn 250k re-write");
  const base = { model: { id: "claude-opus-5-5" }, context_window: { context_window_size: 1_000_000, current_usage: { input_tokens: 150_000 } } };
  const before = renderStatusLine(base, now);
  assert.equal(renderStatusLine({ ...base, prompt_cache: null }, now), before);
  assert.equal(renderStatusLine({ ...base, prompt_cache: { warm: false, caching_observed: false, recache_tokens_if_cold: 150_000 } }, now), before);
  assert.equal(renderStatusLine({ ...base, prompt_cache: { warm: false, caching_observed: true, recache_tokens_if_cold: null } }, now), before, "right after a compaction there is nothing to price");
  const warmNoTokens = renderStatusLine({ ...base, prompt_cache: { warm: true, ttl: "1h", expires_at: now / 1000 + 600, recache_tokens_if_cold: null } }, now);
  assert.match(warmNoTokens ?? "", /warm till \d\d:\d\d \(1h\)$/);
});

test("`statusline` prints the clock from Claude Code's real payload shape", async () => {
  const expires = Math.floor(Date.now() / 1000) + 1800;
  const payload = {
    model: { id: "claude-fable-5-1", display_name: "Fable 5.1" },
    context_window: { context_window_size: 1_000_000, current_usage: { input_tokens: 10, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 0 } },
    prompt_cache: { warm: true, caching_observed: true, ttl: "1h", expires_at: expires, requests: 14, misses: 0, expected_rebuilds: 0, hit_ratio: 0.97, cache_write_tokens: 300_000, miss_recache_tokens: 0, last_miss_at: null, last_miss_cause: null, miss_causes: {}, recache_tokens_if_cold: 300_010 },
  };
  const home = mkdtempSync(join(tmpdir(), "ctxdoc-slclock-"));
  const out = await new Promise<string>((resolve) => {
    const child = execFile(process.execPath, [cliPath, "statusline"], { env: sandboxEnv(home) }, (_err, stdout) => resolve(stdout));
    child.stdin?.end(JSON.stringify(payload));
  });
  assert.match(out, new RegExp(`warm till ${hhmm(expires)} \\(1h\\), then \\+\\$`));
});

test("QA: absurd prompt_cache values print nothing for the cache, never NaN or 1e294", () => {
  const now = at("2026-10-27T12:00:00Z");
  for (const pc of [
    { warm: true, ttl: "1h", expires_at: 1e300, recache_tokens_if_cold: 1e300 },
    { warm: true, ttl: "1h", expires_at: (now / 1000 + 600) * 1000, recache_tokens_if_cold: 150_000 }, // milliseconds
    { warm: true, ttl: "1h", expires_at: Number.NaN, recache_tokens_if_cold: 150_000 },
    { warm: false, ttl: "1h", expires_at: null, recache_tokens_if_cold: -5 },
    { warm: false, ttl: "1h", expires_at: null, recache_tokens_if_cold: 5e12 },
  ]) {
    const line = renderStatusLine({ model: { id: "claude-opus-5-5" }, prompt_cache: pc as any }, now) ?? "";
    assert.ok(!/NaN|e\+|Infinity/.test(line), `${JSON.stringify(pc)} -> ${line}`);
    assert.ok(!line.includes("warm till"), `${JSON.stringify(pc)} -> ${line}`);
  }
});
