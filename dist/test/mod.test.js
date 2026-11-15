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
import { applyOutcome, band, bar, duration, fixArgv, KEEP_WARM_COMMAND, keepWarmRefusal, keepWarmStep, mergeLimits, money, outcome, paneRows, parseKeepWarm, parsePlan, parseUsage, passedThreshold, pctText, PING_EVERY_1H_MS, PING_EVERY_5M_MS, PING_PROMPT, pingOutcome, ringSvg, shortModel, thresholdsFrom, tokens, usageDue, usageText, usageView, withPresses } from "../mod/logic.js";
import { PING_EVERY_1H_MS as REPLAY_1H, PING_EVERY_5M_MS as REPLAY_5M } from "../coldreturns.js";
import { limitFitsOf, limitWindows, summarizeHistory } from "../usagepane.js";
import { sessionPriceThresholds } from "../sessionprice.js";
import { register, state, COMMAND, PANE, USAGE_COMMAND, USAGE_PANE } from "../mod/register.js";
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
test("band: a 5-minute cache warns in its last minute, not after every turn; the 1-hour cache in its last five", () => {
    const five = data({ ttlMs: 5 * MIN });
    assert.equal(band(five, T + MIN, "desktop").kind, "none", "a minute after the reply: four left, no band");
    assert.equal(band(five, T + 3.5 * MIN, "desktop").kind, "none");
    assert.equal(band(five, T + 4.5 * MIN, "desktop").kind, "warm");
    assert.equal(band(five, T + 7 * MIN, "desktop").kind, "expired");
    assert.equal(band(data(), T + 54 * MIN, "desktop").kind, "none");
    assert.equal(band(data(), T + 56 * MIN, "desktop").kind, "warm");
    assert.equal(band(five, T + MIN, "desktop", { always: true }).kind, "warm", "`always` keeps the clock up");
});
test("thresholds without the CLI: the mod reads the environment as the session price does", () => {
    for (const [raw, off] of [[undefined, undefined], ["", undefined], ["10, $50 200", undefined], ["50 10 50", undefined], ["nonsense", undefined], ["10", "1"], [undefined, "0"]]) {
        const env = { ...(raw !== undefined ? { CONTEXT_DOCTOR_SESSION_PRICE: raw } : {}), ...(off !== undefined ? { CONTEXT_DOCTOR_NO_SESSION_PRICE: off } : {}) };
        assert.deepEqual(thresholdsFrom(raw, off), sessionPriceThresholds(env), JSON.stringify(env));
    }
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
    // Ours above Claude Code's: a price, or rates context-doctor does not read; not "modelPricing", which it now reads from the managed files.
    assert.match(check.detail, /\. A price in context-doctor's table that is off, or contracted rates set by an MDM profile or server-managed settings/);
    assert.doesNotMatch(check.detail, /contracted rates Claude Code applies \(modelPricing\)/);
    // Ours below: Claude Code's ledger holds the compaction's own request, which no transcript row prices.
    const under = join(dir, "under.jsonl");
    recordSessionCost({ ts: T, sid: "s9", cc: 10, cd: 9, model: "claude-fable-5-2" }, under);
    assert.match(costCheck(30, T + 10, under).detail, /the largest gap is -10% \(\$9\.00 against \$10\.00, on claude-fable-5-2\)\. Claude Code's figure holds as billed what the transcript keeps no usage for and context-doctor only estimates \(a compaction's own request/);
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
    const s = { hooks: new Map(), $: undefined, runs: [], compacts: 0, commands: [], opened: [], toasts: [], now: opts.now ?? Date.now(), forks: [] };
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
            usage: async () => opts.usage ?? { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] },
        },
        agent: {
            list: async () => {
                if (opts.noAgentList)
                    throw new Error("no such call: agent.list");
                return opts.agents ?? [];
            },
        },
        ui: {
            open: async (p) => { s.opened.push(p.id); return { isPlaced: opts.isPlaced ?? true }; },
            // The terminal's table has no Svg; the Desktop app's has.
            resolve: (e) => ({ Box: "Box", Text: "Text", Button: "Button", ...(e?.surface === "terminal" ? {} : { Svg: "Svg" }) }),
            invalidate: () => { },
            toast: (t) => { s.toasts.push(t); },
        },
        command: { register: async (c) => { s.commands.push(c.name); return { command: c.name }; } },
        clock: { now: async () => s.now, every: (_ms, fn) => { s.tick = fn; return { cancel() { } }; } },
        env: { get: async (n) => opts.env?.[n] },
        ...(opts.noFork ? {} : {
            model: {
                fork: async (r) => {
                    s.forks.push(r.prompt);
                    // A warm ping by default: the context read, the fork's own tail uncached.
                    return opts.fork?.(s) ?? { isAnswered: true, text: "ok", usage: { input_tokens: 40, output_tokens: 3, cache_read_input_tokens: 520_000, cache_creation_input_tokens: 0 } };
                },
            },
        }),
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
    assert.deepEqual(s.commands, [COMMAND, USAGE_COMMAND, KEEP_WARM_COMMAND]);
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
test("a compaction Claude Code refuses for its own reason says that reason", async () => {
    const now = Date.now();
    const { home, cwd } = sessionHome(80, now);
    const s = engine(home, { cwd, now });
    s.$.session.compact = async () => { throw new Error("Not enough messages to compact."); };
    await fire(s, "session.start", { cwd, surface: "desktop", isInteractive: true });
    await fire(s, "session.measure", { context: { window: 1e6 }, rateLimits: [], changed: ["context"] }, () => ({ changed: ["context"] }));
    await button(await render(s, "AbovePrompt", "desktop", {}), "cd-compact").props.onPress({});
    assert.deepEqual(s.toasts, ["context-doctor: not compacted: Not enough messages to compact."]);
    // A rejection with no words of its own: the likely reason, said as one.
    s.$.session.compact = async () => { throw undefined; };
    await button(await render(s, "AbovePrompt", "desktop", {}), "cd-compact").props.onPress({});
    assert.match(s.toasts[1], /not compacted; Claude Code may be busy/);
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
    assert.equal(s.toasts[0], "context-doctor: not compacted: a turn is running");
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
    // Without the CLI the thresholds still follow the environment: a lower one, or none at all.
    const low = engine(home, { noProcess: true, env: { CONTEXT_DOCTOR_SESSION_PRICE: "5" } });
    await fire(low, "session.start", { cwd: home, surface: "desktop", isInteractive: true });
    await fire(low, "session.measure", { context: { window: 1e6 }, rateLimits: [], cost: { usd: 6 }, changed: ["cost"] });
    assert.equal(texts(await render(low, "AbovePrompt", "desktop", {}))[0], "context-doctor: session $6.00 (Claude Code's figure)");
    const none = engine(home, { noProcess: true, env: { CONTEXT_DOCTOR_NO_SESSION_PRICE: "1" } });
    await fire(none, "session.start", { cwd: home, surface: "desktop", isInteractive: true });
    await fire(none, "session.measure", { context: { window: 1e6 }, rateLimits: [], cost: { usd: 120 }, changed: ["cost"] });
    assert.equal(await render(none, "AbovePrompt", "desktop", {}), "ENGINE");
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
// -- The usage pane (F5) ---------------------------------------------------------------
const HOUR = 60 * MIN;
const usageData = (over = {}) => ({
    at: T,
    history: {
        at: T - 2 * MIN,
        periods: [
            { key: "today", label: "Today", usd: 42.1, tokens: 3_100_000, requests: 120, models: [{ model: "claude-opus-5-5", usd: 30, tokens: 2_000_000, requests: 80 }, { model: "claude-sonnet-5-5", usd: 12.1, tokens: 1_100_000, requests: 40 }] },
            { key: "7d", label: "7 days", usd: 841, tokens: 90_000_000, requests: 4000, models: [{ model: "claude-fable-5-2", usd: 841, tokens: 90_000_000, requests: 4000 }] },
            { key: "30d", label: "30 days", usd: 3490, tokens: 6_400_000_000, requests: 22_000, models: [] },
        ],
    },
    limits: [
        { window: "five_hour", label: "5-hour", pct: 31, at: T - 10 * MIN, resetsAt: T + 2 * HOUR + 10 * MIN, resetSince: false, perHour: 6.2, runsOutAt: T + 90 * MIN, beforeReset: true, usdPerPct: 1.2, relSe: 0.08 },
        { window: "seven_day", label: "Weekly", pct: 18, at: T - 10 * MIN, resetsAt: T + 3 * 24 * HOUR, resetSince: false },
    ],
    agents: [{ id: "a1", model: "claude-sonnet-5-5", contextTokens: 84_000, window: 200_000, usd: 0.42, requests: 9 }],
    ...over,
});
test("usage view: the context ring, both windows with their pace and dollars per 1%, today by model, a running subagent", () => {
    const v = usageView({ data: usageData(), live: { at: T, context: { tokens: 412_000, window: 1_000_000, percent: 41 }, model: "claude-opus-5-5" }, agents: [{ id: "a1", type: "Explore", description: "Find the auth code", status: "running" }, { id: "a2", type: "Plan", description: "done one", status: "completed" }], now: T });
    assert.deepEqual(v.context, { pct: 41, text: "412k of 1.0M tokens (41%) · Opus 5.5" });
    assert.deepEqual(v.limits.map((l) => [l.label, l.text, l.sub]), [
        ["5-hour", "31% · resets in 2h 10m · +6.2 points an hour lately, runs out in 1h 30m (before the reset)", "≈ $1.20 of list-price use per 1% (±8%), this window"],
        ["Weekly", "18% · resets in 3 days", undefined],
    ]);
    assert.equal(v.limitsNote, undefined);
    assert.deepEqual(v.periods.map((p) => p.text), ["Today $42.10 · 3.1M tokens", "7 days $841 · 90.0M tokens", "30 days $3,490 · 6400.0M tokens"]);
    assert.deepEqual(v.period.rows, [{ model: "Opus 5.5", text: "$30.00 · 2.0M tokens · 80 requests" }, { model: "Sonnet 5.5", text: "$12.10 · 1.1M tokens · 40 requests" }]);
    assert.deepEqual(v.agents, [{ key: "a1", head: "Explore: Find the auth code", text: "Sonnet 5.5 · context 84k of 200k · $0.42 so far" }], "a finished agent is not running");
    assert.equal(v.glance, "context 41% · today $42.10 · weekly 18% · 1 subagent");
    assert.equal(v.footer, "Dollars at list price, as context-doctor spend prices them; measured 2 min ago.");
    assert.match(usageText(v), /^context-doctor usage: context 41% · today \$42\.10 · weekly 18% · 1 subagent\nContext: 412k of 1\.0M tokens/);
    // The period buttons: another period's rows.
    assert.deepEqual(usageView({ data: usageData(), now: T, period: "7d" }).period.rows, [{ model: "Fable 5.2", text: "$841 · 90.0M tokens · 4,000 requests" }]);
    assert.deepEqual(usageView({ data: usageData(), now: T, period: "30d" }).period.rows, [{ model: "", text: "Nothing in Claude Code in this period." }]);
});
test("usage view: Ultra (no 5-hour window), no readings at all, Claude Code's newer reading over the ledger's, no agent list, nothing measured yet", () => {
    const ultra = usageView({ data: usageData({ limits: [usageData().limits[1]] }), now: T });
    assert.deepEqual(ultra.limits.map((l) => l.label), ["Weekly"]);
    assert.equal(ultra.limitsNote, "No 5-hour window on this plan (Ultra has none): the weekly limit only.");
    assert.match(usageView({ data: usageData({ limits: [] }), now: T }).limitsNote, /^No limit readings yet: Claude Code reports the windows on a Pro, Max or Ultra sign-in/);
    // session.measure's windows are newer than the ledger's: they win, and one the ledger lacks is shown from them alone.
    const live = usageView({ data: usageData({ limits: [usageData().limits[1]] }), live: { at: T, rateLimits: [{ kind: "seven_day", percentUsed: 19.5, resetsAt: new Date(T + 2 * 24 * HOUR).toISOString() }, { kind: "five_hour", percentUsed: 4 }, { kind: "spend_limit", percentUsed: 80 }] }, now: T });
    assert.deepEqual(live.limits.map((l) => [l.label, l.pct, l.text]), [["5-hour", 4, "4%"], ["Weekly", 19.5, "20% · resets in 2 days"]]);
    assert.deepEqual(mergeLimits(usageData().limits, { at: T - HOUR, rateLimits: [{ kind: "five_hour", percentUsed: 1 }] }).map((w) => w.pct), [31, 18], "an older live reading leaves the ledger's");
    const bare = usageView({ now: T });
    assert.equal(bare.context.text, "Measured after the session's first reply.");
    assert.equal(bare.agentsNote, "This Claude Code does not list subagents to mods.");
    assert.equal(bare.glance, "context-doctor usage");
    assert.equal(usageView({ now: T, agents: [] }).agentsNote, "No subagents running.");
    assert.equal(usageView({ now: T, loading: true }).footer, "Measuring your last 30 days…");
    assert.equal(usageView({ now: T, agents: [{ id: "x", type: "general-purpose", status: "running" }], data: usageData({ agents: [] }) }).agents[0].text, "measuring…");
    const reset = usageView({ data: usageData({ limits: [{ ...usageData().limits[0], resetSince: true }] }), now: T });
    assert.equal(reset.limits[0].text, "reset since the last reading (31% then)");
});
test("usage pieces: model names, bars, the ring, when the pane asks again", () => {
    assert.deepEqual(["claude-opus-5-5", "claude-haiku-4-5-20251001", "claude-fable-5-2", "claude-opus-5", "claude-opus-4-6[1m]", "gpt-5.5", undefined].map(shortModel), ["Opus 5.5", "Haiku 4.5", "Fable 5.2", "Opus 5", "Opus 4.6 (1M)", "gpt-5.5", "unknown model"]);
    assert.equal(bar(50, 10), "█████░░░░░");
    assert.equal(bar(130, 8), "████████");
    assert.equal(bar(NaN, 4), "░░░░");
    assert.deepEqual([pctText(0.4), pctText(41.4), pctText(100)], ["0.4%", "41%", "100%"]);
    const svg = ringSvg(41);
    assert.match(svg, /^<svg [^>]*viewBox="0 0 64 64">.*stroke-dasharray="66\.98 163\.36".*>41%<\/text><\/svg>$/);
    assert.match(ringSvg(97), /#d64545/);
    assert.ok(!/<script|on[a-z]+=/i.test(svg));
    // Never twice at once, never while closed; the history every 5 minutes; the subagents every 30 s while one runs or after a turn.
    const base = { open: true, loading: false, lastAt: T, historyAt: T, agentsRunning: 0 };
    assert.equal(usageDue({ ...base, open: false }, T + HOUR), false);
    assert.equal(usageDue({ ...base, loading: true }, T + HOUR), false);
    assert.deepEqual(usageDue({ ...base, lastAt: undefined }, T), { history: true });
    assert.deepEqual(usageDue(base, T + 5 * MIN), { history: true });
    assert.equal(usageDue(base, T + 4 * MIN), false, "nothing moved");
    assert.equal(usageDue({ ...base, agentsRunning: 1 }, T + 20_000), false);
    assert.deepEqual(usageDue({ ...base, agentsRunning: 1 }, T + 30_000), { history: false });
    assert.deepEqual(usageDue({ ...base, measuredAt: T + 1 }, T + 40_000), { history: false });
    assert.equal(parseUsage("{}"), undefined);
    assert.equal(parseUsage("x"), undefined);
});
test("usage history: today, 7 and 30 days by model, the six largest and the rest as one row", () => {
    const now = new Date(2026, 10, 15, 15, 0).getTime();
    const item = (daysAgo, model, usd) => ({ tool: "claude", ts: now - daysAgo * 864e5, project: "p", session: "s", model, input: 10, read: 1000, write: 100, output: 5, usd, inputUsd: 0, writeUsd: 0, readUsd: 0, outputUsd: 0, priced: model !== "mystery" });
    const items = [item(0.1, "claude-opus-5-5", 3), item(0.2, "claude-sonnet-5-5", 1), item(3, "claude-opus-5-5", 10), item(20, "claude-fable-5-2", 100), item(40, "claude-opus-5-5", 1000), item(25, "mystery", 0),
        ...["a", "b", "c", "d", "e"].map((m, i) => item(10, `claude-${m}-1`, 1 - i * 0.1))];
    const h = summarizeHistory(items, now);
    assert.deepEqual(h.periods.map((p) => [p.label, p.usd, p.requests]), [["Today", 4, 2], ["7 days", 14, 3], ["30 days", 118, 10]]);
    assert.equal(h.periods[0].tokens, 2 * 1115);
    const month = h.periods[2].models;
    assert.equal(month.length, 7);
    assert.deepEqual(month.slice(0, 3).map((m) => [m.model, m.usd]), [["claude-fable-5-2", 100], ["claude-opus-5-5", 13], ["claude-sonnet-5-5", 1]]);
    assert.deepEqual([month[6].model, month[6].usd, month[6].requests], ["3 other models", 1.3, 3]);
    assert.equal(h.unpriced, 1);
    assert.equal(usageView({ data: { at: now, history: h, limits: [], agents: [] }, now, period: "30d" }).period.rows[6].model, "3 other models");
});
test("usage limits from `limits`' per-reset view (F4): the current window's dollars per 1%, else the last with a figure; the latest move, dated; Ultra from the ledger", () => {
    const D = 24 * HOUR;
    const reset = (over) => ({ window: "seven_day", label: "Claude weekly", app: "claude", start: 0, resetsAt: 0, current: false, readings: 20, firstReading: 0, lastReading: 0, pctUsed: 40, pctMatched: 30, pctElsewhere: 0, stretches: 9, requests: 100, usd: 300, tokens: 1e8, byEntrypoint: [], byModel: [], versions: [], ...over });
    const r = {
        now: T, windows: [], readings: 40, noFiveHour: true,
        resets: [reset({ resetsAt: T - 7 * D, usdPerPct: 25, relSe: 0.1 }), reset({ resetsAt: T + 2 * D, current: true, usdPerPct: 5.04, relSe: 0.12 }), reset({ app: "codex", window: "codex:10080", resetsAt: T, usdPerPct: 1 })],
        changes: [{ window: "seven_day", label: "Claude weekly", kind: "reset", at: T - 7 * D, usdPerPctBefore: 25, usdPerPctAfter: 5.04, factor: 0.2016, sigma: 9, versionsBefore: [], versionsAfter: [] }],
    };
    const f = limitFitsOf(r);
    assert.deepEqual(f, { limitFits: { seven_day: { usdPerPct: 5.04, relSe: 0.12, current: true, resetsAt: T + 2 * D } }, limitMove: { window: "seven_day", at: T - 7 * D, before: 25, after: 5.04, factor: 0.2016 }, noFiveHour: true });
    // A new window with too few stretches: the last one that had a figure, said as such.
    const early = limitFitsOf({ ...r, resets: [r.resets[0], reset({ resetsAt: T + 6 * D, current: true })], changes: [], noFiveHour: false });
    assert.deepEqual(early, { limitFits: { seven_day: { usdPerPct: 25, relSe: 0.1, current: false, resetsAt: T - 7 * D } } });
    assert.deepEqual(limitFitsOf({ ...r, resets: [], changes: [], noFiveHour: false }), {});
    const data = usageData({ history: { ...usageData().history, ...f }, limits: limitWindows(T, f.limitFits, [{ ts: T - HOUR, app: "claude", window: "seven_day", pct: 30, resetsAt: T + 2 * D, windowMs: 7 * D }]) });
    const v = usageView({ data, now: T });
    assert.deepEqual(v.limits.map((l) => [l.label, l.sub]), [["Weekly", "≈ $5.04 of list-price use per 1% (±12%), this window; 1% moved from $25.00 to $5.04 7 days ago (5.0x less use per 1%)"]]);
    assert.equal(v.limitsNote, "No 5-hour window on this plan (Ultra has none): the weekly limit only.");
    const fromEarlier = usageView({ data: usageData({ limits: limitWindows(T, early.limitFits, [{ ts: T - HOUR, app: "claude", window: "seven_day", pct: 3, resetsAt: T + 6 * D, windowMs: 7 * D }]) }), now: T });
    assert.equal(fromEarlier.limits[0].sub, "≈ $25.00 of list-price use per 1% (±10%), in the last window with enough readings");
    // The 5-hour window not read yet on a plan that has one: no Ultra note.
    assert.equal(usageView({ data: usageData({ history: { ...usageData().history, noFiveHour: false }, limits: [usageData().limits[1]] }), now: T }).limitsNote, undefined);
});
/** A home with a session's main transcript (today and 3 days ago), a running subagent's, and a weekly-only limits ledger (Ultra). */
function usageHome(now = Date.now()) {
    const { home, cwd } = sessionHome(30, now);
    const proj = join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
    const row = (i, ts, model, ctx) => JSON.stringify({ type: "assistant", uuid: `x${i}`, timestamp: new Date(ts).toISOString(), message: { id: `mx${i}`, model, content: [], usage: { input_tokens: 10, cache_read_input_tokens: ctx - 1010, cache_creation_input_tokens: 1000, output_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 } } } });
    writeFileSync(join(proj, "old.jsonl"), [row(1, now - 3 * 864e5, "claude-fable-5-2", 300_000), row(2, now - 3 * 864e5 + MIN, "claude-fable-5-2", 310_000)].join("\n") + "\n");
    const sub = join(proj, "sess-1", "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "agent-a1.jsonl"), [JSON.stringify({ type: "user", agentId: "a1", isSidechain: true, message: { role: "user", content: "find it" } }), row(3, now - 2 * MIN, "claude-sonnet-5-5", 40_000), row(4, now - MIN, "claude-sonnet-5-5", 84_000)].join("\n") + "\n");
    writeFileSync(join(home, ".claude", ".context-doctor-limits.jsonl"), [JSON.stringify({ ts: now - 2 * HOUR, app: "claude", w: "seven_day", pct: 12, reset: Math.round((now + 3 * 864e5) / 1000) }), JSON.stringify({ ts: now - 20 * MIN, app: "claude", w: "seven_day", pct: 18, reset: Math.round((now + 3 * 864e5) / 1000) })].join("\n") + "\n");
    return { home, cwd };
}
const settle = async () => { for (let i = 0; i < 400 && state().usageLoading; i++)
    await new Promise((r) => setTimeout(r, 25)); };
test("the usage pane, from a fixture home: opened by its command, drawn on the desktop (a ring) and the terminal (a bar), as a widget, with no work on a draw", { timeout: 60_000 }, async () => {
    const now = Date.now();
    const { home, cwd } = usageHome(now);
    const s = engine(home, { cwd, now, agents: [{ id: "a1", type: "Explore", description: "Find the auth code", status: "running" }, { id: "a0", type: "Plan", description: "finished", status: "completed" }] });
    await fire(s, "session.start", { cwd, surface: "desktop", isInteractive: true });
    assert.deepEqual(s.commands, [COMMAND, USAGE_COMMAND, KEEP_WARM_COMMAND]);
    await fire(s, "session.measure", { context: { tokens: 520_010, window: 1_000_000, percent: 52 }, rateLimits: [{ kind: "seven_day", percentUsed: 18.4, resetsAt: new Date(now + 3 * 864e5).toISOString() }], cost: { usd: 3 }, changed: ["context"] }, () => ({ changed: ["context"] }));
    const answer = await fire(s, "command.run", { command: USAGE_COMMAND });
    assert.equal(answer.text, "Opened context-doctor's usage pane.");
    assert.deepEqual(s.opened, [USAGE_PANE]);
    await settle();
    assert.ok(state().usage, state().usageError);
    assert.deepEqual(s.runs[s.runs.length - 1].slice(1), [cli, "mod", "usage"]);
    assert.equal(state().usage.historyFrom, "measured");
    // Drawing only reads: no process, and well inside a hook's 10-second budget.
    const runs = s.runs.length;
    const t0 = performance.now();
    const desk = await render(s, "Pane", "desktop", { bodyColumns: 80, placement: "dock" }, USAGE_PANE);
    const drawMs = performance.now() - t0;
    assert.equal(s.runs.length, runs, "a draw runs nothing");
    assert.ok(drawMs < 50, `drawn in ${drawMs.toFixed(1)} ms`);
    const words = texts(desk).join("\n");
    const ring = find(desk, (n) => n.type === "Svg");
    assert.ok(ring, "the Desktop app gets the ring");
    assert.match(ring.props.source, /stroke-dasharray/);
    assert.equal(ring.props.alt, "Context 52% used");
    assert.match(words, /520k of 1\.0M tokens \(52%\) · Opus 5\.5/);
    assert.match(words, /Weekly\n█{2,}░+\n18% · resets in (2|3) days/);
    assert.match(words, /No 5-hour window on this plan \(Ultra has none\)/);
    assert.match(words, /Subagents running \(1\)\nExplore: Find the auth code\n {2}Sonnet 5\.5 · context 84k of (200k|1\.0M) · \$0\.\d\d so far/);
    assert.ok(button(desk, "period:today") && button(desk, "period:7d") && button(desk, "period:30d"));
    assert.match(button(desk, "period:today").props.label, /^Today \$\d+\.\d\d · [\d.]+[kM] tokens$/);
    assert.equal(button(desk, "period:today").props.variant, "primary");
    assert.match(words, /Opus 5\.5\n\$\d+\.\d\d · [\d.]+[kM] tokens · 3 requests/);
    // The week holds the 3-day-old session too; its button shows that period's rows.
    await button(desk, "period:7d").props.onPress({});
    const week = await render(s, "Pane", "desktop", { bodyColumns: 80 }, USAGE_PANE);
    assert.match(texts(week).join("\n"), /Fable 5\.2\n\$\d+\.\d\d · [\d.]+[kM] tokens · 2 requests/);
    assert.equal(button(week, "period:7d").props.variant, "primary");
    const term = await render(s, "Pane", "terminal", { bodyColumns: 70 }, USAGE_PANE);
    assert.equal(find(term, (n) => n.type === "Svg"), undefined, "the terminal has no Svg");
    // Bars sized to the pane: 70 columns leave 26 cells, held to 24.
    assert.ok(texts(term).filter((t) => /^[█░]+$/.test(t)).every((t) => t.length === 24), texts(term).join("|"));
    assert.match(texts(term).join("\n"), /520k of 1\.0M tokens/);
    const widget = await render(s, "Pane", "desktop", { placement: "widget" }, USAGE_PANE);
    assert.match(texts(widget).join(""), /^context 52% · today \$\d+\.\d\d · weekly 18% · 1 subagent$/);
    // Refresh measures again; a second look within 5 minutes reads the CLI's cache.
    await button(desk, "usage-refresh").props.onPress({});
    await settle();
    assert.equal(state().usage.historyFrom, "measured");
    const cached = spawnSync(process.execPath, [cli, "mod", "usage"], { input: JSON.stringify({ sessionId: "sess-1", cwd }), encoding: "utf8", env: sandboxEnv(home) });
    assert.equal(JSON.parse(cached.stdout).historyFrom, "cache");
    // Closed: the timer asks nothing more.
    await fire(s, "ui.close", { id: USAGE_PANE, origin: { kind: "person" } }, () => ({}));
    assert.equal(state().usageOpen, false);
});
test("the usage pane with nothing to draw it on (claude -p): the command answers with the same figures as text; an engine with no agent list says so; off registers nothing", { timeout: 60_000 }, async () => {
    const now = Date.now();
    const { home, cwd } = usageHome(now);
    const s = engine(home, { cwd, now, isPlaced: false, noAgentList: true, usage: { startedAt: now, context: { tokens: 90_000, window: 200_000, percent: 45 }, rateLimits: [] } });
    await fire(s, "session.start", { cwd, surface: null, isInteractive: false });
    const answer = await fire(s, "command.run", { command: USAGE_COMMAND });
    assert.match(answer.text, /^context-doctor usage: context 45% · today \$\d+\.\d\d · weekly 18%\nContext: 90k of 200k tokens \(45%\)/m);
    assert.match(answer.text, /\nWeekly limit: 18% · resets in/);
    assert.match(answer.text, /\nClaude Code: Today \$\d+\.\d\d · [\d.]+[kM] tokens · 7 days/);
    assert.match(answer.text, /\nThis Claude Code does not list subagents to mods\./);
    assert.equal(state().usageOpen, false, "no pane to keep up to date");
    const bare = engine(home, { cwd, now, noProcess: true, isPlaced: false });
    await fire(bare, "session.start", { cwd, surface: null, isInteractive: false });
    assert.match((await fire(bare, "command.run", { command: USAGE_COMMAND })).text, /context-doctor could not run: spawn node ENOENT\. It needs Node\.js on the PATH/);
    const off = engine(home, { env: { CONTEXT_DOCTOR_NO_MOD: "1" } });
    await fire(off, "session.start", { cwd: home, surface: "desktop", isInteractive: true });
    assert.deepEqual(off.commands, []);
    assert.match((await fire(off, "command.run", { command: USAGE_COMMAND })).text, /mod is off/);
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
// -- Keeping the cache warm ------------------------------------------------------------
test("keep-warm: the command's words; nothing but hours (and a dollar limit) is a yes", () => {
    assert.deepEqual(parseKeepWarm(""), { kind: "status" });
    assert.deepEqual(parseKeepWarm(undefined), { kind: "status" });
    assert.deepEqual(parseKeepWarm("off"), { kind: "off" });
    assert.deepEqual(parseKeepWarm("2h"), { kind: "arm", hours: 2, capUsd: 2 });
    assert.deepEqual(parseKeepWarm("90m $5"), { kind: "arm", hours: 1.5, capUsd: 5 });
    assert.deepEqual(parseKeepWarm("$5 1.5h"), { kind: "arm", hours: 1.5, capUsd: 5 });
    for (const bad of ["9h", "0h", "2h $50", "yes", "$5", "2h 3h", "forever"])
        assert.equal(parseKeepWarm(bad).kind, "error", bad);
    // The replay prices pings at the intervals the mod sends them.
    assert.equal(PING_EVERY_1H_MS, REPLAY_1H);
    assert.equal(PING_EVERY_5M_MS, REPLAY_5M);
});
test("keep-warm: a ping a tick before 55 minutes idle, counted from the last request or ping; stops at the hours, the dollars, a lapsed cache", () => {
    const d = data({ lastReplyAt: T, ttlMs: 60 * MIN, perMessageUsd: 0.1 });
    const kw = (over = {}) => ({ armedAt: T + MIN, until: T + MIN + 2 * 60 * MIN, capUsd: 2, spentUsd: 0, pings: 0, ...over });
    assert.deepEqual(keepWarmStep(undefined, d, T + 55 * MIN), { do: "wait" }, "never without a yes");
    assert.deepEqual(keepWarmStep(kw(), d, T + 50 * MIN), { do: "wait" });
    assert.deepEqual(keepWarmStep(kw(), d, T + 54.5 * MIN), { do: "ping" });
    assert.deepEqual(keepWarmStep(kw({ lastPingAt: T + 54.5 * MIN }), d, T + 60 * MIN), { do: "wait" }, "the ping refreshed it");
    assert.deepEqual(keepWarmStep(kw({ lastPingAt: T + 54.5 * MIN }), d, T + 109 * MIN), { do: "ping" });
    // A turn since: counted from its reply.
    assert.deepEqual(keepWarmStep(kw({ lastPingAt: T + 54.5 * MIN }), { ...d, lastReplyAt: T + 70 * MIN }, T + 109 * MIN), { do: "wait" });
    assert.equal(keepWarmStep(kw(), d, T + 121 * MIN).do, "stop", "its hours are up");
    assert.match(keepWarmStep(kw(), d, T + 121 * MIN).why, /its 2h 00m are up/);
    const cap = keepWarmStep(kw({ spentUsd: 1.95 }), d, T + 54.5 * MIN);
    assert.equal(cap.do, "stop");
    assert.match(cap.why, /would pass its \$2\.00 limit/);
    // The machine slept through the ping: a ping now would write the whole context, so none.
    assert.match(keepWarmStep(kw(), d, T + 61 * MIN).why, /expired before a ping could go out/);
    // A 5-minute cache: every 4.5 minutes.
    const five = { ...d, ttlMs: 5 * MIN };
    assert.deepEqual(keepWarmStep(kw(), five, T + 3.5 * MIN), { do: "wait" });
    assert.deepEqual(keepWarmStep(kw(), five, T + 4 * MIN), { do: "ping" });
    assert.equal(keepWarmStep(kw({ stopped: "you stopped it" }), d, T + 54.5 * MIN).do, "wait", "a stopped yes never pings again");
    // Refused: nothing measured, a cache already cold, no price.
    assert.match(keepWarmRefusal(undefined, T), /nothing measured/);
    assert.match(keepWarmRefusal(d, T + 70 * MIN), /already expired/);
    assert.match(keepWarmRefusal({ ...d, perMessageUsd: undefined }, T), /no known price/);
    assert.equal(keepWarmRefusal(d, T + 10 * MIN), undefined);
    // A warm ping read the context; one that wrote it found it gone.
    assert.equal(pingOutcome({ input_tokens: 40, output_tokens: 3, cache_read_input_tokens: 520_000, cache_creation_input_tokens: 0 }, d).warm, true);
    assert.equal(pingOutcome({ input_tokens: 40, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 520_000 }, d).warm, false);
    // Priced from the band's figures: 520k at $0.10 a read; 40 input at half the $5.20/520k write rate; output at 5x that.
    const usd = pingOutcome({ input_tokens: 40, output_tokens: 3, cache_read_input_tokens: 520_000, cache_creation_input_tokens: 0 }, d).usd;
    assert.ok(Math.abs(usd - (0.1 + 40 * 5e-6 + 3 * 25e-6)) < 1e-9, `${usd}`);
});
/** Run the band's clock once, and let what it started finish. */
async function tickOnce(s, at) {
    s.now = at;
    s.tick();
    for (let i = 0; i < 5; i++)
        await new Promise((r) => setImmediate(r));
}
test("keep-warm: only the command with hours starts it; it pings through $.model.fork, shows in the band with Stop, and stops for good", async () => {
    const now = Date.now();
    const { home, cwd } = sessionHome(10, now);
    const s = engine(home, { cwd, now });
    await fire(s, "session.start", { cwd, surface: "desktop", isInteractive: true }, (e) => ({ cwd: e.cwd }));
    await fire(s, "session.measure", { context: { tokens: 520_010, window: 1_000_000 }, rateLimits: [], cost: { usd: 9.87 }, changed: ["cost"] });
    const replyAt = state().data.lastReplyAt;
    // Measured, but not asked: the clock runs past 55 minutes and nothing is sent.
    await tickOnce(s, replyAt + 55 * MIN);
    assert.equal(s.forks.length, 0);
    s.now = now;
    const status = await fire(s, "command.run", { command: KEEP_WARM_COMMAND, args: "" });
    assert.match(status.text, /a ping reads ~520k tokens, ~\$0\.\d\d at list price, every 55 minutes/);
    assert.equal(state().kw, undefined, "a question is not a yes");
    const armed = await fire(s, "command.run", { command: KEEP_WARM_COMMAND, args: "2h $1" });
    assert.match(armed.text, /^Keeping this session's prompt cache warm for up to 2h 00m or \$1\.00, whichever comes first/);
    assert.match(armed.text, /never starts again by itself/);
    // The band says it is spending, with Stop.
    const tree = await render(s, "AbovePrompt", "desktop", {});
    assert.match(texts(tree)[0], /^context-doctor: keeping the cache warm for 2h 00m more: 0 pings, ~\$0\.00 of \$1\.00/);
    assert.ok(button(tree, "cd-keep-warm-stop"));
    await tickOnce(s, replyAt + 30 * MIN);
    assert.equal(s.forks.length, 0, "warm for another half hour: nothing to do");
    await tickOnce(s, replyAt + 54.6 * MIN);
    assert.deepEqual(s.forks, [PING_PROMPT]);
    assert.equal(state().kw.pings, 1);
    assert.ok(state().kw.spentUsd > 0);
    await tickOnce(s, replyAt + 60 * MIN);
    assert.equal(s.forks.length, 1, "the ping refreshed the cache");
    await tickOnce(s, replyAt + 109.2 * MIN);
    assert.equal(s.forks.length, 2);
    // The hours run out: stopped, said, and never again.
    await tickOnce(s, now + 2 * 60 * MIN + MIN);
    assert.match(state().kw.stopped, /are up/);
    assert.match(s.toasts.at(-1), /^context-doctor: stopped keeping the cache warm: its 2h 00m are up \(2 pings, ~\$0\.\d\d\)\.$/);
    await tickOnce(s, now + 3 * 60 * MIN);
    assert.equal(s.forks.length, 2);
    assert.notEqual(texts(await render(s, "AbovePrompt", "desktop", {}))[0]?.startsWith("context-doctor: keeping"), true);
    // The ledger has the yes, each ping and the stop.
    const evs = readCostLines(0, join(home, ".claude", ".context-doctor-session-cost.jsonl")).map((l) => l.ev).filter(Boolean);
    assert.deepEqual(evs, ["keep-warm-on", "keep-warm-ping", "keep-warm-ping", "keep-warm-off"]);
});
test("keep-warm: a ping that finds the cache cold, the dollar limit, Stop, a session's end and a Claude Code without fork each stop it", async () => {
    const now = Date.now();
    const { home, cwd } = sessionHome(10, now);
    const cold = engine(home, { cwd, now, fork: () => ({ isAnswered: true, text: "ok", usage: { input_tokens: 40, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 520_000 } }) });
    await fire(cold, "session.start", { cwd, surface: "desktop", isInteractive: true });
    await fire(cold, "session.measure", { context: { tokens: 520_010, window: 1_000_000 }, rateLimits: [], changed: [] });
    const replyAt = state().data.lastReplyAt;
    await fire(cold, "command.run", { command: KEEP_WARM_COMMAND, args: "4h" });
    await tickOnce(cold, replyAt + 54.6 * MIN);
    assert.match(state().kw.stopped, /found the cache cold \(read 0, wrote 520000 tokens\)/);
    await tickOnce(cold, replyAt + 109.2 * MIN);
    assert.equal(cold.forks.length, 1);
    // A dollar limit under one ping: refused at its time, nothing sent.
    const poor = engine(home, { cwd, now });
    await fire(poor, "session.start", { cwd, surface: "desktop", isInteractive: true });
    await fire(poor, "session.measure", { context: { tokens: 520_010, window: 1_000_000 }, rateLimits: [], changed: [] });
    await fire(poor, "command.run", { command: KEEP_WARM_COMMAND, args: "2h $0.01" });
    await tickOnce(poor, replyAt + 54.6 * MIN);
    assert.equal(poor.forks.length, 0);
    assert.match(state().kw.stopped, /would pass its \$0\.01 limit/);
    // Stop in the band; off; the end of the session.
    const s = engine(home, { cwd, now });
    await fire(s, "session.start", { cwd, surface: "desktop", isInteractive: true });
    await fire(s, "session.measure", { context: { tokens: 520_010, window: 1_000_000 }, rateLimits: [], changed: [] });
    await fire(s, "command.run", { command: KEEP_WARM_COMMAND, args: "2h" });
    button(await render(s, "AbovePrompt", "desktop", {}), "cd-keep-warm-stop").props.onPress();
    assert.equal(state().kw.stopped, "you stopped it");
    await tickOnce(s, replyAt + 54.6 * MIN);
    assert.equal(s.forks.length, 0);
    s.now = now;
    await fire(s, "command.run", { command: KEEP_WARM_COMMAND, args: "2h" });
    assert.match((await fire(s, "command.run", { command: KEEP_WARM_COMMAND, args: "off" })).text, /^Stopped keeping the cache warm \(0 pings/);
    await fire(s, "command.run", { command: KEEP_WARM_COMMAND, args: "2h" });
    await fire(s, "session.end", { reason: "clear", sessionId: "sess-1" }, (e) => ({ sessionId: e.sessionId }));
    assert.equal(state().kw.stopped, "the session ended");
    // Refused: a cache already cold, and an engine with no fork.
    const late = sessionHome(70, now);
    const l = engine(late.home, { cwd: late.cwd, now });
    await fire(l, "session.start", { cwd: late.cwd, surface: "desktop", isInteractive: true });
    await fire(l, "session.measure", { context: { tokens: 520_010, window: 1_000_000 }, rateLimits: [], changed: [] });
    assert.match((await fire(l, "command.run", { command: KEEP_WARM_COMMAND, args: "2h" })).text, /^Not started: the cache already expired/);
    assert.equal(state().kw, undefined);
    const old = engine(home, { cwd, now, noFork: true });
    await fire(old, "session.start", { cwd, surface: "desktop", isInteractive: true });
    await fire(old, "session.measure", { context: { tokens: 520_010, window: 1_000_000 }, rateLimits: [], changed: [] });
    assert.match((await fire(old, "command.run", { command: KEEP_WARM_COMMAND, args: "2h" })).text, /no \$\.model\.fork/);
    assert.equal(state().kw, undefined);
});
