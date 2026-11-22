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
 * From 2.1.328 (its CHANGELOG: "written by the default small fast model
 * from short notes ... using far fewer tokens", terminal sessions on the
 * Anthropic API; 2.1.327 moved Bedrock, Vertex and Foundry to notes on the
 * agent's own model) there is one way: the notes, on the small fast model.
 * The 2.1.329 binary agrees: the writer is ANTHROPIC_SMALL_FAST_MODEL's
 * default, the catalog's Haiku (`claude-haiku-5-5` on the Anthropic API),
 * and the notes are cut to 2,000 - 500 tokens less the label lines, by its
 * own count of about 3 characters a token, under a ~100-token system prompt
 * and a ~250-token instruction: NOTES_TOKENS stays the ceiling. So a
 * subagent whose transcript says `version` 2.1.328 or later is priced once,
 * at Haiku 5.5's rates (low and high the same); an older one as before.
 *
 * Read again from the 2.1.330 binary: that is a terminal session on the
 * Anthropic API's only. Per subagent, Claude Code reads its provider (from
 * CLAUDE_CODE_USE_*: the Claude Code gateway, Bedrock, Foundry, Anthropic on
 * AWS or Google Cloud, Mantle, Vertex, else the Anthropic API):
 *  - Bedrock, Vertex, Foundry or the gateway (CLAUDE_CODE_USE_GATEWAY): the
 *    notes, written by the subagent's OWN model ("release" mode).
 *  - Any other: a served flag (notes unless it says otherwise), and the
 *    writer is the small fast model only when ANTHROPIC_SMALL_FAST_MODEL and
 *    ANTHROPIC_DEFAULT_HAIKU_MODEL are both unset, the provider is the
 *    Anthropic API, and the API counts as Anthropic's: ANTHROPIC_BASE_URL
 *    unset or api.anthropic.com (or _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL),
 *    or the key is an Anthropic API key (sk-ant-api..., not
 *    ANTHROPIC_AUTH_TOKEN, a claude.ai sign-in or /login's managed key).
 *    With no writer, the summary is the whole context on the agent's own
 *    model, the pre-2.1.328 form. A plain ANTHROPIC_BASE_URL is not the
 *    "gateway": a proxy on 127.0.0.1 (context-doctor's autopilot) leaves the
 *    provider the Anthropic API and fails the base-URL test, so on a Claude
 *    sign-in it gets the whole context.
 * Which applied is told from the transcript where it can be (Bedrock and
 * Vertex model and message ids), else from the settings and environment
 * now (summaryRoute), autopilot's proxy counted from when autopilot was
 * turned on. Where neither tells (an API key that may or may not be used
 * behind a proxy), a range: Haiku notes low, the whole context high.
 *
 * Estimated per subagent from what its transcript does record: the time of
 * each message (the ticks and whether the transcript changed), each reply's
 * prompt size and model (the context a fork would read, the rates). Each
 * summary's output is #86879's measured mean (65 tokens). Not counted: a
 * tick held while the agent's own request waits on a cold cache (it fires
 * later, not more often), and the thinking a summary may do.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pick, rowsOf } from "./scan.js";
import { claudeDir } from "./claudedir.js";
import { effectiveEnv, settingsSources } from "./effective.js";
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
/** The first Claude Code that writes every summary from notes on the small fast model (its CHANGELOG). */
export const SMALL_NOTES_SINCE = "2.1.328";
/** The small fast model those run on: the 2.1.329 catalog's Haiku on the Anthropic API. */
export const SMALL_FAST_MODEL = "claude-haiku-5-5";
export const SMALL_FAST_MODEL_NAME = "Haiku 5.5";
/** A fork summary's own instruction, after the agent's context. */
export const FORK_PROMPT_TOKENS = 150;
/** Each summary's output: #86879's measured mean (21,966 tokens over 339 summaries). */
export const SUMMARY_OUTPUT_TOKENS = 65;
/** Nothing set: the Anthropic API, notes by Haiku. */
export const ANTHROPIC_API_ROUTE = { form: "haiku", why: "Claude Code on the Anthropic API" };
/** The cloud a reply's ids name: Bedrock's (`anthropic.`, region-prefixed, an ARN; `msg_bdrk_`), Vertex's (`@date`; `msg_vrtx_`). */
export function replyCloud(model, id) {
    const m = typeof model === "string" ? model : "";
    const i = typeof id === "string" ? id : "";
    if (/^(?:[a-z]{2,7}\.)?anthropic\.claude-[\w.-]*\d|^arn:aws[\w-]*:bedrock:/.test(m) || i.startsWith("msg_bdrk_"))
        return "bedrock";
    if (/^claude-[\w.-]+@/.test(m) || i.startsWith("msg_vrtx_"))
        return "vertex";
    return undefined;
}
const on = (v) => v !== undefined && !["", "0", "false", "no", "off"].includes(v.trim().toLowerCase());
/** Autopilot's own file and address (autopilot.ts autopilotPaths, proxyUrl), read here without its imports. */
const AUTOPILOT_CONFIG = ".context-doctor-autopilot.json";
/**
 * Which form Claude Code 2.1.330 uses for a terminal subagent on a
 * first-party model id, from the settings and environment as they are now
 * (read only). Autopilot's proxy counts from when autopilot was turned on
 * (its config file, written then); before it, the address it replaced.
 */
