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
import { type Extractor } from "./scan.js";
import { type SettingsSource } from "./effective.js";
/** The variable the lever writes, and the value: Claude Code passes only "1" on to the sessions it starts in the background. */
export declare const PROGRESS_SUMMARIES_ENV = "CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES";
export declare const PROGRESS_SUMMARIES_OFF = "1";
/** The first Claude Code that reads it (its CHANGELOG, 2.1.323: "available since 2.1.318"). */
export declare const PROGRESS_SUMMARIES_SINCE = "2.1.318";
/** The summary timer (the binary's default; #86879 and #105981 measured 30-32 s). */
export declare const SUMMARY_TICK_MS = 30000;
/** A short summary's prompt: notes capped at 2,000 - 500 tokens, plus its system prompt and instruction. */
export declare const NOTES_TOKENS = 1850;
/** The first Claude Code that writes every summary from notes on the small fast model (its CHANGELOG). */
export declare const SMALL_NOTES_SINCE = "2.1.328";
/** The small fast model those run on: the 2.1.329 catalog's Haiku on the Anthropic API. */
export declare const SMALL_FAST_MODEL = "claude-haiku-5-5";
export declare const SMALL_FAST_MODEL_NAME = "Haiku 5.5";
/** A fork summary's own instruction, after the agent's context. */
export declare const FORK_PROMPT_TOKENS = 150;
/** Each summary's output: #86879's measured mean (21,966 tokens over 339 summaries). */
export declare const SUMMARY_OUTPUT_TOKENS = 65;
/**
 * How a terminal subagent's summaries were written on Claude Code 2.1.328+:
 * notes by Haiku ("haiku"), notes by the subagent's own model ("own-notes"),
 * its whole context on its own model ("whole"), or one of the first and
 * the last, which could not be told ("range").
 */
export type SummaryForm = "haiku" | "own-notes" | "whole" | "range";
/** The form, why in plain words, and (autopilot's proxy) from when: before `since`, `before`. */
export interface SummaryRoute {
    form: SummaryForm;
    why: string;
    since?: number;
    before?: SummaryRoute;
}
/** Nothing set: the Anthropic API, notes by Haiku. */
export declare const ANTHROPIC_API_ROUTE: SummaryRoute;
/** The cloud a reply's ids name: Bedrock's (`anthropic.`, region-prefixed, an ARN; `msg_bdrk_`), Vertex's (`@date`; `msg_vrtx_`). */
export declare function replyCloud(model: unknown, id: unknown): "bedrock" | "vertex" | undefined;
/**
 * Which form Claude Code 2.1.330 uses for a terminal subagent on a
 * first-party model id, from the settings and environment as they are now
 * (read only). Autopilot's proxy counts from when autopilot was turned on
 * (its config file, written then); before it, the address it replaced.
 */
export declare function summaryRoute(deps?: {
    home?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    sources?: SettingsSource[];
}): SummaryRoute;
/** How Claude Code reads the variable (a boolean: "1", "true", "yes", "on"). */
export declare const disablesSummaries: (v: unknown) => boolean;
/**
 * One subagent transcript's timeline: the first row's host and version, the
 * time of each message, and each reply's prompt size and model (once per
 * reply; its output is in the next prompt).
 */
export declare const PROGRESS_ROWS: Extractor<{
    head: boolean;
    ids: Record<string, 1>;
}>;
/** What a subagent's `.meta.json` says about how it ran (2.1.266+ write requestShape). */
export interface AgentMeta {
    agentType?: string;
    requestShape?: string;
    isFork?: boolean;
}
export declare function readAgentMeta(file: string): AgentMeta | undefined;
/** Why a subagent gets no summaries, or "yes". */
export type Eligibility = "yes" | "foreground" | "host" | "workflow" | "unknown" | "fork-gate-off" | "off" | "old";
/**
 * Whether Claude Code (2.1.321's rules) wrote progress summaries for this
 * agent. `interactive`: whether its host counts as interactive (default: a
 * terminal session, entrypoint "cli").
 */
