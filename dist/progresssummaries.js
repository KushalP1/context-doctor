/**
 * Claude Code's subagent progress summaries, estimated: side requests no
 * transcript records. The `progress-summaries` lever of `fix`.
 *
 * While a background subagent runs, Claude Code asks a model every 30
 * seconds for a 3-5 word line about what it is doing (the text on its task
 * row). The request is made with `skipTranscript`, so no transcript row
 * carries it, and Claude Code bills it and counts it in its own cost
 * (anthropics/claude-code#86879 measured 22.7% of one subagent-heavy
 * session's requests). `CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES=1`
 * (2.1.318+, documented in 2.1.323) turns them off, and the requests with
 * them. The summary never enters the agent's context: the work is the same.
 *
 * Read from the 2.1.321 binary (the Desktop app's bundled Claude Code, with
 * `strings`; docs/spend.md has the details):
 *  - Who gets them. Only a subagent run in the background (the async
 *    runner), and there only when the host asked for them (the SDK's
 *    `agentProgressSummaries` option) or the session is interactive (a
 *    terminal, `entrypoint: "cli"`) and the fork gate is open (on unless
 *    CLAUDE_CODE_FORK_SUBAGENT=0) or coordinator mode is on. A fork launched
 *    in the background gets them in every mode. A foreground subagent gets
 *    them only when the host asked. Workflow agents never do. The Desktop
 *    app's Code tab runs Claude Code through the SDK, so its sessions are
 *    not interactive, and its bundle (5.11492) never sets the option: none.
 *  - How often. A timer every 30 s from the agent's start; a tick is skipped
 *    while the agent's transcript has fewer than 3 messages or has not
 *    changed since the last summary; it stops when the agent ends.
 *  - What each sends. Either the agent's whole conversation as a one-turn
 *    fork on the agent's own model (no cache write, so its prefix is read
 *    from the agent's cache), or ("short") at most ~1,500 tokens of notes
 *    about its recent steps, with prompt caching off and low effort, on the
 *    agent's own model (or Haiku). Which one is served per model from
 *    Anthropic's side and is not in any file here; Anthropic said on
 *    2026-11-09 (#86879) that the summaries now "consume 99% less", which is
 *    the notes. So both are priced: the notes as the low figure, the whole
 *    context as the high one.
 *
 * Estimated per subagent from what its transcript does record: the time of
 * each message (the ticks and whether the transcript changed), each reply's
 * prompt size and model (the context a fork would read, the rates). Each
 * summary's output is #86879's measured mean (65 tokens). Not counted: a
 * tick held while the agent's own request waits on a cold cache (it fires
 * later, not more often), and the thinking a summary may do.
 */
import { existsSync, readFileSync } from "node:fs";
import { pick, rowsOf } from "./scan.js";
import { requestCost } from "./pricing.js";
import { realModel } from "./tokens.js";
import { workflowRunOf } from "./subagents.js";
import { compareVersions } from "./modelswitch.js";
/** The variable the lever writes, and the value: Claude Code passes only "1" on to the sessions it starts in the background. */
export const PROGRESS_SUMMARIES_ENV = "CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES";
export const PROGRESS_SUMMARIES_OFF = "1";
/** The first Claude Code that reads it (its CHANGELOG, 2.1.323: "available since 2.1.318"). */
export const PROGRESS_SUMMARIES_SINCE = "2.1.318";
/** The summary timer (the binary's default; #86879 and #105981 measured 30-32 s). */
export const SUMMARY_TICK_MS = 30_000;
/** A short summary's prompt: notes capped at 2,000 - 500 tokens, plus its system prompt and instruction. */
export const NOTES_TOKENS = 1_850;
/** A fork summary's own instruction, after the agent's context. */
export const FORK_PROMPT_TOKENS = 150;
/** Each summary's output: #86879's measured mean (21,966 tokens over 339 summaries). */
export const SUMMARY_OUTPUT_TOKENS = 65;
/** How Claude Code reads the variable (a boolean: "1", "true", "yes", "on"). */
export const disablesSummaries = (v) => ["1", "true", "yes", "on"].includes(String(v ?? "").trim().toLowerCase());
/**
 * One subagent transcript's timeline: the first row's host and version, the
 * time of each message, and each reply's prompt size and model (once per
 * reply; its output is in the next prompt).
 */
