/**
 * `budget`: the spend budget the every-prompt hook enforces, on synthetic
 * transcripts in a throwaway home with the clock frozen. Each threshold said
 * once per period, the block in Claude Code's and Codex's form and Gemini
 * CLI's, a new day starting afresh, the status line's part, `doctor` and
 * `uninstall`; and the ledger, read by appends, equal to `spend`'s full read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { budgetStatePath, levelOf, parseBudget, periodEnd, periodSpend, periodStart } from "../budget.js";
import { claudeSpend } from "../spend.js";
import { renderStatusLine } from "../statusline.js";
import { clearScanMemo } from "../scan.js";
import { frozenClock } from "./history-fixture.js";
import { cleanEnv } from "./golden-run.js";
import { withSandboxHome } from "./sandbox.js";
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const HOUR = 3_600_000, DAY = 24 * HOUR;
/** Wednesday 2026-10-14, 15:00 UTC (the tests run with TZ=UTC). */
const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
let n = 0;
/** One reply: 100k uncached input on claude-sonnet-5 ($2 / 1M) is $0.20; `rows` > 1 writes it as several rows, its output settling on the last. */
function reply(ts, opts = {}) {
    const id = `msg_${n++}`;
    const rows = opts.rows ?? 1;
    return Array.from({ length: rows }, (_, k) => JSON.stringify({
        type: "assistant", uuid: opts.uuid && k === 0 ? opts.uuid : `u-${id}-${k}`, timestamp: new Date(ts + k).toISOString(),
        message: { id, model: "claude-sonnet-5", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 100_000, output_tokens: k === rows - 1 ? (opts.output ?? 0) : 1 } },
    }));
}
function setup() {
    const home = mkdtempSync(join(tmpdir(), "cd-budget-"));
    const cache = mkdtempSync(join(tmpdir(), "cd-budget-cache-"));
    const transcript = join(home, ".claude", "projects", "-work-app", "s1.jsonl");
    mkdirSync(dirname(transcript), { recursive: true });
    mkdirSync(join(home, "work", "app"), { recursive: true });
    writeFileSync(transcript, "");
    return { home, cache, transcript, env: cleanEnv(home, { CONTEXT_DOCTOR_CACHE_DIR: cache }) };
}
function run(env, args, input, now = NOW) {
    const r = spawnSync(process.execPath, [...frozenClock(now), cli, ...args], { env, input, encoding: "utf8", timeout: 60_000 });
    return { out: r.stdout, err: r.stderr, status: r.status };
}
const prompt = (event = "UserPromptSubmit") => JSON.stringify({ hook_event_name: event, session_id: "s1", cwd: "/work/app", prompt: "go on" });
test("parseBudget: dollars a day or a week, and a plain error otherwise", () => {
    assert.deepEqual(parseBudget("50/day"), { usd: 50, period: "day" });
    assert.deepEqual(parseBudget("$200/week"), { usd: 200, period: "week" });
    assert.deepEqual(parseBudget("7.5/d"), { usd: 7.5, period: "day" });
    assert.deepEqual(parseBudget("100 / wk"), { usd: 100, period: "week" });
    for (const bad of ["50", "50/month", "0/day", "-5/day", "abc", "/day"])
        assert.ok("error" in parseBudget(bad), bad);
});
test("periods: local midnight, and Monday for a week", () => {
    const saved = process.env.TZ;
    process.env.TZ = "UTC";
    try {
        assert.equal(periodStart("day", NOW), Date.UTC(2026, 9, 14));
        assert.equal(periodEnd("day", NOW), Date.UTC(2026, 9, 15));
        // 2026-10-14 is a Wednesday: the week began on Monday the 12th.
        assert.equal(new Date(NOW).getUTCDay(), 3);
        assert.equal(periodStart("week", NOW) <= NOW && NOW < periodEnd("week", NOW), true);
        assert.equal(periodEnd("week", NOW) - periodStart("week", NOW) >= 7 * DAY - HOUR, true);
        assert.equal(new Date(periodStart("week", NOW)).getDay(), 1, "a Monday");
        assert.deepEqual([0, 0.49, 0.5, 0.79, 0.8, 0.99, 1, 3].map((x) => levelOf(x, 1)), [0, 0, 50, 50, 80, 80, 100, 100]);
    }
    finally {
        if (saved === undefined)
            delete process.env.TZ;
        else
            process.env.TZ = saved;
    }
});
test("the hook says each threshold once a period, then holds prompts over it with --block, and a new day starts afresh", () => {
    const { home, cache, transcript, env } = setup();
    try {
        // No budget: silent, and nothing written for one.
        writeFileSync(transcript, [...reply(NOW - 2 * HOUR), ...reply(NOW - HOUR)].join("\n") + "\n");
        assert.equal(run(env, ["hook"], prompt()).out.trim(), "");
        assert.ok(!existsSync(join(home, ".claude", ".context-doctor-budget-state.json")), "no ledger without a budget");
        const set = run(env, ["budget", "1/day"]);
        assert.equal(set.status, 0, set.err);
        assert.match(set.out, /Budget: \$1 a day/);
        assert.match(set.out, /Today: \$0\.40 so far, 40%/);
        // $0.40: below 50%, nothing to say.
        assert.equal(run(env, ["hook"], prompt()).out.trim(), "");
        appendFileSync(transcript, reply(NOW - 30 * 60_000).join("\n") + "\n");
        const at60 = JSON.parse(run(env, ["hook"], prompt()).out);
        assert.match(at60.systemMessage, /\$0\.60 spent today: 60% of your \$1\/day budget/);
        assert.equal(run(env, ["hook"], prompt()).out.trim(), "", "said once");
        appendFileSync(transcript, reply(NOW - 20 * 60_000).join("\n") + "\n");
        assert.match(JSON.parse(run(env, ["hook"], prompt()).out).systemMessage, /80% of your \$1\/day budget/);
        // A reply written as two rows is one request.
        appendFileSync(transcript, reply(NOW - 10 * 60_000, { rows: 2 }).join("\n") + "\n");
        const over = JSON.parse(run(env, ["hook"], prompt()).out).systemMessage;
        assert.match(over, /\$1\.00 spent today: over your \$1\/day budget \(100%\)\. Raise it with context-doctor budget 5\/day/);
        assert.equal(run(env, ["hook"], prompt()).out.trim(), "", "100% said once");
        // The status line: the period's spend in place of the session's cost.
        const status = run(env, ["statusline"], JSON.stringify({ cost: { total_cost_usd: 0.42 } }));
        assert.equal(status.out.trim(), "$1.00/$1 today ⚠");
        // --block: over the budget, every prompt held, with how to lift it.
        assert.equal(run(env, ["budget", "1/day", "--block"]).status, 0);
        const held = JSON.parse(run(env, ["hook"], prompt()).out);
        assert.equal(held.decision, "block");
        assert.match(held.reason, /over your \$1\/day budget, so this prompt was held\. To go on, turn it off \(context-doctor budget off\) or raise it \(context-doctor budget 5\/day\)\. It resets at midnight\./);
        assert.equal(JSON.parse(run(env, ["hook"], prompt()).out).decision, "block", "every prompt, not once");
        // Gemini CLI's BeforeAgent denies.
        assert.equal(JSON.parse(run(env, ["hook"], prompt("BeforeAgent")).out).decision, "deny");
        // Not the other events: a session start or a compaction is never held.
        assert.equal(run(env, ["hook"], JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1" })).out.trim(), "");
        // The next day: yesterday's spend is not today's.
        const tomorrow = NOW + DAY;
        assert.equal(run(env, ["hook"], prompt(), tomorrow).out.trim(), "");
        assert.equal(run(env, ["statusline"], "{}", tomorrow).out.trim(), "$0.00/$1 today");
        // doctor names it (no hook installed in this home: a warning).
        const doc = run(env, ["doctor"]);
        assert.match(doc.out, /Spend budget.*\$1 a day.*no every-prompt hook is registered/);
        // off: gone, ledger too; the hook is silent again.
        assert.match(run(env, ["budget", "off"]).out, /Budget off/);
        assert.ok(!existsSync(join(home, ".claude", ".context-doctor-budget.json")));
        assert.ok(!existsSync(join(home, ".claude", ".context-doctor-budget-state.json")));
        assert.match(run(env, ["budget"]).out, /No spend budget set/);
    }
    finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(cache, { recursive: true, force: true });
    }
});
test("a week's budget counts from Monday, and Codex's spend counts with Claude Code's", () => {
    const { home, cache, transcript, env } = setup();
    try {
        // Sunday's reply is last week's; Monday's and today's count.
        writeFileSync(transcript, [...reply(Date.UTC(2026, 9, 11, 12)), ...reply(Date.UTC(2026, 9, 12, 9)), ...reply(NOW - HOUR)].join("\n") + "\n");
        const dir = join(home, ".codex", "sessions", "2026", "10", "14");
        mkdirSync(dir, { recursive: true });
        const tc = (t, total) => JSON.stringify({ timestamp: new Date(t).toISOString(), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: 80_000, cached_input_tokens: 0, output_tokens: 0 } } } });
        // gpt-5.5 at $1.25 / 1M: 80k uncached is $0.10.
        writeFileSync(join(dir, "rollout-a.jsonl"), [JSON.stringify({ timestamp: new Date(NOW - 2 * HOUR).toISOString(), type: "turn_context", payload: { cwd: "/work/app", model: "gpt-5.5" } }), tc(NOW - 2 * HOUR, 80_000)].join("\n") + "\n");
        const r = run(env, ["budget", "200/week", "--json"]);
        assert.equal(r.status, 0, r.err);
        const j = JSON.parse(r.out);
        assert.equal(j.period, "week");
        assert.equal(j.block, false);
        assert.ok(Math.abs(j.spent - 0.5) < 1e-9, `$0.40 of Claude Code since Monday + $0.10 of Codex: ${j.spent}`);
        assert.ok(Math.abs(j.byTool.codex - 0.1) < 1e-9);
        assert.match(run(env, ["budget"]).out, /This week: \$0\.50 so far, 0% \(Claude Code \$0\.40, Codex \$0\.10\)\. It resets on Monday\./);
        assert.equal(run(env, ["statusline"], "{}").out.trim(), "$0.50/$200 this week");
    }
    finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(cache, { recursive: true, force: true });
    }
});
test("the ledger, read by appends, equals spend's full read: forks once, output settled across an append", async () => {
    const { home, cache, transcript } = setup();
    const saved = process.env.CONTEXT_DOCTOR_CACHE_DIR, savedTz = process.env.TZ;
    process.env.CONTEXT_DOCTOR_CACHE_DIR = cache;
    process.env.TZ = "UTC";
    try {
        await withSandboxHome(home, () => {
            const start = periodStart("day", NOW);
            const full = () => { clearScanMemo(); return claudeSpend(start, NOW + HOUR).reduce((s, i) => s + i.usd, 0); };
            writeFileSync(transcript, [...reply(NOW - DAY), ...reply(NOW - 3 * HOUR, { uuid: "fork-me-0001-aaaa" }), ...reply(NOW - 2 * HOUR)].join("\n") + "\n");
            // A fork: the parent's rows copied (same uuids, same ids), then its own.
            const fork = join(dirname(transcript), "fork.jsonl");
            writeFileSync(fork, readFileSync(transcript, "utf8") + reply(NOW - HOUR).join("\n") + "\n");
            const first = periodSpend("day", NOW, home).usd;
            assert.ok(Math.abs(first - full()) < 1e-9, `${first} vs ${full()}`);
            assert.ok(Math.abs(first - 0.6) < 1e-9, "yesterday's reply out, the fork's copies once");
            // A reply streamed over two appends: its first row now, the row with its output later.
            const two = reply(NOW - 30 * 60_000, { rows: 2, output: 10_000 });
            appendFileSync(transcript, two[0] + "\n" + two[1].slice(0, 40));
            periodSpend("day", NOW, home);
            appendFileSync(transcript, two[1].slice(40) + "\n" + reply(NOW - 10 * 60_000).join("\n") + "\n");
            const after = periodSpend("day", NOW, home).usd;
            // 0.6 + 0.2 + 10k output at $10 / 1M ($0.10) + 0.2
            assert.ok(Math.abs(after - 1.1) < 1e-9, `${after}`);
            assert.ok(Math.abs(after - full()) < 1e-9, `${after} vs ${full()}`);
            // A transcript rewritten from scratch is read again in full.
            writeFileSync(transcript, reply(NOW - 5 * 60_000).join("\n") + "\n");
            assert.ok(Math.abs(periodSpend("day", NOW, home).usd - full()) < 1e-9);
        });
    }
    finally {
        if (saved === undefined)
            delete process.env.CONTEXT_DOCTOR_CACHE_DIR;
        else
            process.env.CONTEXT_DOCTOR_CACHE_DIR = saved;
        if (savedTz === undefined)
            delete process.env.TZ;
        else
            process.env.TZ = savedTz;
        clearScanMemo();
        rmSync(home, { recursive: true, force: true });
        rmSync(cache, { recursive: true, force: true });
    }
});
/** `fn` in a throwaway home and cache, local time UTC, the run memo emptied. */
async function inLedgerSandbox(fn) {
    const { home, cache, transcript } = setup();
    const saved = process.env.CONTEXT_DOCTOR_CACHE_DIR, savedTz = process.env.TZ;
    process.env.CONTEXT_DOCTOR_CACHE_DIR = cache;
    process.env.TZ = "UTC";
    try {
        await withSandboxHome(home, () => fn(home, transcript));
    }
    finally {
        if (saved === undefined)
            delete process.env.CONTEXT_DOCTOR_CACHE_DIR;
        else
            process.env.CONTEXT_DOCTOR_CACHE_DIR = saved;
        if (savedTz === undefined)
            delete process.env.TZ;
        else
            process.env.TZ = savedTz;
        clearScanMemo();
        rmSync(home, { recursive: true, force: true });
        rmSync(cache, { recursive: true, force: true });
    }
}
test("a reply streamed across midnight is yesterday's: its rows appended after the day's first read are not a new request", async () => {
    await inLedgerSandbox((home, transcript) => {
        const start = periodStart("day", NOW);
        // Its first row a millisecond before midnight, the next two (output settling) after it.
        const rows = reply(start - 1, { rows: 3, output: 5_000 });
        writeFileSync(transcript, rows[0] + "\n");
        assert.equal(periodSpend("day", NOW, home).usd, 0);
        appendFileSync(transcript, rows.slice(1).join("\n") + "\n" + reply(NOW - HOUR).join("\n") + "\n");
        const after = periodSpend("day", NOW, home).usd;
        clearScanMemo();
        const full = claudeSpend(start, NOW + HOUR).reduce((s, i) => s + i.usd, 0);
        // Counted again as today's, it was $0.45: its $0.20 of input and $0.05 of output.
        assert.ok(Math.abs(after - 0.2) < 1e-9 && Math.abs(after - full) < 1e-9, `${after} vs ${full}`);
    });
});
test("a ledger entry in a shape this version does not write is read again, not thrown on every prompt", async () => {
    await inLedgerSandbox((home, transcript) => {
        writeFileSync(transcript, reply(NOW - HOUR).join("\n") + "\n");
        assert.ok(Math.abs(periodSpend("day", NOW, home).usd - 0.2) < 1e-9);
        const st = JSON.parse(readFileSync(budgetStatePath(), "utf8"));
        st.files[transcript].k = null;
        writeFileSync(budgetStatePath(), JSON.stringify(st));
        assert.ok(Math.abs(periodSpend("day", NOW, home).usd - 0.2) < 1e-9);
        assert.ok(Array.isArray(JSON.parse(readFileSync(budgetStatePath(), "utf8")).files[transcript].k), "written back whole");
    });
});
test("the status line keeps its own cost without a budget, and shows the budget's part in its place with one", () => {
    const input = { model: { id: "claude-sonnet-5" }, context_window: { context_window_size: 200_000, current_usage: { input_tokens: 50_000 } }, cost: { total_cost_usd: 1.5 } };
    assert.match(renderStatusLine(input) ?? "", /· \$1\.50$/);
    assert.match(renderStatusLine(input, Date.now(), "$12/$50 today") ?? "", /· \$12\/\$50 today$/);
    assert.equal(renderStatusLine({}, Date.now(), "$12/$50 today"), "$12/$50 today");
});
test("budget's arguments: a bad amount, --block alone and extra words are usage errors; uninstall removes it", () => {
    const { home, cache, env } = setup();
    try {
        const bad = run(env, ["budget", "50/month"]);
        assert.equal(bad.status, 1);
        assert.match(bad.err, /not a budget: give dollars per day or per week/);
        assert.match(run(env, ["budget", "of"]).err, /Did you mean off\?/);
        assert.equal(run(env, ["budget", "--block"]).status, 1);
        assert.equal(run(env, ["budget", "50/day", "extra"]).status, 1);
        assert.equal(run(env, ["budget", "--blok"]).status, 1);
        assert.equal(run(env, ["budget", "50/day"]).status, 0);
        run(env, ["hook"], prompt());
        assert.ok(existsSync(join(home, ".claude", ".context-doctor-budget.json")));
        assert.ok(existsSync(join(home, ".claude", ".context-doctor-budget-state.json")));
        const u = run(env, ["uninstall"]);
        assert.match(u.out, /Removed \.context-doctor-budget\.json/);
        assert.ok(!existsSync(join(home, ".claude", ".context-doctor-budget.json")));
        assert.ok(!existsSync(join(home, ".claude", ".context-doctor-budget-state.json")));
    }
    finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(cache, { recursive: true, force: true });
    }
});
