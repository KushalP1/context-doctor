/** The subagents' model: every subagent request as billed and at Sonnet 5.5, per agent type. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentDefinitions, movedFromNames, renderSubagentTypes, replaySubagentModels, shares, subagentModelSavedSince, variableMoves } from "../subagentmodel.js";
import { renderPayback, subagentPayback } from "../subagentpay.js";
import { clearScanMemo } from "../scan.js";
import { at, DAY, FABLE, history, mixed, now, OPUS, reply, SONNET } from "./subagent-fixture.js";
const near = (a, b, what = "") => assert.ok(Math.abs(a - b) < 1e-9, `${what} ${a} vs ${b}`);
// The transcript cache of this file's runs: never the developer's own.
process.env.CONTEXT_DOCTOR_CACHE_DIR = mkdtempSync(join(tmpdir(), "cd-sm-cache-"));
test("replay: every request as billed and at Sonnet 5.5, only for the types CLAUDE_CODE_SUBAGENT_MODEL moves", () => {
    const { home } = history(mixed);
    const r = replaySubagentModels({ since: now - 30 * DAY, home });
    // a1, a2, a3, a4, a5, a7, a8 (a6 is a copy, a8's first request is too old).
    assert.equal(r.requests, 7);
    assert.equal(r.agents, 7);
    near(r.billedUsd, 5 * OPUS + SONNET + FABLE, "billed");
    // Moved: general-purpose on Opus (a1) and Fable (a8), helper (its file names no model). Kept: Explore, Sonnet already, reviewer (haiku), mystery (no file).
    near(r.atCandidateUsd, 3 * SONNET + SONNET + 3 * OPUS, "at Sonnet");
    near(r.savedUsd, 2 * (OPUS - SONNET) + (FABLE - SONNET), "saved");
    assert.deepEqual(Object.keys(r.movedFrom), ["claude-fable-5-1", "claude-opus-5-5"]);
    assert.equal(movedFromNames(r.movedFrom), "Fable 5.1 or Opus 5.5");
    const by = Object.fromEntries(r.byType.map((t) => [t.type, t]));
    assert.equal(by["general-purpose"].agents, 3);
    near(by["general-purpose"].billedUsd, OPUS + SONNET + FABLE);
    assert.equal(by.Explore.moves, false);
    assert.match(by.Explore.why, /main conversation's model/);
    assert.match(by.reviewer.why, /model: haiku/);
    assert.equal(by.helper.moves, true);
    assert.match(by.mystery.why, /not found/);
    // Every prompt here is 211k tokens: past Haiku 5.5's 100k tier, so read-only work at Haiku is
    // priced at its higher rates ($0.50 / $0.05 / $2.50; Anthropic's page, read 2026-11-08).
    assert.equal(by.Explore.over100k, 1);
    near(by.Explore.atHaikuUsd, (1000 * 0.5 + 200_000 * 0.05 + 17_000 * 0.5 + 1000 * 2.5) / 1e6, "Explore at Haiku 5.5, over 100k");
    const lines = renderSubagentTypes(r).join("\n");
    assert.match(lines, /general-purpose\s+3\s+\$0\.\d\d\s+\$0\.\d\d/);
    assert.match(lines, /Explore .*unchanged: built in, on the main conversation's model/);
    assert.match(lines, /Haiku 5\.5: ~\$0\.02 \(1 of 1 requests had prompts over 100k tokens, at Haiku's higher rates for those\)/);
    assert.match(lines, /`model: haiku` in its file/);
    // CLAUDE_CODE_SUBAGENT_MODEL_FORCE: the variable wins over the definitions too (forks still inherit).
    const forced = replaySubagentModels({ since: now - 30 * DAY, home, force: true });
    near(forced.savedUsd, 5 * (OPUS - SONNET) + (FABLE - SONNET), "forced");
    assert.equal(variableMoves("fork", new Map(), true).moves, false);
    assert.equal(variableMoves("claude", new Map()).moves, true);
    assert.equal(variableMoves("claude-code-guide", new Map()).moves, false);
    // A transcript with no meta beside it: no type to look up, said so.
    assert.match(variableMoves("unknown", new Map()).why, /no agent type recorded/);
});
test("replay: output settled from the reply's last row, also when it arrives after a cached read", () => {
    const { home, sub } = history((cwd) => [{ id: "b1", type: "general-purpose", rows: reply(at, "claude-opus-5-5", cwd, "msg_grow").slice(0, 1) }]);
    const first = replaySubagentModels({ since: now - 30 * DAY, home });
    near(first.billedUsd, OPUS - (990 * 20) / 1e6, "first row only: 10 output tokens");
    // The reply's last row lands (Claude Code appends): only the new output is read and charged.
    appendFileSync(join(sub, "agent-b1.jsonl"), reply(at, "claude-opus-5-5", "/x", "msg_grow")[1] + "\n");
    clearScanMemo();
    const grown = replaySubagentModels({ since: now - 30 * DAY, home });
    near(grown.billedUsd, OPUS, "billed");
    near(grown.atCandidateUsd, SONNET, "at Sonnet");
    assert.equal(grown.requests, 1);
});
test("saved since: the moved requests at the models they ran on before, against as billed", () => {
    const { sub } = history((cwd) => [
        { id: "c1", type: "general-purpose", rows: reply(at, "claude-sonnet-5-5", cwd) },
        { id: "c2", type: "Explore", rows: reply(at, "claude-opus-5-5", cwd) },
    ]);
    const paths = [join(sub, "agent-c1.jsonl"), join(sub, "agent-c2.jsonl")];
    // Before the change they ran half on Opus 5.5 and half on Fable 5.1 (by dollars).
    const s = subagentModelSavedSince(now - 30 * DAY, { "claude-opus-5-5": 0.5, "claude-fable-5-1": 0.5 }, paths);
    assert.equal(s.requests, 1);
    near(s.usd, (OPUS + FABLE) / 2 - SONNET);
    assert.deepEqual(shares({ a: 3, b: 1 }), { a: 0.75, b: 0.25 });
});
test("subagents report: what the same requests come to at Sonnet 5.5", () => {
    const { parent } = history((cwd) => [{ id: "d1", type: "general-purpose", rows: Array.from({ length: 30 }, (_, i) => reply(at + i * 1000, "claude-opus-5-5", cwd)).flat() }]);
    const r = subagentPayback(30, [parent]);
    near(r.subagents[0].costUsd, 30 * OPUS);
    near(r.subagents[0].atSonnetUsd, 30 * SONNET);
    assert.match(renderPayback(r), /At Sonnet 5\.5 \(where they ran on a pricier model\) the same requests come to ~\$\d+\.\d\d, token counts as recorded: an estimate\./);
});
test("saved since: the baseline is the moved types' whole mix by tokens, Sonnet runs included, not the pricier runs' bill", () => {
    // Before: general-purpose ran once from an Opus session, once from a Sonnet one (inherited), once on Fable.
    const before = history((cwd) => [
        { id: "h1", type: "general-purpose", rows: reply(at, "claude-opus-5-5", cwd) },
        { id: "h2", type: "general-purpose", rows: reply(at, "claude-sonnet-5-5", cwd) },
        { id: "h3", type: "general-purpose", rows: reply(at, "claude-fable-5-1", cwd) },
    ]);
    const r = replaySubagentModels({ since: now - 30 * DAY, home: before.home });
    // The same tokens each: a third each, whatever each one's bill.
    const mix = shares(r.before);
    for (const m of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"])
        near(mix[m], 1 / 3, m);
    // After: all three on Sonnet. Before, one of them was on Sonnet already: only two moved.
    const after = history((cwd) => ["k1", "k2", "k3"].map((id) => ({ id, type: "general-purpose", rows: reply(at, "claude-sonnet-5-5", cwd) })));
    const s = subagentModelSavedSince(now - 30 * DAY, mix, ["k1", "k2", "k3"].map((id) => join(after.sub, `agent-${id}.jsonl`)));
    near(s.usd, OPUS + SONNET + FABLE - 3 * SONNET);
    near(s.usd, r.savedUsd, "what the plan offered");
});
test("agent files as Claude Code merges them: the project's over the user's, subfolders read, each project its own, no name no agent", () => {
    // The user's reviewer names no model; this project's own reviewer (in a subfolder, at the git root above the subagent's folder) says opus.
    const { home, cwd } = history((cwd) => [
        { id: "g1", type: "reviewer", rows: reply(at, "claude-opus-5-5", join(cwd, "pkg")) },
        { id: "g2", type: "lone", rows: reply(at, "claude-opus-5-5", join(cwd, "pkg")) },
    ]);
    writeFileSync(join(home, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: reviews\n---\nReview.\n");
    mkdirSync(join(cwd, ".git"));
    mkdirSync(join(cwd, "pkg"));
    mkdirSync(join(cwd, ".claude", "agents", "team"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "agents", "team", "reviewer.md"), "---\nname: reviewer\ndescription: reviews\nmodel: opus\n---\nReview.\n");
    // A file without a name is not an agent (Claude Code skips it), whatever the file is called.
    writeFileSync(join(cwd, ".claude", "agents", "lone.md"), "---\ndescription: no name\n---\nLone.\n");
    const r = replaySubagentModels({ since: now - 30 * DAY, home });
    const by = Object.fromEntries(r.byType.map((t) => [t.type, t]));
    assert.equal(by.reviewer.moves, false);
    assert.match(by.reviewer.why, /model: opus/);
    assert.equal(by.lone.moves, false);
    assert.match(by.lone.why, /not found/);
    near(r.savedUsd, 0);
    const defs = agentDefinitions(join(cwd, "pkg"), home, {});
    assert.equal(defs.get("reviewer").model, "opus");
    assert.equal(defs.get("helper").model, undefined);
    // Outside the project the user's file holds: it names no model, so the variable moves it.
    assert.equal(agentDefinitions(mkdtempSync(join(tmpdir(), "cd-sm-elsewhere-")), home, {}).get("reviewer").model, undefined);
    assert.equal(variableMoves("reviewer", agentDefinitions(undefined, home, {})).moves, true);
});
