/**
 * N2: Claude Code's own diagnosis of each cache miss, logged by the status
 * line and grouped by `cache-misses`. Each refresh re-sends the same
 * `last_miss_at` and parallel sessions share one file, so a miss must be
 * written once; its tokens are the growth of the session's running total.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { diagnosedMisses, recordMiss } from "../missledger.js";
import { cacheMisses, renderCacheMisses, renderDiagnosed } from "../cachemisses.js";
import { sandboxEnv } from "./sandbox.js";
const cliPath = join(fileURLToPath(new URL(".", import.meta.url)), "..", "cli.js");
const logIn = () => join(mkdtempSync(join(tmpdir(), "ctxdoc-misses-")), "misses.jsonl");
const T0 = Date.parse("2026-10-27T09:00:00Z");
const pc = (misses, tok, at, causes, extra = {}) => ({
    warm: true,
    ttl: "1h",
    misses,
    miss_recache_tokens: tok,
    last_miss_at: at,
    last_miss_cause: causes ? { causes, ...extra } : null,
});
test("a miss is written once however many refreshes and sessions re-send it", () => {
    const path = logIn();
    const first = pc(1, 300_000, T0 / 1000, ["tools_changed"], { tools_added: 2, tools_removed: 0 });
    assert.equal(recordMiss(first, "sess-a", "claude-opus-5-5", T0, path), 1);
    assert.equal(recordMiss(first, "sess-a", "claude-opus-5-5", T0 + 5_000, path), 0, "the next refresh re-sends it");
    // Another session's miss at the same second is a different miss.
    assert.equal(recordMiss(pc(1, 50_000, T0 / 1000, ["likely_server_side"]), "sess-b", "claude-opus-5-5", T0 + 6_000, path), 1);
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0].causes, ["tools_changed"]);
    assert.equal(lines[0].added, 2);
    assert.equal(lines[0].ttl, "1h");
});
test("nothing to log: no session, no miss yet, or not an object", () => {
    const path = logIn();
    assert.equal(recordMiss(pc(1, 1, T0 / 1000, ["unknown"]), undefined, "m", T0, path), 0);
    assert.equal(recordMiss({ warm: true, misses: 0, last_miss_at: null }, "s", "m", T0, path), 0);
    assert.equal(recordMiss("prompt_cache", "s", "m", T0, path), 0);
    assert.equal(recordMiss(null, "s", "m", T0, path), 0);
    assert.equal(existsSync(path), false);
});
test("an undiagnosed miss is 'unknown'; odd cause names are dropped, not written", () => {
    const path = logIn();
    recordMiss(pc(1, 1_000, T0 / 1000, null), "s", "m", T0, path);
    recordMiss(pc(2, 2_000, T0 / 1000 + 60, ["system_prompt_changed", "Robert'); DROP", 7]), "s", "m", T0, path);
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines[0].causes, ["unknown"]);
    assert.deepEqual(lines[1].causes, ["system_prompt_changed"]);
});
test("the report takes each miss's share of the running total and prices it", () => {
    const path = logIn();
    // Session a: 300k on the first miss, 700k in total after the second (400k).
    recordMiss(pc(1, 300_000, T0 / 1000, ["tools_changed"]), "a", "claude-opus-5-5", T0, path);
    recordMiss(pc(2, 700_000, T0 / 1000 + 600, ["ttl_expired_1h"]), "a", "claude-opus-5-5", T0, path);
    // Session b: two causes on one miss; a 5-minute TTL.
    recordMiss({ ...pc(1, 100_000, T0 / 1000 + 30, ["system_prompt_changed", "tools_changed"], { system_char_delta: 1200 }), ttl: "5m" }, "b", "claude-opus-5-5", T0, path);
    // Before the period: not counted, but still the baseline for its session.
    const d = diagnosedMisses(T0 - 1, path);
    assert.equal(d.misses, 3);
    assert.equal(d.sessions, 2);
    assert.equal(d.tokens, 800_000);
    const tools = d.byCause.find((c) => c.cause === "tools_changed");
    assert.equal(tools.misses, 2);
    assert.equal(tools.tokens, 400_000);
    assert.match(tools.fix ?? "", /overhead --mcp/);
    const ttl = d.byCause.find((c) => c.cause === "ttl_expired_1h");
    assert.equal(ttl.tokens, 400_000);
    // 400k x (2 x $4 - $0.20) = $3.12 at 1 h; 100k x (1.25 x $4 - $0.20) = $0.48 at 5 m.
    assert.ok(Math.abs(ttl.extraUsd - 3.12) < 0.001, `${ttl.extraUsd}`);
    assert.ok(Math.abs(d.extraUsd - (3.12 + 3.12 * 0.75 + 0.48)) < 0.001, `${d.extraUsd}`);
    const later = diagnosedMisses(T0 + 300_000, path);
    assert.equal(later.misses, 1, "only the miss after `since`");
    assert.equal(later.tokens, 400_000, "its share, not the running total");
});
test("an unknown cause name is shown as it is, with no advice", () => {
    const path = logIn();
    recordMiss(pc(1, 10_000, T0 / 1000, ["new_cause_v2"]), "s", "claude-opus-5-5", T0, path);
    const d = diagnosedMisses(0, path);
    assert.equal(d.byCause[0].label, "new cause v2");
    assert.equal(d.byCause[0].fix, undefined);
});
test("the log is byte-capped and keeps its newest lines", () => {
    const path = logIn();
    const old = JSON.stringify({ ts: 1, s: "old", at: 1, causes: ["unknown"], n: 1, tok: 1 });
    writeFileSync(path, (old + "\n").repeat(Math.ceil((1100 * 1024) / (old.length + 1))));
    assert.equal(recordMiss(pc(1, 5, T0 / 1000, ["unknown"]), "new", "m", T0, path), 1);
    assert.ok(statSync(path).size < 800 * 1024, `${statSync(path).size}`);
    assert.match(readFileSync(path, "utf8").trim().split("\n").pop() ?? "", /"s":"new"/);
});
test("cache-misses shows the diagnosis, or how to start recording it", () => {
    const path = logIn();
    const none = renderDiagnosed(diagnosedMisses(0, path));
    assert.match(none.join("\n"), /install --statusline/);
    recordMiss(pc(1, 250_000, T0 / 1000, ["tools_changed"], { tools_added: 1 }), "s", "claude-opus-5-5", T0, path);
    const report = cacheMisses(30, [], undefined, path);
    // No transcripts at all: the diagnosis still shows, with the period's numbers.
    const text = renderCacheMisses({ ...report, diagnosed: diagnosedMisses(0, path) });
    assert.match(text, /Why, in Claude Code's words \(1 misses in 1 session/);
    assert.match(text, /tool definitions changed/);
    const lines = renderDiagnosed(diagnosedMisses(0, path));
    assert.ok(lines.every((l) => l.length <= 90), `lines stay readable:\n${lines.join("\n")}`);
});
test("`statusline` writes the log in the sandboxed home, and not when told not to", () => {
    const home = mkdtempSync(join(tmpdir(), "ctxdoc-slmiss-"));
    const input = { session_id: "abc", model: { id: "claude-opus-5-5" }, prompt_cache: pc(1, 120_000, Math.floor(Date.now() / 1000), ["tools_changed"]) };
    spawnSync(process.execPath, [cliPath, "statusline"], { input: JSON.stringify(input), env: sandboxEnv(home), encoding: "utf8" });
    const log = join(home, ".claude", ".context-doctor-misses.jsonl");
    assert.ok(existsSync(log));
    assert.match(readFileSync(log, "utf8"), /"causes":\["tools_changed"\]/);
    const home2 = mkdtempSync(join(tmpdir(), "ctxdoc-slmiss2-"));
    spawnSync(process.execPath, [cliPath, "statusline"], { input: JSON.stringify(input), env: { ...sandboxEnv(home2), CONTEXT_DOCTOR_NO_MISS_LOG: "1" }, encoding: "utf8" });
    assert.equal(existsSync(join(home2, ".claude", ".context-doctor-misses.jsonl")), false);
});
test("QA: two misses between status line runs count as two; the unseen one is named", () => {
    const path = logIn();
    recordMiss(pc(1, 100_000, T0 / 1000, ["tools_changed"]), "s", "claude-opus-5-5", T0, path);
    recordMiss(pc(3, 700_000, T0 / 1000 + 300, ["ttl_expired_1h"]), "s", "claude-opus-5-5", T0, path);
    const d = diagnosedMisses(0, path);
    assert.equal(d.misses, 3);
    assert.equal(d.tokens, 700_000);
    const by = Object.fromEntries(d.byCause.map((c) => [c.cause, c]));
    assert.equal(by.ttl_expired_1h.misses, 1);
    assert.equal(by.ttl_expired_1h.tokens, 300_000, "its share of the 600k");
    assert.equal(by.unseen.misses, 1);
    assert.equal(by.unseen.tokens, 300_000);
    assert.match(by.unseen.label, /not seen/);
});
test("QA: a line with no TTL is priced at 5 minutes, Claude Code's default, as the status line does", () => {
    const path = logIn();
    const noTtl = { misses: 1, miss_recache_tokens: 100_000, last_miss_at: T0 / 1000, last_miss_cause: { causes: ["unknown"] } };
    recordMiss(noTtl, "s", "claude-opus-5-5", T0, path);
    // 100k x (1.25 x $4 - $0.20) = $0.48
    assert.ok(Math.abs(diagnosedMisses(0, path).extraUsd - 0.48) < 1e-9);
});