export const PROGRESS_ROWS = {
    id: "progress-summaries.1",
    init: () => ({ head: false, ids: {} }),
    line(raw, row, out, st) {
        if (!raw.includes('"timestamp"'))
            return;
        let e;
        try {
            e = row();
        }
        catch {
            return;
        }
        if (!e || typeof e !== "object")
            return;
        if (!st.head && (typeof e.entrypoint === "string" || typeof e.version === "string")) {
            st.head = true;
            out.push({ t: "h", ...pick(e, ["entrypoint", "version"]) });
        }
        if (e.type !== "user" && e.type !== "assistant" && e.type !== "attachment")
            return;
        const ts = Date.parse(String(e.timestamp ?? ""));
        if (!Number.isFinite(ts))
            return;
        out.push({ t: "m", ts });
        const m = e.message;
        if (e.type !== "assistant" || !m?.usage)
            return;
        const id = typeof m.id === "string" ? m.id : undefined;
        if (id) {
            if (st.ids[id])
                return;
            st.ids[id] = 1;
        }
        const u = m.usage;
        const n = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
        const prompt = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
        out.push({ t: "r", ts, model: realModel(m.model), p: prompt, ...(u.speed === "fast" ? { speed: "fast" } : {}), ...(u.inference_geo === "us" ? { geo: "us" } : {}) });
    },
};
export function readAgentMeta(file) {
    const p = file.replace(/\.jsonl$/, ".meta.json");
    if (!existsSync(p))
        return undefined;
    try {
        const j = JSON.parse(readFileSync(p, "utf8"));
        if (!j || typeof j !== "object")
            return undefined;
        return { ...(typeof j.agentType === "string" ? { agentType: j.agentType } : {}), ...(typeof j.requestShape === "string" ? { requestShape: j.requestShape } : {}), ...(j.isFork === true ? { isFork: true } : {}) };
    }
    catch {
        return undefined;
    }
}
/**
 * Whether Claude Code (2.1.321's rules) wrote progress summaries for this
 * agent. `interactive`: whether its host counts as interactive (default: a
 * terminal session, entrypoint "cli").
 */
export function eligibility(meta, entrypoint, opts = {}) {
    if (opts.workflow || meta?.agentType === "workflow-subagent")
        return "workflow";
    if (!meta?.requestShape)
        return "unknown";
    if (meta.requestShape !== "background")
        return "foreground";
    if (meta.isFork)
        return "yes";
    const interactive = opts.interactive ?? ((ep) => ep === "cli");
    if (!interactive(entrypoint))
        return "host";
    return opts.forkGateOff ? "fork-gate-off" : "yes";
}
/**
 * The ticks a running agent's timer made and the summaries they sent, from
 * its timeline: every 30 s from its first row to its last, a summary when
 * it has 3+ messages and more than at the last summary. Only ticks in
 * [since, until] are counted.
 */
