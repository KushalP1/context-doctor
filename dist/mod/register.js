/**
 * context-doctor's mod: the status line's measurements and `fix`'s plan where
 * the status line never runs (Claude Code's Desktop app, the VS Code
 * extension), and in the terminal too.
 *
 * Shipped inside the plugin: hooks/hooks.json names this file under
 * `modules`. Claude Code runs mods from 2.1.287 (terminal), 2.1.286 (the
 * Desktop app's Code tab) and 2.1.299 (VS Code); an older one never loads
 * it and keeps the rest of the plugin.
 *
 *  - After each turn (`session.measure`) it runs `context-doctor mod measure`
 *    with Claude Code's rate-limit windows and session cost: the CLI keeps
 *    them (the limits ledger; Claude Code's cost beside ours) and answers
 *    with the band's figures.
 *  - A band above the prompt, only when it pays: the cache about to go cold
 *    or gone cold on a big context (with the re-write's price), the session
 *    past a price threshold. On a cold return a "Compact first" button calls
 *    `$.session.compact()`, between turns, on the press alone.
 *  - `/context-doctor-fix` opens a pane with `fix`'s plan and an Apply / Undo
 *    button per lever. Each press runs the CLI's own `fix --apply <id>` /
 *    `fix undo <id>`: the same lock, backup and record as in a terminal.
 *  - `/context-doctor-keep-warm 2h [$5]` keeps the prompt cache warm while
 *    the person is away: `$.model.fork` (a cache read of the main thread's
 *    last request, nothing in the transcript) a tick before every 55 minutes
 *    idle (4.5 on a 5-minute cache), until the hours or the dollars run out,
 *    a ping finds the cache cold, the session ends, or Stop. Never armed but
 *    by that command, never again by itself; the band shows it while it runs.
 *  - `/context-doctor-usage` opens the usage view the Desktop app dropped:
 *    the context ring and the limit windows from Claude Code's own figures,
 *    tokens and dollars by model for today, 7 and 30 days, and the running
 *    subagents with their model, context and cost so far. Drawing only reads
 *    what the mod holds; `context-doctor mod usage` refreshes it on the
 *    timer, only while the pane is open (usageDue).
 *
 * Nothing happens without a press or a command: no auto-compaction, no auto-apply, no ping. The
 * mod writes no file itself; the CLI writes ours. Off: CONTEXT_DOCTOR_NO_MOD=1.
 *
 * The mods runtime has no Node, so this file imports only ./logic.js (no
 * imports of its own) and reaches everything else through `$`. Claude Code
 * reads which calls a module makes from its source: `$` is passed only to
 * functions declared at the top of this file.
 */
