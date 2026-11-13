/**
 * The plugin's mod (src/mod): the band's states, the fix pane's rows, and
 * the hooks themselves driven by a stand-in for Claude Code's mods engine.
 *
 * The stand-in answers `$` the way the 2.1.321 declarations describe it and
 * runs `$.process.run` for real, in a throwaway HOME, so a button press
 * writes what the CLI writes; each press is compared byte for byte with the
 * CLI run by hand (`fix --apply <id>`, `fix undo <id>`) on a copy of the same
 * home. Nothing here starts Claude Code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { applyOutcome, band, duration, fixArgv, money, outcome, paneRows, parsePlan, passedThreshold, tokens, withPresses } from "../mod/logic.js";
import { register, state, COMMAND, PANE } from "../mod/register.js";
import { costCheck, costGaps, readCostLines, recordModEvent, recordSessionCost, statusLineRateLimits } from "../modmeasure.js";
import { sandboxEnv } from "./sandbox.js";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const cli = join(root, "dist", "cli.js");
const MIN = 60_000;
// -- The band ------------------------------------------------------------------------
const T = Date.parse("2026-11-10T12:00:00Z");
const data = (over = {}) => ({
    at: T, coldMinTokens: 150_000, thresholds: [25, 100, 500],
    tokens: 520_000, model: "claude-opus-5-5", lastReplyAt: T, ttlMs: 60 * MIN, coldMarginMs: 5 * MIN,
    rewriteUsd: 5.2, perMessageUsd: 0.26, afterCompactPerMessageUsd: 0.02, usd: 12.5, ccUsd: 12.4, ...over,
});
test("band: silent while the cache is warm and the session cheap; the countdown in its last five minutes; terminal and mobile stay out of it", () => {
    assert.equal(band(data(), T + 10 * MIN, "desktop").kind, "none");
    const warm = band(data(), T + 57 * MIN, "desktop");
    assert.equal(warm.kind, "warm");
    assert.equal(warm.text, "context-doctor: cache warm for 3 min, then your next message re-writes 520k tokens (~$5.20) · session $12.50 (Claude Code: $12.40)");
    assert.equal(band(data(), T + 57 * MIN, "vscode").kind, "warm");
    // The terminal has the status line for that; mobile draws nothing of ours.
    assert.equal(band(data(), T + 57 * MIN, "terminal").kind, "none");
    assert.equal(band(data(), T + 90 * MIN, "mobile").kind, "none");
    // A small context: a cold cache is cheap, nothing to say.
    assert.equal(band(data({ tokens: 90_000 }), T + 57 * MIN, "desktop").kind, "none");
    assert.equal(band(data({ tokens: 90_000 }), T + 90 * MIN, "desktop").kind, "none");
    assert.equal(band(undefined, T, "desktop").kind, "none");
});
test("band: expired, then a cold return with the Compact first offer, on every surface but mobile; not past Claude Code's own compaction point", () => {
    const expired = band(data(), T + 62 * MIN, "desktop");
    assert.equal(expired.kind, "expired");
    assert.match(expired.text, /the cache expired, so your next message re-writes 520k tokens \(~\$5\.20\)/);
    for (const s of ["desktop", "vscode", "terminal"]) {
        const cold = band(data(), T + 80 * MIN, s);
        assert.equal(cold.kind, "cold", s);
        const c = cold;
        assert.match(c.text, /^context-doctor: idle 1h 20m, the cache expired: your next message re-writes 520k tokens \(~\$5\.20\)/);
        assert.equal(c.compact, "Compact first: each later message re-reads ~$0.26 of context now, ~$0.02 after");
        // The terminal's band leaves the price to the status line.
        assert.equal(/session \$/.test(c.text), s !== "terminal");
    }
    assert.equal(band(data({ autoCompactAt: 500_000 }), T + 80 * MIN, "desktop").kind, "expired", "Claude Code compacts this one itself");
    assert.equal(band(data(), T + 80 * MIN, "mobile").kind, "none");
});
test("band: the price past a threshold, Hide hides that state only, and `always` keeps the clock up", () => {
    const p = band(data({ usd: 112, ccUsd: 110.4, tokens: undefined }), T, "desktop");
    assert.equal(p.kind, "price");
    assert.equal(p.text, "context-doctor: session $112 (Claude Code: $110)");
    assert.equal(band(data({ usd: 24, ccUsd: 24, tokens: undefined }), T, "desktop").kind, "none");
    const key = p.key;
    assert.equal(band(data({ usd: 112, tokens: undefined }), T, "desktop", { hidden: new Set([key]) }).kind, "none");
    // The next threshold is a new state: it shows again.
    assert.equal(band(data({ usd: 510, tokens: undefined }), T, "desktop", { hidden: new Set([key]) }).kind, "price");
    // Hiding the cold offer of one idle period leaves the next one's.
    const cold = band(data(), T + 80 * MIN, "desktop");
    assert.equal(band(data(), T + 80 * MIN, "desktop", { hidden: new Set([cold.key]) }).kind, "none");
    assert.equal(band(data({ lastReplyAt: T + MIN }), T + 81 * MIN, "desktop", { hidden: new Set([cold.key]) }).kind, "cold");
    assert.equal(band(data(), T + 10 * MIN, "desktop", { always: true }).kind, "warm");
    assert.match(band(data(), T + 10 * MIN, "desktop", { always: true }).text, /cache warm for 50 min/);
    // Claude Code's figure alone (the CLI could not run): said as Claude Code's.
    const cc = band({ at: T, coldMinTokens: 150_000, thresholds: [25], ccUsd: 30 }, T, "desktop");
    assert.equal(cc.text, "context-doctor: session $30.00 (Claude Code's figure)");
});
test("formatting: money, tokens, durations, thresholds", () => {
    assert.deepEqual([money(0), money(0.004), money(0.42), money(99.994), money(1240.4)], ["$0.00", "<$0.01", "$0.42", "$99.99", "$1,240"]);
    assert.deepEqual([tokens(820), tokens(45_000), tokens(999_499), tokens(1_200_000)], ["820", "45k", "999k", "1.2M"]);
    assert.deepEqual([duration(10_000), duration(3 * MIN), duration(80 * MIN), duration(3 * 1440 * MIN)], ["1 min", "3 min", "1h 20m", "3 days"]);
    assert.equal(passedThreshold(99, [25, 100]), 25);
    assert.equal(passedThreshold(10, [25, 100]), undefined);
});
// -- The fix pane's rows ---------------------------------------------------------------
const plan = {
    days: 30,
    billedUsd: 5000,
    fixes: [
        { id: "subagent-model", title: "Run subagents on Sonnet 5.5", savedUsd: 1534, savedShare: 0.42, shareOf: "of subagents", quality: "untested on your tasks", change: "CLAUDE_CODE_SUBAGENT_MODEL", state: "available" },
        { id: "compact-window", title: "Compact at 400k", savedUsd: 989, savedShare: 0.2, quality: "earlier summaries", change: "autoCompactWindow 400000", state: "available", overriddenBy: ["a project setting"] },
        { id: "cache-ttl", title: "1-hour cache", state: "applied", note: "promptCacheTtl 1h" },
        { id: "autopilot", title: "Autopilot", state: "not-here", note: "cannot reach the Desktop app" },
    ],
    since: [{ id: "cache-ttl", at: T, savedUsd: 12.3, detail: "estimated" }, { id: "tool-output", at: T, detail: "changed since" }],
};
test("pane rows: Apply where available, Undo where fix applied it, the subagents' model marked as a model change everywhere", () => {
    const rows = paneRows(plan);
    assert.deepEqual(rows.map((r) => [r.id, r.apply, r.undo]), [
        ["subagent-model", "Apply (model change)", undefined],
        ["compact-window", "Apply", undefined],
        ["cache-ttl", undefined, "Undo"],
        ["autopilot", undefined, undefined],
        ["tool-output", undefined, "Undo"],
    ]);
    const sub = rows[0];
    assert.equal(sub.modelChange, true);
    assert.equal(sub.lines[0], "Model change: subagents run on another model. Its quality cost is not measured here.");
    assert.equal(sub.head, "Run subagents on Sonnet 5.5 · $1,534 (42% of subagents) in 30 days");
    assert.ok(rows[1].lines.includes("would not take effect: a project setting"));
    assert.ok(rows[2].lines.includes("saved $12.30 since it was applied"));
    const after = withPresses(rows, new Map([["compact-window", "applied"], ["cache-ttl", "undone"]]));
    assert.deepEqual([after[1].apply, after[1].undo, after[1].head], [undefined, "Undo", "Compact at 400k · applied just now"]);
    assert.deepEqual([after[2].apply, after[2].undo, after[2].lines], [undefined, undefined, ["Refresh to measure it again."]]);
    assert.equal(parsePlan("not json"), undefined);
    assert.equal(parsePlan('{"fixes":1}'), undefined);
});
test("the buttons' commands are the CLI's own, and only for a fix id", () => {
    assert.deepEqual(fixArgv("node", "/p/dist/cli.js", "apply", "cache-ttl"), ["node", "/p/dist/cli.js", "fix", "--apply", "cache-ttl", "--json"]);
    assert.deepEqual(fixArgv("node", "/p/dist/cli.js", "undo", "subagent-model"), ["node", "/p/dist/cli.js", "fix", "undo", "subagent-model"]);
    assert.deepEqual(fixArgv("node", "c", "plan"), ["node", "c", "fix", "--json"]);
    for (const bad of ["--apply", "all,cache-ttl", "../x", "", "A"])
        assert.throws(() => fixArgv("node", "c", "apply", bad));
    assert.deepEqual(applyOutcome(JSON.stringify({ applied: [{ id: "x", ok: false, lines: ["✗ x: no"] }] }), "", 1), { ok: false, lines: ["✗ x: no"] });
    assert.deepEqual(outcome("plan\n\n✓ promptCacheTtl removed\n", "", 0), { ok: true, lines: ["✓ promptCacheTtl removed"] });
});
// -- The ledgers -----------------------------------------------------------------------
test("the mod's windows go to the limits ledger in the status line's shape", () => {
    assert.deepEqual(statusLineRateLimits([{ kind: "five_hour", percentUsed: 23.5, resetsAt: "2026-11-10T14:00:00.000Z" }, { kind: "seven_day", percentUsed: 7 }, { kind: "spend_limit", percentUsed: 101 }, { kind: "five_hour", percentUsed: "x" }]), {
        five_hour: { used_percentage: 23.5, resets_at: Date.parse("2026-11-10T14:00:00.000Z") / 1000 },
        seven_day: { used_percentage: 7 },
    });
    assert.equal(statusLineRateLimits([]), undefined);
    assert.equal(statusLineRateLimits("x"), undefined);
});
test("the cost ledger: one line per move, capped, compared by doctor", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-mod-cost-"));
    const log = join(dir, "cost.jsonl");
    assert.equal(recordSessionCost({ ts: T, sid: "s1", cc: 10, cd: 10.1, model: "claude-opus-5-5" }, log), true);
    assert.equal(recordSessionCost({ ts: T + 1, sid: "s1", cc: 10.001, cd: 10.1 }, log), false, "nothing moved");
    assert.equal(recordSessionCost({ ts: T + 2, sid: "s2", cc: 2, cd: 2.5, model: "claude-fable-5-2", unpriced: 3 }, log), true);
    assert.equal(recordSessionCost({ ts: T + 3, sid: "s1", cc: 11, cd: 11.1 }, log), true);
    assert.equal(recordSessionCost({ ts: T + 4, sid: "s3" }, log), false, "no figure at all");
    assert.equal(recordModEvent("s1", "compact", 520_000, T + 5, log), true);
    assert.equal(recordModEvent("../x", "compact", 1, T, log), false);
    const lines = readCostLines(0, log);
    assert.equal(lines.length, 4);
    assert.deepEqual(costGaps(lines).map((g) => [g.sid, Math.round(g.gap * 1000) / 1000]), [["s1", 0.009], ["s2", 0.25]]);
    const check = costCheck(30, T + 10, log);
    assert.equal(check.status, "warn");
    assert.match(check.detail, /^1 of 2 sessions the mod measured in the last 30 days within 2% of Claude Code's own cost; the largest gap is \+25% \(\$2\.50 against \$2\.00, on claude-fable-5-2, 3 requests with no list price\)/);
    assert.equal(costCheck(30, T + 10, join(dir, "none.jsonl")), undefined);
    // Capped: past the size it keeps the newest part, whole lines only.
    writeFileSync(log, Array.from({ length: 12000 }, (_, i) => JSON.stringify({ ts: T + 10 + i, sid: `old-${i}`, cc: 1, cd: 1 })).join("\n") + "\n");
    assert.ok(statSync(log).size > 512 * 1024);
    assert.equal(recordSessionCost({ ts: T + 20_000, sid: "new", cc: 3, cd: 3 }, log), true);
    assert.ok(statSync(log).size <= 384 * 1024 + 200);
    const kept = readCostLines(0, log);
    assert.equal(kept[kept.length - 1].sid, "new");
    assert.equal(kept[kept.length - 2].sid, "old-11999");
    assert.ok(readFileSync(log, "utf8").split("\n").filter(Boolean).every((l) => JSON.parse(l)));
});
globalThis.h = (type, props, ...children) => ({ type, props, children: children.flat() });
function find(tree, pred) {
    if (!tree || typeof tree !== "object")
        return undefined;
    const n = tree;
    if (pred(n))
        return n;
    for (const c of n.children ?? []) {
        const f = find(c, pred);
        if (f)
            return f;
    }
    return undefined;
}
const button = (tree, key) => find(tree, (n) => n.type === "Button" && n.props?.key === key);
const texts = (tree) => {
    const out = [];
    const walk = (t) => {
        if (typeof t === "string")
            out.push(t);
        else if (t && typeof t === "object")
            for (const c of t.children ?? [])
                walk(c);
    };
    walk(tree);
    return out;
};
/** A stand-in for the engine: `$` as the declarations describe it, process.run for real in `home`. */
function engine(home, opts = {}) {
    const s = { hooks: new Map(), $: undefined, runs: [], compacts: 0, commands: [], opened: [], toasts: [], now: opts.now ?? Date.now() };
    s.$ = {
        plugin: { name: "context-doctor", root },
        process: {
            run: async (argv, init = {}) => {
                s.runs.push(argv);
                if (opts.noProcess)
                    throw new Error("spawn node ENOENT");
                const r = spawnSync(argv[0] === "node" ? process.execPath : argv[0], argv.slice(1), { input: init.stdin ?? "", encoding: "utf8", cwd: opts.cwd ?? home, env: { ...sandboxEnv(home), CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS: "2.1.309" }, timeout: init.timeoutMs });
                return { exitCode: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
            },
        },
        session: {
            id: async () => opts.sessionId ?? "sess-1",
            model: async () => "claude-opus-5-5",
            cwd: async () => opts.cwd ?? home,
            compact: async () => {
                if (opts.compactRejects)
                    throw new Error("a turn is running");
                s.compacts++;
                return { messages: [] };
            },
        },
        ui: {
            open: async (p) => { s.opened.push(p.id); return { isPlaced: true }; },
            resolve: () => ({ Box: "Box", Text: "Text", Button: "Button" }),
            invalidate: () => { },
            toast: (t) => { s.toasts.push(t); },
        },
        command: { register: async (c) => { s.commands.push(c.name); return { command: c.name }; } },
        clock: { now: async () => s.now, every: () => ({ cancel() { } }) },
        env: { get: async (n) => opts.env?.[n] },
    };
    register(((event, a, b) => {
        const list = s.hooks.get(event) ?? [];
        list.push(b ? { matcher: a, hook: b } : { hook: a });
        s.hooks.set(event, list);
    }));
    return s;
}
/** Raise an event through the mod's hooks, the engine's own answer beneath them. */
async function fire(s, event, e, bottom = () => ({})) {
    const list = (s.hooks.get(event) ?? []).filter((x) => !x.matcher || Object.entries(x.matcher).every(([k, v]) => e[k] === v));
    const run = async (i, ev) => (i < list.length ? list[i].hook(s.$, ev, (n) => run(i + 1, n)) : bottom(ev));
    return run(0, e);
}
const render = (s, component, surface, props = {}, requestId) => fire(s, "ui.render", { component, surface, requestId, props }, () => "ENGINE");
/** A Claude Code home with one big session of `cwd` whose last reply is `idleMin` old, on the 1-hour cache. */
function sessionHome(idleMin, now = Date.now()) {
    const home = mkdtempSync(join(tmpdir(), "cd-mod-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "cd-mod-cwd-"));
    const proj = join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(proj, { recursive: true });
    const rows = [0, 1, 2].map((i) => JSON.stringify({ type: "assistant", uuid: `u${i}`, sessionId: "sess-1", timestamp: new Date(now - idleMin * MIN - (2 - i) * MIN).toISOString(), message: { id: `m${i}`, model: "claude-opus-5-5", content: [], usage: { input_tokens: 10, cache_read_input_tokens: i ? 500_000 : 0, cache_creation_input_tokens: i ? 20_000 : 520_000, output_tokens: 200, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: i ? 20_000 : 520_000 } } } }));
    writeFileSync(join(proj, "sess-1.jsonl"), rows.join("\n") + "\n");
    return { home, cwd };
}
test("after a turn: the readings reach the limits ledger and the cost ledger through the CLI, and the band shows the cold return with its button", async () => {
    const now = Date.now();
    const { home, cwd } = sessionHome(80, now);
    const s = engine(home, { cwd, now });
    await fire(s, "session.start", { cwd, surface: "desktop", isInteractive: true }, (e) => ({ cwd: e.cwd }));
    assert.deepEqual(s.commands, [COMMAND]);
    const reset = new Date(now + 2 * 3600e3).toISOString();
    const echoed = await fire(s, "session.measure", { context: { tokens: 520_010, window: 1_000_000 }, rateLimits: [{ kind: "five_hour", percentUsed: 41.5, resetsAt: reset }, { kind: "seven_day", percentUsed: 12 }], cost: { usd: 9.87 }, changed: ["rateLimits", "cost"] }, (e) => ({ changed: e.changed }));
    assert.deepEqual(echoed, { changed: ["rateLimits", "cost"] }, "the engine's answer passes through");
    assert.deepEqual(s.runs[0].slice(1), [cli, "mod", "measure"]);
    // The limits ledger, in the status line's format: what `limits` reads.
    const limits = readFileSync(join(home, ".claude", ".context-doctor-limits.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(limits.map((l) => [l.app, l.w, l.pct, l.reset]), [["claude", "five_hour", 41.5, Math.round(Date.parse(reset) / 1000)], ["claude", "seven_day", 12, undefined]]);
    const viaStatusLine = spawnSync(process.execPath, [cli, "limits", "--json"], { encoding: "utf8", env: sandboxEnv(home) });
    assert.equal(viaStatusLine.status, 0, viaStatusLine.stderr);
    // Claude Code's cost beside ours.
    const cost = readCostLines(0, join(home, ".claude", ".context-doctor-session-cost.jsonl"));
    assert.equal(cost.length, 1);
    assert.equal(cost[0].sid, "sess-1");
    assert.equal(cost[0].cc, 9.87);
    assert.ok(cost[0].cd > 0);
    assert.equal(cost[0].model, "claude-opus-5-5");
    const d = state().data;
    assert.equal(d.tokens, 520_010);
    assert.equal(d.ttlMs, 60 * MIN);
    assert.ok(d.rewriteUsd > 0 && d.perMessageUsd > d.afterCompactPerMessageUsd);
    // The band: a cold return over 150k, with the button; none while a turn runs; the engine's own when off.
    const tree = await render(s, "AbovePrompt", "desktop", { hasSurvey: false, isWorking: false });
    assert.match(texts(tree)[0], /^context-doctor: idle 1h 2\dm, the cache expired: your next message re-writes 520k tokens \(~\$\d+\.\d\d\) · session \$/);
    assert.ok(button(tree, "cd-compact"));
    assert.equal(await render(s, "AbovePrompt", "desktop", { isWorking: true }), "ENGINE");
    assert.equal(await render(s, "AbovePrompt", "desktop", { hasSurvey: true }), "ENGINE");
    assert.equal(await render(s, "AbovePrompt", "mobile", {}), "ENGINE");
    // Nothing compacts without the press; the press compacts once and counts it.
    assert.equal(s.compacts, 0);
    await button(tree, "cd-compact").props.onPress({});
    assert.equal(s.compacts, 1);
    const ev = readCostLines(0, join(home, ".claude", ".context-doctor-session-cost.jsonl")).filter((l) => l.ev);
    assert.deepEqual(ev.map((l) => [l.ev, l.tokens]), [["compact", 520_010]]);
    // The old context's figures are gone: no second offer for it.
    assert.equal(await render(s, "AbovePrompt", "desktop", {}), "ENGINE");
});
test("after /clear or a resume the band is gone: no Compact first for the next session on the old one's figures", async () => {
    for (const reason of ["clear", "resume"]) {
        const now = Date.now();
        const { home, cwd } = sessionHome(80, now);
        const s = engine(home, { cwd, now });
        await fire(s, "session.start", { cwd, surface: "desktop", isInteractive: true });
        await fire(s, "session.measure", { context: { window: 1e6 }, rateLimits: [], changed: ["context"] }, () => ({ changed: ["context"] }));
        assert.ok(button(await render(s, "AbovePrompt", "desktop", {}), "cd-compact"), reason);
        // The process goes on under another session id; Claude Code raises no session.start for it.
        const ended = await fire(s, "session.end", { reason, sessionId: "sess-1", resume: { id: "sess-1" } }, (e) => ({ sessionId: e.sessionId }));
        assert.deepEqual(ended, { sessionId: "sess-1" }, "the engine's end step still runs");
        assert.equal(await render(s, "AbovePrompt", "desktop", {}), "ENGINE", reason);
        assert.equal(await render(s, "AbovePrompt", "terminal", {}), "ENGINE", reason);
        assert.equal(s.compacts, 0);
    }
});
test("the compact button: a turn in flight is a toast, not a compaction; Hide hides it", async () => {
    const now = Date.now();
    const { home, cwd } = sessionHome(80, now);
    const s = engine(home, { cwd, now, compactRejects: true });
    await fire(s, "session.start", { cwd, surface: "desktop", isInteractive: true });
    await fire(s, "session.measure", { context: { window: 1e6 }, rateLimits: [], changed: ["context"] }, () => ({ changed: ["context"] }));
    const tree = await render(s, "AbovePrompt", "terminal", {});
    await button(tree, "cd-compact").props.onPress({});
    assert.equal(s.compacts, 0);
    assert.match(s.toasts[0], /busy; compact once the turn ends/);
    await button(tree, "cd-hide").props.onPress({});
    assert.equal(await render(s, "AbovePrompt", "terminal", {}), "ENGINE");
});
test("graceful: no Node for the CLI keeps Claude Code's own figure; CONTEXT_DOCTOR_NO_MOD=1 registers nothing and draws nothing; a short session draws nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "cd-mod-bare-"));
    const s = engine(home, { noProcess: true });
    await fire(s, "session.start", { cwd: home, surface: "desktop", isInteractive: true });
    await fire(s, "session.measure", { context: { window: 1e6 }, rateLimits: [], cost: { usd: 120 }, changed: ["cost"] });
    assert.equal(state().data?.ccUsd, 120);
    assert.equal(texts(await render(s, "AbovePrompt", "desktop", {}))[0], "context-doctor: session $120 (Claude Code's figure)");
    // The pane says why it has no plan rather than failing.
    await fire(s, "command.run", { command: COMMAND });
    await new Promise((r) => setTimeout(r, 20));
    assert.match(texts(await render(s, "Pane", "desktop", {}, PANE)).join("\n"), /could not run: spawn node ENOENT\. It needs Node\.js on the PATH/);
    const off = engine(home, { env: { CONTEXT_DOCTOR_NO_MOD: "1" } });
    await fire(off, "session.start", { cwd: home, surface: "desktop", isInteractive: true });
    assert.deepEqual(off.commands, []);
    await fire(off, "session.measure", { context: { window: 1e6 }, rateLimits: [{ kind: "five_hour", percentUsed: 50 }], cost: { usd: 600 }, changed: ["cost"] });
    assert.deepEqual(off.runs, []);
    assert.equal(await render(off, "AbovePrompt", "desktop", {}), "ENGINE");
    assert.ok(!existsSync(join(home, ".claude", ".context-doctor-limits.jsonl")));
    // An engine missing a call the mod makes at start: no throw, the session starts.
    const broken = engine(home);
    broken.$.command.register = async () => { throw new Error("no such call"); };
    assert.deepEqual(await fire(broken, "session.start", { cwd: home, surface: null, isInteractive: false }, (e) => ({ cwd: e.cwd })), { cwd: home });
    // A small, warm session: silence.
    const now = Date.now();
    const small = sessionHome(1, now);
    const q = engine(small.home, { cwd: small.cwd, now });
    await fire(q, "session.start", { cwd: small.cwd, surface: "desktop", isInteractive: true });
    await fire(q, "session.measure", { context: { window: 1e6 }, rateLimits: [], cost: { usd: 3 }, changed: ["cost"] });
    assert.equal(await render(q, "AbovePrompt", "desktop", {}), "ENGINE");
});
// -- The fix pane, pressed: the same files as the CLI ------------------------------------
/** The fix-qa fixture: two days of Opus 5.5 sessions writing 5-minute entries, so `cache-ttl` is available. */
function fixHome() {
    const now = Date.now();
    const h = mkdtempSync(join(tmpdir(), "cd-mod-fix-"));
    mkdirSync(join(h, ".claude"));
    writeFileSync(join(h, ".claude", "settings.json"), '{\n  "a": 1\n}');
    const proj = join(h, ".claude", "projects", "-tmp-p");
    mkdirSync(proj, { recursive: true });
    let n = 0;
    for (const d of [2, 1]) {
        const rows = [];
        for (let i = 0; i < 12; i++)
            rows.push(JSON.stringify({ type: "assistant", uuid: `q${n}`, timestamp: new Date(now - d * 864e5 + i * 12e5).toISOString(), message: { id: `mq${n++}`, model: "claude-opus-5-5", content: [], usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 500000, output_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 500000, ephemeral_1h_input_tokens: 0 } } } }));
        writeFileSync(join(proj, `s${d}.jsonl`), rows.join("\n") + "\n");
    }
    return h;
}
/**
 * Every file under `home`'s ~/.claude except the transcripts and caches: what
 * a fix writes. In the record (the one file that names its home and the time
 * of the press), the home and the times are normalized; every other file is
 * compared byte for byte.
 */
function snapshot(home) {
    const out = {};
    const base = join(home, ".claude");
    const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name !== "projects")
                    walk(p);
                continue;
            }
            if (/cache|\.lock$|hook-state|ledger/.test(e.name))
                continue;
            const text = readFileSync(p, "utf8");
            const record = () => text.replace(/"at": \d+/g, '"at": 0').split(JSON.stringify(home).slice(1, -1)).join("<HOME>");
            out[relative(base, p).split("\\").join("/")] = e.name === ".context-doctor-fixes.json" ? record() : text;
        }
    };
    walk(base);
    return out;
}
const runCli = (home, ...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: mkdtempSync(join(tmpdir(), "cd-mod-work-")), env: { ...sandboxEnv(home), CONTEXT_DOCTOR_CLAUDE_CODE_VERSIONS: "2.1.309" }, input: "" });
test("the pane: opened by its command, nothing applied until a press; Apply and Undo write exactly what `fix --apply` and `fix undo` write", async () => {
    const a = fixHome();
    const b = mkdtempSync(join(tmpdir(), "cd-mod-fix-b-"));
    cpSync(a, b, { recursive: true });
    const before = snapshot(a);
    assert.deepEqual(snapshot(b), before);
    const s = engine(a, { cwd: mkdtempSync(join(tmpdir(), "cd-mod-work-")) });
    await fire(s, "session.start", { cwd: a, surface: "desktop", isInteractive: true });
    const answer = await fire(s, "command.run", { command: COMMAND });
    assert.match(answer.text, /Nothing is applied until you press Apply/);
    assert.deepEqual(s.opened, [PANE]);
    for (let i = 0; i < 300 && state().loading; i++)
        await new Promise((r) => setTimeout(r, 50));
    assert.ok(state().plan, state().planError);
    assert.deepEqual(snapshot(a), before, "opening the pane and measuring changed nothing");
    let pane = await render(s, "Pane", "desktop", {}, PANE);
    const apply = button(pane, "apply:cache-ttl");
    assert.ok(apply, texts(pane).join("\n"));
    assert.equal(apply.props.label, "Apply");
    // Apply, pressed: the same files as the CLI's own apply.
    await apply.props.onPress({});
    assert.deepEqual(s.runs[s.runs.length - 1].slice(1), [cli, "fix", "--apply", "cache-ttl", "--json"]);
    const r = runCli(b, "fix", "--apply", "cache-ttl");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const appliedA = snapshot(a), appliedB = snapshot(b);
    assert.notDeepEqual(appliedA, before);
    assert.deepEqual(appliedA, appliedB);
    assert.equal(JSON.parse(appliedA["settings.json"]).promptCacheTtl, "1h");
    pane = await render(s, "Pane", "desktop", {}, PANE);
    assert.match(texts(pane).join("\n"), /Done: cache-ttl/);
    assert.equal(button(pane, "apply:cache-ttl"), undefined);
    const undo = button(pane, "undo:cache-ttl");
    assert.ok(undo);
    // Undo, pressed: the same files as `fix undo`, and the settings byte for byte as before.
    await undo.props.onPress({});
    assert.deepEqual(s.runs[s.runs.length - 1].slice(1), [cli, "fix", "undo", "cache-ttl"]);
    const u = runCli(b, "fix", "undo", "cache-ttl");
    assert.equal(u.status, 0, u.stderr);
    assert.deepEqual(snapshot(a), snapshot(b));
    assert.equal(snapshot(a)["settings.json"], before["settings.json"]);
});
test("the pane: a press while another fix holds the lock changes nothing and says so", { timeout: 60_000 }, async () => {
    const a = fixHome();
    const s = engine(a, { cwd: mkdtempSync(join(tmpdir(), "cd-mod-work-")) });
    await fire(s, "session.start", { cwd: a, surface: "desktop", isInteractive: true });
    await fire(s, "command.run", { command: COMMAND });
    for (let i = 0; i < 300 && state().loading; i++)
        await new Promise((r) => setTimeout(r, 50));
    const before = snapshot(a);
    writeFileSync(join(a, ".claude", ".context-doctor-fixes.lock"), "");
    const pane = await render(s, "Pane", "desktop", {}, PANE);
    await button(pane, "apply:cache-ttl").props.onPress({});
    assert.equal(state().last?.ok, false);
    assert.match(state().last.lines.join("\n"), /another context-doctor is changing settings/);
    assert.deepEqual(snapshot(a), before);
    assert.ok(button(await render(s, "Pane", "desktop", {}, PANE), "apply:cache-ttl"), "still offered");
});
// -- The plugin wiring ------------------------------------------------------------------
test("the plugin names the mod, and the mod imports nothing the mods runtime lacks", () => {
    const hooks = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8"));
    assert.deepEqual(hooks.modules, ["../dist/mod/register.js"]);
    assert.ok(hooks.hooks.PreModelSwitch, "the settings hook stays beside it");
    for (const f of ["register.js", "logic.js"]) {
        const src = readFileSync(join(root, "dist", "mod", f), "utf8");
        const imports = [...src.matchAll(/^import .* from "([^"]+)";?$/gm)].map((m) => m[1]);
        assert.deepEqual(imports, f === "register.js" ? ["./logic.js"] : [], f);
        assert.ok(!/\bimport\(/.test(src), `${f}: a module holding import() does not load`);
        assert.ok(!/\brequire\(/.test(src), f);
    }
});
