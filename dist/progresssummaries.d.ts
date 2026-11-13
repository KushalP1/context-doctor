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
import { type Extractor } from "./scan.js";
/** The variable the lever writes, and the value: Claude Code passes only "1" on to the sessions it starts in the background. */
export declare const PROGRESS_SUMMARIES_ENV = "CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES";
export declare const PROGRESS_SUMMARIES_OFF = "1";
/** The first Claude Code that reads it (its CHANGELOG, 2.1.323: "available since 2.1.318"). */
export declare const PROGRESS_SUMMARIES_SINCE = "2.1.318";
/** The summary timer (the binary's default; #86879 and #105981 measured 30-32 s). */
export declare const SUMMARY_TICK_MS = 30000;
/** A short summary's prompt: notes capped at 2,000 - 500 tokens, plus its system prompt and instruction. */
export declare const NOTES_TOKENS = 1850;
/** A fork summary's own instruction, after the agent's context. */
export declare const FORK_PROMPT_TOKENS = 150;
/** Each summary's output: #86879's measured mean (21,966 tokens over 339 summaries). */
export declare const SUMMARY_OUTPUT_TOKENS = 65;
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
};
/**
 * The ticks a running agent's timer made and the summaries they sent, from
 * its timeline: every 30 s from its first row to its last, a summary when
 * it has 3+ messages and more than at the last summary. Only ticks in
 * [since, until] are counted.
 */
export declare function simulateAgent(recs: Rec[], since?: number, until?: number): AgentSummaries;
export interface ProgressSummaryEstimate {
    /** Subagent transcripts read (workflow agents included). */
    agents: number;
    /** Agents Claude Code wrote summaries for in the window, by the rules above. */
    summarized: number;
    calls: number;
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
}
/** The summaries of the subagents in `files` (their `.jsonl` transcripts), estimated. */
export declare function estimateProgressSummaries(files: string[], opts?: ProgressOptions): ProgressSummaryEstimate;
/** "the Desktop app", "the SDK or -p": a host as a person knows it. */
export declare function hostName(entrypoint: string): string;
export {};