import { applyOutcome, band, bar, DEFAULT_THRESHOLDS, fixArgv, KEEP_WARM_COMMAND, keepWarmTestEvery, keepWarmArmedText, keepWarmRefusal, keepWarmStatusText, keepWarmStep, keepWarmText, MODEL_CHANGE, money, outcome, paneRows, parseKeepWarm, parsePlan, parseUsage, pctText, PING_PROMPT, pingOutcome, ringSvg, RUNNING, thresholdsFrom, usageArgv, usageDue, usageText, usageView, withPresses } from "./logic.js";
export const COMMAND = "context-doctor-fix";
export const PANE = "context-doctor-fix";
export const USAGE_COMMAND = "context-doctor-usage";
export const USAGE_PANE = "context-doctor-usage";
/** How often the band checks whether its text changed (a countdown in minutes). */
const TICK_MS = 30_000;
/** `fix` measures 30 days of history: give it time. */
const FIX_TIMEOUT_MS = 10 * 60_000;
const MEASURE_TIMEOUT_MS = 30_000;
/** `mod usage` measures 30 days the first time (~3 s cold on 22,000 requests); later runs read its 5-minute cache. */
const USAGE_TIMEOUT_MS = 2 * 60_000;
const fresh = () => ({ off: false, always: false, thresholds: DEFAULT_THRESHOLDS, hidden: new Set(), drawn: "", compacting: false, loading: false, presses: new Map(), pinging: false, usageOpen: false, usageLoading: false, period: "today", usageDrawn: "" });
let S = fresh();
/** For tests: the state the hooks share. */
export const state = () => S;
/** The CLI beside this module, in the same plugin: dist/mod/register.js → dist/cli.js. */
function cliOf($) {
    // The module may import nothing but ./logic.js (no node:path): join with the
    // separator the root already uses, so Windows gets D:\…\dist\cli.js.
    const root = $.plugin.root;
    const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
    return `${root}${sep}dist${sep}cli.js`;
}
function bandKey(now, surface) {
    const b = band(S.data, now, surface, { hidden: S.hidden, always: S.always });
    return b.kind === "none" ? "" : `${b.key}|${b.text}`;
}
/** Hand the reading to the CLI; with no CLI (no node on PATH), keep what Claude Code said. */
async function measure($, e) {
    const fallback = { at: await $.clock.now(), coldMinTokens: 150_000, thresholds: S.thresholds, ...(e.cost ? { ccUsd: e.cost.usd } : {}) };
    try {
        const sessionId = await $.session.id();
        const cwd = await $.session.cwd();
        let model;
        try {
            model = await $.session.model();
        }
        catch { /* measured without it */ }
        if (S.live)
            S.live.model = model;
        const run = await $.process.run(["node", cliOf($), "mod", "measure"], { stdin: JSON.stringify({ sessionId, cwd, model, rateLimits: e.rateLimits, cost: e.cost, context: e.context }), timeoutMs: MEASURE_TIMEOUT_MS });
        const got = JSON.parse(run.stdout || "{}");
        S.data = got && typeof got.at === "number" ? got : fallback;
    }
    catch {
        S.data = fallback;
    }
}
/** The press is the consent: one compaction, between turns, and a line in the ledger that it was taken. */
async function compact($) {
    if (S.compacting)
        return;
    S.compacting = true;
    $.ui.invalidate("ui.render");
    const tokens = S.data?.tokens;
    try {
        const r = await $.session.compact();
        if (r && typeof r.skip === "string") {
            $.ui.toast(`context-doctor: not compacted: ${r.skip}`);
        }
        else {
            // The old context's figures no longer hold: the next turn measures the new one.
            if (S.data)
                S.data = { ...S.data, tokens: undefined, lastReplyAt: undefined, rewriteUsd: undefined };
            try {
                const sessionId = await $.session.id();
                await $.process.run(["node", cliOf($), "mod", "event"], { stdin: JSON.stringify({ sessionId, ev: "compact", tokens }), timeoutMs: MEASURE_TIMEOUT_MS });
            }
            catch { /* the count is a nicety */ }
        }
    }
    catch (err) {
        // Claude Code rejects a compaction while a turn runs, and for its own reasons (nothing to compact, a failed summary): say which.
        const why = err instanceof Error && err.message.trim() ? err.message.trim() : typeof err === "string" && err.trim() ? err.trim() : "";
        $.ui.toast(why ? `context-doctor: not compacted: ${why}` : "context-doctor: not compacted; Claude Code may be busy: compact once the turn ends.");
    }
    finally {
        S.compacting = false;
        $.ui.invalidate("ui.render");
    }
}
/** `fix --json`: the plan, measured on the history (it takes a while on a long one). */
async function loadPlan($) {
    S.loading = true;
    S.planError = undefined;
    $.ui.invalidate("ui.render");
    try {
        const run = await $.process.run(fixArgv("node", cliOf($), "plan"), { timeoutMs: FIX_TIMEOUT_MS });
        const p = parsePlan(run.stdout);
        if (p) {
            S.plan = p;
            S.presses.clear();
        }
        else {
            S.planError = `context-doctor fix did not answer with a plan (exit ${run.exitCode}): ${(run.stderr || run.stdout).trim().split("\n").slice(-2).join(" ")}`;
        }
    }
    catch (err) {
        S.planError = `context-doctor could not run: ${err instanceof Error ? err.message : String(err)}. It needs Node.js on the PATH Claude Code starts with.`;
    }
    S.loading = false;
    $.ui.invalidate("ui.render");
}
/** One press, one CLI run: `fix --apply <id>` or `fix undo <id>`. */
async function press($, op, id) {
    if (S.busy)
        return;
    S.busy = `${op}:${id}`;
    $.ui.invalidate("ui.render");
    try {
        const run = await $.process.run(fixArgv("node", cliOf($), op, id), { timeoutMs: FIX_TIMEOUT_MS });
        const r = op === "apply" ? applyOutcome(run.stdout, run.stderr, run.exitCode) : outcome(run.stdout, run.stderr, run.exitCode);
        S.last = { id, ...r };
        if (r.ok)
            S.presses.set(id, op === "apply" ? "applied" : "undone");
    }
    catch (err) {
        S.last = { id, ok: false, lines: [`could not run context-doctor: ${err instanceof Error ? err.message : String(err)}`] };
    }
    S.busy = undefined;
    $.ui.invalidate("ui.render");
}
function hide($, key) {
    S.hidden.add(key);
    $.ui.invalidate("ui.render");
}
function refresh($) {
    if (!S.loading)
        void loadPlan($);
}
/** A line in the session-cost ledger (the CLI writes it): keep-warm's yes, each ping, its stop. */
async function note($, ev, tokens) {
    try {
        const sessionId = await $.session.id();
        await $.process.run(["node", cliOf($), "mod", "event"], { stdin: JSON.stringify({ sessionId, ev, tokens }), timeoutMs: MEASURE_TIMEOUT_MS });
    }
    catch { /* the record is a nicety */ }
}
/** Stop for good: this yes is spent. A new one takes the command again. */
function stopKeepWarm($, why) {
    const kw = S.kw;
    if (!kw || kw.stopped)
        return;
    kw.stopped = why;
    $.ui.toast(`context-doctor: stopped keeping the cache warm: ${why} (${kw.pings} ping${kw.pings === 1 ? "" : "s"}, ~${money(kw.spentUsd)}).`);
    $.ui.invalidate("ui.render");
    void note($, "keep-warm-off");
}
/** One ping when one is due: `$.model.fork`, checked to have read the cache, priced against the limit. */
async function keepWarm($, now) {
    if (S.pinging)
        return;
    const step = keepWarmStep(S.kw, S.data, now, S.pingEveryMs);
    if (step.do === "stop")
        return stopKeepWarm($, step.why);
    if (step.do !== "ping" || !S.kw || !S.data)
        return;
    // No presence check: `claude plugin validate` refuses `$.model` read as a value (a module spells
    // `$` only as `$.noun.call(...)`), so an engine without the call is found by calling it.
    S.pinging = true;
    const kw = S.kw, d = S.data;
    try {
        const r = await $.model.fork({ prompt: PING_PROMPT });
        if (kw.stopped)
            return;
        const u = r.usage;
        const cost = u ? pingOutcome(u, d) : undefined;
        if (cost)
            kw.spentUsd += cost.usd;
        if (!r.isAnswered && r.reason === "nothing-to-fork")
            return stopKeepWarm($, "Claude Code holds no request to repeat (restarted, or /clear)");
        if (!r.isAnswered && !u)
            return stopKeepWarm($, `the ping failed (${r.reason}${r.status ? ` ${r.status}` : ""})`);
        kw.pings++;
        kw.lastPingAt = now;
        void note($, "keep-warm-ping", u?.cache_read_input_tokens);
        // A ping that wrote the context found it gone: the next would too.
        if (cost && !cost.warm)
            return stopKeepWarm($, `a ping found the cache cold (read ${u.cache_read_input_tokens}, wrote ${u.cache_creation_input_tokens} tokens)`);
        if (kw.spentUsd >= kw.capUsd)
            return stopKeepWarm($, `it reached its ${money(kw.capUsd)} limit`);
        $.ui.invalidate("ui.render");
    }
    catch (err) {
        stopKeepWarm($, err instanceof TypeError ? "this Claude Code has no $.model.fork" : `the ping could not be sent: ${err instanceof Error ? err.message : String(err)}`);
    }
    finally {
        S.pinging = false;
    }
}
/** The command: a status with no arguments, `off`, or the yes (hours and a dollar limit). */
async function keepWarmCommand($, args) {
    const req = parseKeepWarm(args);
    const now = await $.clock.now();
    if (req.kind === "error")
        return { text: `${req.text} Nothing was started.` };
    if (req.kind === "status")
        return { text: keepWarmStatusText(S.kw, S.data, now) };
    if (req.kind === "off") {
        if (!S.kw || S.kw.stopped)
            return { text: "Nothing to stop: the cache is not being kept warm." };
        stopKeepWarm($, "you stopped it");
        return { text: `Stopped keeping the cache warm (${S.kw.pings} ping${S.kw.pings === 1 ? "" : "s"}, ~${money(S.kw.spentUsd)}).` };
    }
    const refusal = keepWarmRefusal(S.data, now);
    if (refusal)
        return { text: `Not started: ${refusal}` };
    // A new yes replaces one in force, with what it spent counted from zero.
    if (S.kw && !S.kw.stopped)
        S.kw.stopped = "replaced by a new one";
    S.kw = { armedAt: now, until: now + req.hours * 3_600_000, capUsd: req.capUsd, spentUsd: 0, pings: 0 };
    void note($, "keep-warm-on", S.data.tokens);
    $.ui.invalidate("ui.render");
    return { text: keepWarmArmedText(S.kw, S.data) };
}
function refreshUsage($) {
    void loadUsage($, true, true);
}
function choosePeriod($, key) {
    S.period = key;
    $.ui.invalidate("ui.render");
}
/** The subagents Claude Code is running: one call, no file read. */
async function listAgents($) {
    try {
        const all = await $.agent.list();
        S.agents = Array.isArray(all) ? all.map((a) => ({ id: a.id, type: a.type, description: a.description, status: a.status, ...(a.name ? { name: a.name } : {}) })) : undefined;
    }
    catch {
        S.agents = undefined;
    }
}
const runningIds = () => (S.agents ?? []).filter((a) => !a.status || RUNNING.has(a.status)).map((a) => a.id);
/** `mod usage`: the history (from its 5-minute cache, or measured), the limits ledger, the running subagents. Off the draw, never two at once. */
async function loadUsage($, history, again = false) {
    if (S.usageLoading)
        return;
    S.usageLoading = true;
    S.usageError = undefined;
    if (S.usageOpen)
        $.ui.invalidate("ui.render");
    try {
        await listAgents($);
        const sessionId = await $.session.id();
        const cwd = await $.session.cwd();
        const run = await $.process.run(usageArgv("node", cliOf($)), { stdin: JSON.stringify({ sessionId, cwd, agents: runningIds(), history, fresh: again }), timeoutMs: USAGE_TIMEOUT_MS });
        const got = parseUsage(run.stdout);
        if (got)
            S.usage = { ...got, history: got.history ?? S.usage?.history };
        else
            S.usageError = `context-doctor mod usage did not answer (exit ${run.exitCode}): ${(run.stderr || run.stdout).trim().split("\n").slice(-1)[0] ?? ""}`;
    }
    catch (err) {
        S.usageError = `context-doctor could not run: ${err instanceof Error ? err.message : String(err)}. It needs Node.js on the PATH Claude Code starts with.`;
    }
    S.usageLastAt = await $.clock.now();
    S.usageLoading = false;
    if (S.usageOpen)
        $.ui.invalidate("ui.render");
}
/** Claude Code's figures at the moment the pane opens, before any turn measured them. */
async function liveNow($) {
    if (S.live)
        return;
    try {
        const u = await $.session.usage();
        S.live = { at: await $.clock.now(), context: u.context, rateLimits: u.rateLimits };
        try {
            S.live.model = await $.session.model();
        }
        catch { /* without it */ }
    }
    catch { /* the next turn measures */ }
}
function viewAt(now) {
    return usageView({ data: S.usage, live: S.live, agents: S.agents, period: S.period, loading: S.usageLoading, error: S.usageError, now });
}
/** While the pane is open: the subagents (one call), `mod usage` when it is due, and a redraw only when the words change. */
async function usageTick($, now) {
    if (!S.usageOpen)
        return;
    await listAgents($);
    const due = usageDue({ open: S.usageOpen, loading: S.usageLoading, lastAt: S.usageLastAt, historyAt: S.usage?.history?.at, measuredAt: S.live?.at, agentsRunning: runningIds().length }, now);
    if (due)
        void loadUsage($, due.history);
    const k = JSON.stringify(viewAt(now));
    if (k !== S.usageDrawn) {
        S.usageDrawn = k;
        $.ui.invalidate("ui.render");
    }
}
/** The countdown is in minutes: redraw only when the band's words change. */
async function tick($) {
    const now = await $.clock.now();
    await keepWarm($, now);
    const k = bandKey(now, "desktop") + bandKey(now, "terminal") + (S.kw && !S.kw.stopped ? keepWarmText(S.kw, now) : "");
    if (k !== S.drawn) {
        S.drawn = k;
        $.ui.invalidate("ui.render");
    }
    await usageTick($, now);
}
export function register(on) {
    S = fresh();
    on("session.start", async ($, e, next) => {
        try {
            S.off = (await $.env.get("CONTEXT_DOCTOR_NO_MOD")) === "1";
            S.always = (await $.env.get("CONTEXT_DOCTOR_MOD_BAND")) === "always";
            S.thresholds = thresholdsFrom(await $.env.get("CONTEXT_DOCTOR_SESSION_PRICE"), await $.env.get("CONTEXT_DOCTOR_NO_SESSION_PRICE"));
            S.pingEveryMs = keepWarmTestEvery(await $.env.get("CONTEXT_DOCTOR_KEEP_WARM_PING_MS"));
            if (!S.off) {
                await $.command.register({ name: "context-doctor-fix", description: "context-doctor: the fix plan, with an Apply and an Undo button per lever (nothing applies without a press)" });
                await $.command.register({ name: "context-doctor-usage", description: "context-doctor: the context ring, your limit windows, tokens and dollars by model (today, 7 and 30 days) and the running subagents" });
                $.clock.every(Math.min(TICK_MS, S.pingEveryMs ?? TICK_MS), () => void tick($));
                // Last: an engine that refuses it keeps the rest.
                await $.command.register({ name: KEEP_WARM_COMMAND, description: "context-doctor: keep the prompt cache warm while you step away, for up to the hours and dollars you give (the pings bill to your plan or key); off stops it", argumentHint: "<2h> [$5] | off" });
            }
        }
        catch {
            /* an engine without one of these: the mod stays quiet */
        }
        return next(e);
    });
    on("session.measure", async ($, e, next) => {
        const r = await next(e);
        if (S.off)
            return r;
        // The usage pane's ring and windows: Claude Code's own figures, kept as they came.
        S.live = { at: await $.clock.now(), context: e.context, rateLimits: e.rateLimits, ...(S.live?.model ? { model: S.live.model } : {}) };
        await measure($, e);
        $.ui.invalidate("ui.render");
        return r;
    });
    // A `/clear` or a resume ends this session and the process goes on under another, with no
    // session.start for it: the band's figures were the old session's, and its Compact first button
    // would compact the new one on them. Nothing is shown until the next turn measures the new one.
    on("session.end", async ($, e, next) => {
        // The yes was for that conversation: a ping now would keep the new one's cache warm unasked.
        try {
            stopKeepWarm($, "the session ended");
        }
        catch { /* ending anyway */ }
        S.data = undefined;
        // The next session's ring and subagents are its own; the history (every session's) stays.
        S.live = undefined;
        if (S.agents)
            S.agents = [];
        if (S.usage)
            S.usage = { ...S.usage, agents: [] };
        try {
            $.ui.invalidate("ui.render");
        }
        catch { /* ending anyway */ }
        return next(e);
    });
    on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
        if (S.off || e.props.hasSurvey)
            return next(e);
        const now = await $.clock.now();
        // Keeping warm spends money: while it runs, the band says so, with Stop, wherever it can draw.
        if (S.kw && !S.kw.stopped && e.surface !== "mobile") {
            const { Box, Text, Button } = $.ui.resolve(e);
            return h(Box, { flexDirection: "row", flexWrap: "wrap", columnGap: 1 }, h(Text, { dimColor: true }, keepWarmText(S.kw, now)), h(Button, { key: "cd-keep-warm-stop", label: "Stop", onPress: () => stopKeepWarm($, "you stopped it") }));
        }
        const b = band(S.data, now, e.surface, { hidden: S.hidden, always: S.always });
        // A compaction only runs between turns: no button while one runs.
        if (b.kind === "none" || (b.kind === "cold" && e.props.isWorking))
            return next(e);
        const { Box, Text, Button } = $.ui.resolve(e);
        const hideButton = h(Button, { key: "cd-hide", label: "Hide", onPress: () => hide($, b.key) });
        if (b.kind !== "cold")
            return h(Box, { flexDirection: "row", flexWrap: "wrap", columnGap: 1 }, h(Text, { dimColor: true }, b.text), hideButton);
        return h(Box, { flexDirection: "column" }, h(Text, { dimColor: true }, b.text), h(Box, { flexDirection: "row", flexWrap: "wrap", columnGap: 1 }, h(Button, { key: "cd-compact", label: S.compacting ? "Compacting…" : "Compact first", variant: "primary", onPress: () => compact($) }), h(Text, { dimColor: true }, b.compact), hideButton));
    });
    on("command.run", { command: "context-doctor-usage" }, async ($) => {
        if (S.off)
            return { text: "context-doctor's mod is off (CONTEXT_DOCTOR_NO_MOD=1)." };
        S.usageOpen = true;
        await liveNow($);
        const { isPlaced } = await $.ui.open({ id: USAGE_PANE, title: "context-doctor usage" });
        if (isPlaced) {
            void loadUsage($, true);
            return { text: "Opened context-doctor's usage pane." };
        }
        // Nothing draws the pane here (`claude -p`, a headless host): the same figures, as text.
        S.usageOpen = false;
        await loadUsage($, true);
        return { text: usageText(viewAt(await $.clock.now())) };
    });
    // An engine that does not know the event (the pane's timer then stops at the next session) keeps the rest of the mod.
    try {
        on("ui.close", async ($, e, next) => {
            if (e.id === USAGE_PANE)
                S.usageOpen = false;
            return next(e);
        });
    }
    catch { /* no ui.close here */ }
    on("ui.render", { component: "Pane", requestId: USAGE_PANE }, async ($, e) => {
        // Drawn with nothing held (after a reload): one look now; the timer keeps it from there.
        if (!S.usageOpen)
            S.usageOpen = true;
        if (!S.usage && !S.usageLoading && !S.usageError)
            void loadUsage($, true);
        const v = viewAt(await $.clock.now());
        const { Box, Text, Button, Svg } = $.ui.resolve(e);
        if (e.props.placement === "widget")
            return h(Box, { flexDirection: "column" }, h(Text, null, v.glance));
        const cols = typeof e.props.bodyColumns === "number" ? e.props.bodyColumns : 60;
        const barWidth = Math.max(8, Math.min(24, cols - 44));
        const ring = e.surface !== "terminal" ? Svg : undefined;
        const head = (t) => h(Text, { bold: true }, t);
        const dim = (t) => h(Text, { dimColor: true }, t);
        const body = [];
        body.push(head("Context"));
        if (v.context.pct !== undefined) {
            body.push(h(Box, { flexDirection: "row", columnGap: 1, alignItems: "center" }, ring ? h(ring, { source: ringSvg(v.context.pct), alt: `Context ${pctText(v.context.pct)} used`, width: 64, height: 64 }) : h(Text, null, bar(v.context.pct, barWidth)), h(Text, null, v.context.text)));
        }
        else
            body.push(dim(v.context.text));
        body.push(h(Box, { marginTop: 1 }, head("Limits")));
        for (const l of v.limits) {
            body.push(h(Box, { key: `limit:${l.key}`, flexDirection: "column" }, h(Box, { flexDirection: "row", columnGap: 1 }, h(Box, { width: 8 }, h(Text, null, l.label)), h(Text, null, bar(l.pct, barWidth)), h(Text, null, l.text)), ...(l.sub ? [dim(l.sub)] : [])));
        }
        if (v.limitsNote)
            body.push(dim(v.limitsNote));
        body.push(h(Box, { marginTop: 1 }, head("Claude Code: tokens and dollars by model")));
        if (v.periods.length) {
            body.push(h(Box, { flexDirection: "row", flexWrap: "wrap", columnGap: 1 }, ...v.periods.map((p) => h(Button, { key: `period:${p.key}`, label: p.text, ...(v.period?.key === p.key ? { variant: "primary" } : {}), onPress: () => choosePeriod($, p.key) }))));
            for (const r of v.period?.rows ?? [])
                body.push(h(Box, { flexDirection: "row", columnGap: 1 }, h(Box, { width: 14 }, h(Text, null, r.model)), dim(r.text)));
        }
        if (v.historyNote)
            body.push(dim(v.historyNote));
        body.push(h(Box, { marginTop: 1 }, head(`Subagents running${v.agents.length ? ` (${v.agents.length})` : ""}`)));
        for (const a of v.agents)
            body.push(h(Box, { key: `agent:${a.key}`, flexDirection: "column" }, h(Text, null, a.head), dim(`  ${a.text}`)));
        if (v.agentsNote)
            body.push(dim(v.agentsNote));
        body.push(h(Box, { flexDirection: "row", columnGap: 1, marginTop: 1, flexWrap: "wrap" }, h(Button, { key: "usage-refresh", label: S.usageLoading ? "Measuring…" : "Refresh", onPress: () => refreshUsage($) }), ...(v.footer ? [dim(v.footer)] : [])));
        return h(Box, { flexDirection: "column" }, ...body);
    });
    on("command.run", { command: "context-doctor-fix" }, async ($) => {
        if (S.off)
            return { text: "context-doctor's mod is off (CONTEXT_DOCTOR_NO_MOD=1)." };
        await $.ui.open({ id: PANE, title: "context-doctor fix" });
        if (!S.plan && !S.loading)
            void loadPlan($);
        return { text: "Opened context-doctor's fix plan. Nothing is applied until you press Apply." };
    });
    on("command.run", { command: KEEP_WARM_COMMAND }, async ($, e) => {
        if (S.off)
            return { text: "context-doctor's mod is off (CONTEXT_DOCTOR_NO_MOD=1)." };
        return keepWarmCommand($, e.args);
    });
    on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
        const { Box, Text, Button } = $.ui.resolve(e);
        const body = [h(Text, { bold: true }, "context-doctor fix: each lever, by what it would have saved you")];
        if (S.loading)
            body.push(h(Text, { dimColor: true }, "Measuring your history (30 days)…"));
        if (S.planError)
            body.push(h(Text, null, S.planError));
        const last = S.last;
        if (last)
            body.push(h(Box, { flexDirection: "column", marginTop: 1 }, ...[`${last.ok ? "Done" : "Not done"}: ${last.id}`, ...last.lines].map((l) => h(Text, { dimColor: last.ok }, l))));
        if (S.plan) {
            if (S.plan.recordProblem)
                body.push(h(Text, null, `⚠ ${S.plan.recordProblem}`));
            const rows = withPresses(paneRows(S.plan), S.presses);
            if (!rows.length)
                body.push(h(Text, { dimColor: true }, "Nothing to fix here."));
            for (const row of rows) {
                const buttons = [];
                if (row.apply)
                    buttons.push(h(Button, { key: `apply:${row.id}`, label: S.busy === `apply:${row.id}` ? "Applying…" : row.apply, ...(row.id === MODEL_CHANGE ? {} : { variant: "primary" }), onPress: () => press($, "apply", row.id) }));
                if (row.undo)
                    buttons.push(h(Button, { key: `undo:${row.id}`, label: S.busy === `undo:${row.id}` ? "Undoing…" : row.undo, onPress: () => press($, "undo", row.id) }));
                body.push(h(Box, { key: `row:${row.id}`, flexDirection: "column", marginTop: 1 }, h(Text, { bold: true }, row.head), ...row.lines.map((l) => h(Text, { dimColor: !(row.modelChange && l.startsWith("Model change")) }, l)), ...(buttons.length ? [h(Box, { flexDirection: "row", columnGap: 1 }, ...buttons)] : [])));
            }
            body.push(h(Text, { dimColor: true }, "Each figure is measured alone; the levers overlap, so together they save less. Undo puts back exactly what was there."));
        }
        body.push(h(Box, { flexDirection: "row", marginTop: 1 }, h(Button, { key: "refresh", label: S.loading ? "Measuring…" : "Refresh", onPress: () => refresh($) })));
        return h(Box, { flexDirection: "column" }, ...body);
    });
}
