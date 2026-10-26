/**
 * The fan-out guard: a subagent's price at the user's own median, before it
 * starts, never a block; and its registration everywhere a hook lives.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { estimateSubagent, fanoutMessage, launchOf, measureSubagentCosts, subagentCosts } from "../fanout.js";
import { sandboxEnv } from "./sandbox.js";
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const NOW = Date.parse("2026-10-26T12:00:00Z");
const stat = (n, median, p90, model) => ({ n, median, p90, model });
const costs = {
    computedAt: NOW,
    days: 30,
    n: 40,
    all: stat(40, 3, 12, "claude-opus-5-5"),
    byType: { "general-purpose": stat(30, 4, 14, "claude-opus-5-5"), Explore: stat(10, 1.4, 4, "claude-opus-5-5") },
    byTypeModel: { "general-purpose|claude-opus-5-5": stat(30, 4, 14, "claude-opus-5-5"), "Explore|claude-opus-5-5": stat(10, 1.4, 4, "claude-opus-5-5") },
    byModel: { "claude-opus-5-5": stat(40, 3, 12, "claude-opus-5-5") },
};
test("the estimate: the type on the model it will run on, the Sonnet option at Sonnet's price when Sonnet runs are too few", () => {
    const e = estimateSubagent(costs, "Explore", undefined, "claude-opus-5-5");
    assert.equal(e.median, 1.4);
    assert.equal(e.runs, 10);
    assert.equal(e.cheaper?.model, "claude-sonnet-5-5");
    assert.ok(Math.abs(e.cheaper.median - 0.7) < 1e-9, "Sonnet 5.5 is half Opus 5.5's input price");
    assert.equal(e.cheaper?.measured, false);
    const sonnet = estimateSubagent(costs, "Explore", "sonnet");
    assert.ok(Math.abs(sonnet.median - 0.7) < 1e-9, "asked for Sonnet: priced at Sonnet");
    assert.equal(sonnet.cheaper, undefined);
    const unknownType = estimateSubagent(costs, "my-reviewer", undefined, "claude-opus-5-5");
    assert.equal(unknownType.median, 3, "a type never seen: the overall median");
    assert.equal(estimateSubagent({ ...costs, n: 1, all: stat(1, 3, 3), byType: {}, byTypeModel: {}, byModel: {} }, "Explore"), undefined, "too few runs: no number");
});
test("a type pinned to a model (all its runs on Haiku) is priced on it, not on the parent's, and offered no Sonnet", () => {
    const pinned = {
        ...costs,
        byType: { ...costs.byType, "claude-code-guide": stat(6, 0.06, 0.09, "claude-haiku-5-5") },
        byTypeModel: { ...costs.byTypeModel, "claude-code-guide|claude-haiku-5-5": stat(6, 0.06, 0.09, "claude-haiku-5-5") },
        byModel: { ...costs.byModel, "claude-haiku-5-5": stat(6, 0.06, 0.09), "claude-sonnet-5-5": stat(4, 1.2, 2) },
    };
    const e = estimateSubagent(pinned, "claude-code-guide", undefined, "claude-opus-5-5");
    assert.equal(e.model, "claude-haiku-5-5");
    assert.equal(e.median, 0.06);
    assert.equal(e.cheaper, undefined, "Sonnet is dearer than Haiku");
    // general-purpose ran on Opus and Fable: it follows the parent.
    const mixed = { ...costs, byTypeModel: { ...costs.byTypeModel, "general-purpose|claude-fable-5-1": stat(20, 6, 20, "claude-fable-5-1") } };
    assert.equal(estimateSubagent(mixed, "general-purpose", undefined, "claude-fable-5-1").model, "claude-fable-5-1");
});
test("what is said: the price on a type's first launch and on a burst, one note to the model; nothing for other tools", () => {
    const est = estimateSubagent(costs, "general-purpose", undefined, "claude-opus-5-5");
    const line = (t, type = "general-purpose", c = true) => ({ t: NOW + t, type, id: `id${t}-${type}`, c });
    const log = [line(0)];
    const first = fanoutMessage(est, undefined, log, log[0]);
    assert.match(first.systemMessage, /^context-doctor: a general-purpose subagent on Opus 5\.5 costs ~\$4\.00 at your median \(p90 \$14\.00, 30 runs, list price\)\. On Sonnet: ~\$2\.00 at its price\.$/);
    assert.match(first.additionalContext, /pass model: "sonnet" to the Agent tool/);
    log.push(line(10_000));
    const second = fanoutMessage(est, undefined, log, log[1]);
    assert.equal(second.systemMessage, undefined, "the same type again: quiet");
    assert.equal(second.additionalContext, undefined, "the model is told once a session");
    log.push(line(20_000));
    assert.match(fanoutMessage(est, undefined, log, log[2]).systemMessage, /3 subagents in 2 minutes, ~\$12\.00 together/);
    const sonnet = estimateSubagent(costs, "Explore", "sonnet");
    const asked = fanoutMessage(sonnet, "sonnet", [line(0, "Explore", false)], line(0, "Explore", false));
    assert.ok(!/On Sonnet/.test(asked.systemMessage) && asked.additionalContext === undefined, "already on Sonnet: no cheaper option");
    assert.deepEqual(fanoutMessage(undefined, undefined, [line(0)], line(0)), {}, "no estimate: nothing");
    assert.deepEqual(launchOf({ tool_name: "Bash", tool_input: {} }), undefined);
    assert.deepEqual(launchOf({ tool_name: "Task", tool_input: { subagent_type: "Explore" } }), { type: "Explore", alias: undefined }, "Task, the tool's name before 2.1.63");
    assert.deepEqual(launchOf({ tool_name: "Agent", tool_input: "nope" }), { type: "general-purpose", alias: undefined });
});
test("a fan-out: five hooks at once for one session say the first price once, the burst once, and tell the model once", async () => {
    const home = mkdtempSync(join(tmpdir(), "cd-fanout-par-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".context-doctor-subagent-costs.json"), JSON.stringify({ ...costs, computedAt: Date.now() }));
    const { execFile } = await import("node:child_process");
    const one = () => new Promise((resolve) => {
        const child = execFile(process.execPath, [cliPath, "hook"], { env: sandboxEnv(home) }, (_e, stdout) => resolve(stdout));
        child.stdin?.end(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "fan", tool_name: "Agent", tool_input: { subagent_type: "general-purpose", prompt: "p" } }));
    });
    const outs = (await Promise.all([one(), one(), one(), one(), one()])).map((o) => (o.trim() ? JSON.parse(o) : {}));
    const messages = outs.map((o) => o.systemMessage).filter(Boolean);
    assert.equal(messages.filter((m) => /costs ~\$4\.00 at your median/.test(m)).length, 1, messages.join("\n"));
    assert.equal(messages.filter((m) => /3 subagents in 2 minutes/.test(m)).length, 1, messages.join("\n"));
    assert.equal(outs.filter((o) => o.hookSpecificOutput?.additionalContext).length, 1);
});
/** A subagent transcript and its meta, under a parent session in the sandboxed home. */
function subagent(home, id, type, model, inputTokens) {
    const parent = join(home, ".claude", "projects", "-p", "parent.jsonl");
    mkdirSync(dirname(parent), { recursive: true });
    writeFileSync(parent, JSON.stringify({ type: "user", message: { role: "user", content: "x" } }) + "\n");
    const dir = join(home, ".claude", "projects", "-p", "parent", "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: type, description: "d" }));
    writeFileSync(join(dir, `agent-${id}.jsonl`), [
        JSON.stringify({ type: "user", isSidechain: true, message: { role: "user", content: "task" } }),
        JSON.stringify({ type: "assistant", isSidechain: true, timestamp: new Date().toISOString(), message: { id: `m-${id}`, model, role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: inputTokens, output_tokens: 0 } } }),
    ].join("\n") + "\n");
    return parent;
}
test("medians are measured from the subagents' own transcripts and cached for a day", () => {
    const home = mkdtempSync(join(tmpdir(), "cd-fanout-m-"));
    let parent = "";
    for (const [i, tokens] of [100_000, 200_000, 300_000].entries())
        parent = subagent(home, `e${i}`, "Explore", "claude-opus-5-5", tokens);
    const m = measureSubagentCosts(30, { sessions: [parent] });
    assert.equal(m.byType.Explore.n, 3);
    assert.ok(Math.abs(m.byType.Explore.median - 0.8) < 1e-9, String(m.byType.Explore.median));
    const cache = join(home, "costs.json");
    const first = subagentCosts(Date.now(), cache);
    assert.ok(first);
    writeFileSync(cache, JSON.stringify({ ...costs, computedAt: Date.now() - 1000 }));
    assert.equal(subagentCosts(Date.now(), cache)?.byType["general-purpose"].median, 4, "a fresh cache is used as is");
});
test("the hook answers PreToolUse with a message and context only: no decision, exit 0", () => {
    const home = mkdtempSync(join(tmpdir(), "cd-fanout-h-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".context-doctor-subagent-costs.json"), JSON.stringify({ ...costs, computedAt: Date.now() }));
    const r = spawnSync(process.execPath, [cliPath, "hook"], { input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Agent", tool_input: { subagent_type: "Explore", prompt: "find it" } }), env: sandboxEnv(home), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.match(out.systemMessage, /Explore subagent on Opus 5\.5 costs ~\$1\.40/);
    assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.match(out.hookSpecificOutput.additionalContext, /model: "sonnet"/);
    assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
    assert.equal(out.decision, undefined);
    // Garbage in: still exit 0, nothing out.
    const bad = spawnSync(process.execPath, [cliPath, "hook"], { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: "nope" }), env: sandboxEnv(home), encoding: "utf8" });
    assert.equal(bad.status, 0);
});
test("install registers it on the Agent tool (by both names, with a timeout); uninstall removes it; the plugin carries it", () => {
    const home = mkdtempSync(join(tmpdir(), "cd-fanout-i-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    const run = (args) => spawnSync(process.execPath, [cliPath, ...args], { env: { ...sandboxEnv(home), CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS: "2.1.62" }, encoding: "utf8" });
    assert.equal(run(["install"]).status, 0);
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    const entry = settings.hooks.PreToolUse[0];
    assert.equal(entry.matcher, "Agent|Task");
    assert.equal(entry.hooks[0].timeout, 10);
    assert.match(entry.hooks[0].command, /hook$/);
    assert.equal(settings.hooks.PreModelSwitch, undefined, "2.1.62 present: no PreModelSwitch, but PreToolUse is safe there");
    const doctor = run(["doctor"]);
    assert.match(doctor.stdout, /Subagent price/);
    assert.equal(run(["uninstall"]).status, 0);
    const settingsPath = join(home, ".claude", "settings.json");
    if (existsSync(settingsPath))
        assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).hooks?.PreToolUse, undefined);
    const plugin = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(plugin.hooks.PreToolUse[0].matcher, "Agent|Task");
});