export declare function eligibility(meta: AgentMeta | undefined, entrypoint: string | undefined, opts?: {
    workflow?: boolean;
    forkGateOff?: boolean;
    interactive?: (entrypoint: string | undefined) => boolean;
}): Eligibility;
/** One subagent's summaries: how many, and their price both ways. */
export interface AgentSummaries {
    calls: number;
    notesUsd: number;
    forkUsd: number;
}
type Rec = {
    t: "h";
    entrypoint?: string;
    version?: string;
} | {
    t: "m";
    ts: number;
} | {
    t: "r";
    ts: number;
    model?: string;
    p: number;
    speed?: string;
    geo?: string;
    cloud?: "bedrock" | "vertex";
};
/** How one agent's summaries were written: its transcript's cloud, else the route at its start. */
export declare function agentRoute(recs: Rec[], route?: SummaryRoute): SummaryRoute;
/** Priced how: "old" (before 2.1.328: notes low, whole context high) or a 2.1.328+ form. */
export type PriceMode = "old" | SummaryForm;
/**
 * The ticks a running agent's timer made and the summaries they sent, from
 * its timeline: every 30 s from its first row to its last, a summary when
 * it has 3+ messages and more than at the last summary. Only ticks in
 * [since, until] are counted.
 */
export declare function simulateAgent(recs: Rec[], since?: number, until?: number, mode?: boolean | PriceMode): AgentSummaries;
export interface ProgressSummaryEstimate {
    /** Subagent transcripts read (workflow agents included). */
    agents: number;
    /** Agents Claude Code wrote summaries for in the window, by the rules above. */
    summarized: number;
    calls: number;
    /** Of `calls`, those by agents on Claude Code 2.1.328+ on the Anthropic API: notes on the small fast model, the same in both figures. */
    smallCalls: number;
    /**
     * The other 2.1.328+ summaries, by form and why (summaryRoute, agentRoute):
     * notes on the agent's own model, its whole context, or a range. Absent
     * or empty when all were on the Anthropic API.
     */
    routes?: Array<{
        form: Exclude<SummaryForm, "haiku">;
        why: string;
        calls: number;
        agents: number;
        lowUsd: number;
        highUsd: number;
    }>;
    /**
     * What turning them off saves, for fix: before 2.1.328 the notes (the low
     * figure, as before), from it the form's figure, a range at its high end
     * (what could not be told is not counted at the cheapest).
     */
    valueUsd?: number;
    /** The summaries as short notes (what Anthropic serves since November 2026): the low figure. */
    notesUsd: number;
    /** As a fork of the whole context (before): the high figure. */
    forkUsd: number;
    /** Agents with none, by why. */
    none: Partial<Record<Exclude<Eligibility, "yes">, number>>;
    /** The hosts of the background agents that got none because their host is not interactive. */
    hosts: string[];
}
export interface ProgressOptions {
    since?: number;
    until?: number;
    /** CLAUDE_CODE_FORK_SUBAGENT is off: interactive sessions' ordinary background agents got none. */
    forkGateOff?: boolean;
    /** From this time, on Claude Code 2.1.318+, the variable was set (fix's record): none after it. */
    offSince?: number;
    /** Which hosts count as interactive (default: entrypoint "cli"); a measurement can ask "what if all were". */
    interactive?: (entrypoint: string | undefined) => boolean;
    /** Only agents on this Claude Code or newer (what the variable would have stopped: 2.1.318+). */
    minVersion?: string;
    /** How 2.1.328+ agents on a first-party model id were served (summaryRoute); default the Anthropic API. */
    route?: SummaryRoute;
}
/** The summaries of the subagents in `files` (their `.jsonl` transcripts), estimated. */
export declare function estimateProgressSummaries(files: string[], opts?: ProgressOptions): ProgressSummaryEstimate;
/** A 2.1.328+ form in words: what each summary sent, and on what. */
export declare function formWords(form: SummaryForm): string;
/** "the Desktop app", "the SDK or -p": a host as a person knows it. */
export declare function hostName(entrypoint: string): string;
export {};