export function summaryRoute(deps = {}) {
    const env = deps.env ?? process.env;
    const sources = deps.sources ?? settingsSources({ home: deps.home, cwd: deps.cwd, env });
    const get = (n) => effectiveEnv(n, sources, env);
    const provider = [
        ["CLAUDE_CODE_USE_GATEWAY", "own-notes", "Claude Code is set to its gateway"],
        ["CLAUDE_CODE_USE_BEDROCK", "own-notes", "Claude Code is set to Amazon Bedrock"],
        ["CLAUDE_CODE_USE_FOUNDRY", "own-notes", "Claude Code is set to Microsoft Foundry"],
        ["CLAUDE_CODE_USE_ANTHROPIC_AWS", "whole", "Claude Code is set to Anthropic on AWS"],
        ["CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "whole", "Claude Code is set to Anthropic on Google Cloud"],
        ["CLAUDE_CODE_USE_MANTLE", "whole", "Claude Code is set to Mantle"],
        ["CLAUDE_CODE_USE_VERTEX", "own-notes", "Claude Code is set to Google Vertex AI"],
    ];
    for (const [name, form, why] of provider) {
        const v = get(name);
        if (v && on(v.value))
            return { form, why: `${why} (${v.where})` };
    }
    for (const name of ["ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"]) {
        const v = get(name);
        if (v)
            return { form: "whole", why: `${v.where} replaces the small model that writes them` };
    }
    const base = get("ANTHROPIC_BASE_URL");
    const route = byBaseUrl(base?.value, base?.where ?? "", sources, env, "an address that is not Anthropic's");
    if (!base)
        return route;
    // Autopilot's proxy: from when autopilot was turned on; before it, the address it replaced (none: the Anthropic API).
    const cfgPath = join(claudeDir(deps.home, env), AUTOPILOT_CONFIG);
    try {
        const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
        if (typeof cfg?.port === "number" && base.value.replace(/\/+$/, "") === `http://127.0.0.1:${cfg.port}`) {
            const prev = typeof cfg.previousBaseUrl === "string" && cfg.previousBaseUrl ? cfg.previousBaseUrl : undefined;
            return { ...byBaseUrl(base.value, base.where, sources, env, "context-doctor's autopilot proxy, not Anthropic's address"), since: statSync(cfgPath).mtimeMs, before: byBaseUrl(prev, `ANTHROPIC_BASE_URL=${prev} before autopilot`, sources, env, "an address that is not Anthropic's") };
        }
    }
    catch {
        /* no autopilot */
    }
    return route;
}
/** The form for an ANTHROPIC_BASE_URL: Anthropic's own host (or none) is the Anthropic API; any other needs an Anthropic API key for Haiku. */
function byBaseUrl(url, where, sources, env, label) {
    if (!url)
        return ANTHROPIC_API_ROUTE;
    let host = "";
    try {
        host = new URL(url).host;
    }
    catch { /* not a URL: not Anthropic's */ }
    const assume = effectiveEnv("_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL", sources, env);
    if (host === "api.anthropic.com" || (assume && on(assume.value)))
        return ANTHROPIC_API_ROUTE;
    const to = `Claude Code talks to ${label} (${where})`;
    if (effectiveEnv("ANTHROPIC_AUTH_TOKEN", sources, env))
        return { form: "whole", why: `${to} with ANTHROPIC_AUTH_TOKEN, not an Anthropic API key` };
    const key = effectiveEnv("ANTHROPIC_API_KEY", sources, env);
    const helper = sources.find((s) => typeof s.settings.apiKeyHelper === "string" && s.settings.apiKeyHelper.trim());
    if ((key && key.value.startsWith("sk-ant-api")) || helper) {
        return { form: "range", why: `${to}; they are notes by Haiku only if it uses your Anthropic API key (${key ? "ANTHROPIC_API_KEY" : "apiKeyHelper"}), and context-doctor cannot tell whether it does` };
    }
    if (key)
        return { form: "whole", why: `${to} with an ANTHROPIC_API_KEY that is not an Anthropic API key` };
    return { form: "whole", why: `${to} and you sign in with a Claude account, not an Anthropic API key` };
}
/** How Claude Code reads the variable (a boolean: "1", "true", "yes", "on"). */
export const disablesSummaries = (v) => ["1", "true", "yes", "on"].includes(String(v ?? "").trim().toLowerCase());
/**
 * One subagent transcript's timeline: the first row's host and version, the
 * time of each message, and each reply's prompt size and model (once per
 * reply; its output is in the next prompt).
 */
export const PROGRESS_ROWS = {
    id: "progress-summaries.2",
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
        const cloud = replyCloud(m.model, id);
        out.push({ t: "r", ts, model: realModel(m.model), p: prompt, ...(u.speed === "fast" ? { speed: "fast" } : {}), ...(u.inference_geo === "us" ? { geo: "us" } : {}), ...(cloud ? { cloud } : {}) });
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
/** How one agent's summaries were written: its transcript's cloud, else the route at its start. */
export function agentRoute(recs, route = ANTHROPIC_API_ROUTE) {
    const cloud = recs.find((x) => x.t === "r" && !!x.cloud)?.cloud;
    if (cloud)
        return { form: "own-notes", why: `the subagents ran on ${cloud === "bedrock" ? "Amazon Bedrock" : "Google Vertex AI"} (their model ids say so)` };
    const first = recs.reduce((m, x) => (x.t === "m" && x.ts < m ? x.ts : m), Infinity);
    let r = route;
    while (r.since !== undefined && r.before && first < r.since)
        r = r.before;
    return r;
}
/**
 * The ticks a running agent's timer made and the summaries they sent, from
 * its timeline: every 30 s from its first row to its last, a summary when
 * it has 3+ messages and more than at the last summary. Only ticks in
 * [since, until] are counted.
 */
export function simulateAgent(recs, since = -Infinity, until = Infinity, mode = "old") {
    const form = mode === true ? "haiku" : mode === false ? "old" : mode;
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
        // 2.1.328+ on the Anthropic API: the notes on the small fast model, the one way it sends them (the agent's fast mode is not the writer's).
        const small = form === "haiku" || form === "range" ? requestCost(SMALL_FAST_MODEL, { input_tokens: NOTES_TOKENS, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: SUMMARY_OUTPUT_TOKENS, ...(ref.geo ? { inference_geo: ref.geo } : {}) }, at) : undefined;
        const fork = form === "old" || form === "whole" || form === "range" ? requestCost(model, { input_tokens: fresh, cache_read_input_tokens: read, cache_creation_input_tokens: 0, output_tokens: SUMMARY_OUTPUT_TOKENS, ...b }, at) : undefined;
        const notes = form === "old" || form === "own-notes" ? requestCost(model, { input_tokens: NOTES_TOKENS, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: SUMMARY_OUTPUT_TOKENS, ...b }, at) : undefined;
        const [low, high] = form === "haiku" ? [small, small] : form === "own-notes" ? [notes, notes] : form === "whole" ? [fork, fork] : form === "range" ? [small, fork] : [notes, fork];
        if (!low || !high)
            continue;
        out.calls++;
        out.forkUsd += high.totalUsd;
        out.notesUsd += low.totalUsd;
    }
    return out;
}
/** The summaries of the subagents in `files` (their `.jsonl` transcripts), estimated. */
export function estimateProgressSummaries(files, opts = {}) {
    const r = { agents: 0, summarized: 0, calls: 0, smallCalls: 0, notesUsd: 0, forkUsd: 0, none: {}, hosts: [] };
    const routes = new Map();
    let value = 0;
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
                const recent = !!head?.version && compareVersions(head.version, SMALL_NOTES_SINCE) >= 0;
                const route = recent ? agentRoute(recs, opts.route) : undefined;
                const s = simulateAgent(recs, opts.since, until, route?.form ?? "old");
                // One that ran under 30 s, or outside the window, sent none.
                if (s.calls)
                    r.summarized++;
                r.calls += s.calls;
                r.notesUsd += s.notesUsd;
                r.forkUsd += s.forkUsd;
                value += route ? s.forkUsd : s.notesUsd;
                if (route?.form === "haiku")
                    r.smallCalls += s.calls;
                else if (route && s.calls) {
                    const k = `${route.form}\n${route.why}`;
                    const g = routes.get(k) ?? { form: route.form, why: route.why, calls: 0, agents: 0, lowUsd: 0, highUsd: 0 };
                    g.calls += s.calls;
                    g.agents++;
                    g.lowUsd += s.notesUsd;
                    g.highUsd += s.forkUsd;
                    routes.set(k, g);
                }
                continue;
            }
        }
        if (why === "host" && head?.entrypoint)
            hosts.add(head.entrypoint);
        r.none[why] = (r.none[why] ?? 0) + 1;
    }
    r.hosts = [...hosts].sort();
    if (routes.size) {
        r.routes = [...routes.values()].sort((a, b) => b.highUsd - a.highUsd);
        r.valueUsd = value;
    }
    return r;
}
/** A 2.1.328+ form in words: what each summary sent, and on what. */
export function formWords(form) {
    if (form === "haiku")
        return `short notes, written by ${SMALL_FAST_MODEL_NAME}`;
    if (form === "own-notes")
        return "short notes, written by the subagent's own model";
    if (form === "whole")
        return "the subagent's whole context, on its own model";
    return `short notes by ${SMALL_FAST_MODEL_NAME} (low) or the whole context (high)`;
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