export function simulateAgent(recs, since = -Infinity, until = Infinity) {
    const msgs = recs.filter((r) => r.t === "m").map((r) => r.ts).sort((a, b) => a - b);
    const replies = recs.filter((r) => r.t === "r").sort((a, b) => a.ts - b.ts);
    const out = { calls: 0, notesUsd: 0, forkUsd: 0 };
    if (msgs.length < 3 || replies.length === 0)
        return out;
    const start = msgs[0];
    const end = msgs[msgs.length - 1];
    let n = 0, last = 0, ri = -1;
    for (let at = start + SUMMARY_TICK_MS; at <= end; at += SUMMARY_TICK_MS) {
        while (n < msgs.length && msgs[n] <= at)
            n++;
        while (ri + 1 < replies.length && replies[ri + 1].ts <= at)
            ri++;
        if (n < 3 || n === last)
            continue;
        last = n;
        if (at < since || at > until)
            continue;
        // The last reply's prompt is cached (the fork reads it); what came after it (its output, the
        // tool results) is new, as far as the next reply's prompt says; before any reply, the first prompt.
        const cur = ri >= 0 ? replies[ri] : undefined;
        const next = replies[ri + 1];
        const ref = cur ?? next;
        const model = ref.model;
        if (!model)
            continue;
        const read = cur ? cur.p : 0;
        const fresh = (next ? Math.max(0, next.p - read) : 0) + FORK_PROMPT_TOKENS;
        const b = { ...(ref.speed ? { speed: ref.speed } : {}), ...(ref.geo ? { inference_geo: ref.geo } : {}) };
        const fork = requestCost(model, { input_tokens: fresh, cache_read_input_tokens: read, cache_creation_input_tokens: 0, output_tokens: SUMMARY_OUTPUT_TOKENS, ...b }, at);
        const notes = requestCost(model, { input_tokens: NOTES_TOKENS, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: SUMMARY_OUTPUT_TOKENS, ...b }, at);
        if (!fork || !notes)
            continue;
        out.calls++;
        out.forkUsd += fork.totalUsd;
        out.notesUsd += notes.totalUsd;
    }
    return out;
}
/** The summaries of the subagents in `files` (their `.jsonl` transcripts), estimated. */
export function estimateProgressSummaries(files, opts = {}) {
    const r = { agents: 0, summarized: 0, calls: 0, notesUsd: 0, forkUsd: 0, none: {}, hosts: [] };
    const hosts = new Set();
    for (const file of files) {
        let recs;
        try {
            recs = rowsOf(file, PROGRESS_ROWS);
        }
        catch {
            continue;
        }
        // An agent that ran outside the window is not one of its agents (its file may be newer: a resumed session).
        if (!recs.some((x) => x.t === "m" && x.ts >= (opts.since ?? -Infinity) && x.ts <= (opts.until ?? Infinity)))
            continue;
        r.agents++;
        const head = recs.find((x) => x.t === "h");
        let why = eligibility(readAgentMeta(file), head?.entrypoint, { workflow: workflowRunOf(file) !== undefined, forkGateOff: opts.forkGateOff, interactive: opts.interactive });
        if (why === "yes" && opts.minVersion && !(head?.version && compareVersions(head.version, opts.minVersion) >= 0))
            why = "old";
        let until = opts.until ?? Infinity;
        // The variable set from offSince on: a Claude Code that reads it wrote none after.
        if (why === "yes" && opts.offSince !== undefined && head?.version && compareVersions(head.version, PROGRESS_SUMMARIES_SINCE) >= 0)
            until = Math.min(until, opts.offSince);
        if (why === "yes") {
            const first = recs.reduce((m, x) => (x.t === "m" && x.ts < m ? x.ts : m), Infinity);
            // An agent that started after the variable was set got none.
            if (first > until)
                why = "off";
            else {
                const s = simulateAgent(recs, opts.since, until);
                // One that ran under 30 s, or outside the window, sent none.
                if (s.calls)
                    r.summarized++;
                r.calls += s.calls;
                r.notesUsd += s.notesUsd;
                r.forkUsd += s.forkUsd;
                continue;
            }
        }
        if (why === "host" && head?.entrypoint)
            hosts.add(head.entrypoint);
        r.none[why] = (r.none[why] ?? 0) + 1;
    }
    r.hosts = [...hosts].sort();
    return r;
}
/** "the Desktop app", "the SDK or -p": a host as a person knows it. */
export function hostName(entrypoint) {
    if (entrypoint === "claude-desktop")
        return "the Desktop app";
    if (entrypoint === "claude-vscode")
        return "the VS Code extension";
    if (entrypoint === "sdk-cli")
        return "claude -p";
    if (entrypoint.startsWith("sdk"))
        return "the Agent SDK";
    return entrypoint;
}
